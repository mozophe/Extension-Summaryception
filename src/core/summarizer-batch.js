import { BATCH_PROGRESS } from '../foundation/constants.js';
import { getContext, getChat } from '../foundation/context.js';
import { ensureChatScIds, resolveScIdsToIndices } from '../foundation/message-identity.js';
import {
    bumpSummaryStoreMutationEpoch,
    getChatStore,
    getCurrentSummarizedBoundary,
    getSummaryStoreMutationEpoch,
    saveChatStore,
} from '../foundation/state.js';
import { debug, error, info, isTraceEnabled, serializeError, trace } from '../foundation/logger.js';
import { ghostMessagesInRange, repairGhostingForRange } from './ghosting.js';
import { buildPassageFromRangeWithStats, buildFullContext } from './chatutils.js';
import { persistChatState } from './persist-state.js';
import { callSummarizer } from './summarizer-request.js';
import { buildSnippetMetadataFromState } from './snippet-metadata.js';
import { commitWhenSafe, updateCommittedInjection } from './summarizer-commit.js';
import { executeLayer0StoreTransaction } from './layer0-store-transaction.js';
import { isSummarizerOutputSafe } from './prompts.js';
import { parseSnippet } from './summarizer-state.js';
import { buildMemoryInjection, getCurrentStateSnapshotText } from './memory-injection.js';
import { formatTokenValue } from './token-count.js';
import {
    buildSnapshotBasis,
    fingerprintSourceRange,
    isSnapshotStoreCurrent,
} from './summarizer-snapshot.js';

/**
 * Shared batch summarization logic used by normal and catch-up paths.
 * @param {import('./chatutils.js').AssistantTurn[]} visibleTurns
 * @param {{ catchExceptions?: boolean, sourceEndIdx?: number }} [opts]
 * @param {import('./notify.js').NotifyAdapter} [notify] - Notify adapter threaded from the engine; runs without one stay silent.
 * @returns {Promise<boolean>}
 */
export async function summarizeBatchFromTurns(
    /** @type {import('./chatutils.js').AssistantTurn[]} */ visibleTurns,
    /** @type {{ catchExceptions?: boolean, sourceEndIdx?: number }} */
    { catchExceptions = false, sourceEndIdx } = {},
    /** @type {import('./notify.js').NotifyAdapter | undefined} */ notify,
) {
    trace('>>> ENTERING summarizeBatchFromTurns');
    trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');

    const chat = getChat();
    if (ensureChatScIds(chat)) {
        await persistChatState({ chatSave: 'deferred' });
    }
    const store = getChatStore();
    const summarizedBoundary = getCurrentSummarizedBoundary(chat, store);

    const eligibleTurns = visibleTurns.filter((turn) => turn.index > summarizedBoundary);
    trace('  eligibleTurns after filtering:', eligibleTurns.length);

    if (eligibleTurns.length === 0) {
        await repairGhosting(visibleTurns, summarizedBoundary, notify);
        return false;
    }
    return await summarizeBatchCore({
        chat,
        store,
        eligibleTurns,
        opts: { catchExceptions, sourceEndIdx },
        notify,
    });
}

/**
 * Summarize cache-friendly partitions as one all-or-nothing Layer 0 transaction.
 * @param {import('./partition-planner.js').SourcePartition[]} partitions
 * @param {{ catchExceptions?: boolean }} [opts]
 * @param {import('./notify.js').NotifyAdapter} [notify] - Notify adapter threaded from the engine; runs without one stay silent.
 * @returns {Promise<boolean>}
 */
export async function summarizeAtomicLayer0Partitions(
    partitions,
    { catchExceptions = false } = {},
    /** @type {import('./notify.js').NotifyAdapter | undefined} */ notify,
) {
    return await summarizeSafely(catchExceptions, 'summarizeAtomicLayer0Partitions', () =>
        summarizeAtomicLayer0PartitionsCore(partitions, notify),
    );
}

/**
 * Repair ghosting for turns already marked as summarized.
 * @param {import('./chatutils.js').AssistantTurn[]} visibleTurns
 * @param {number} boundaryIndex
 * @param {import('./notify.js').NotifyAdapter | undefined} notify - Notify adapter threaded to ghosting progress events
 * @returns {Promise<void>}
 */
async function repairGhosting(visibleTurns, boundaryIndex, notify) {
    info('All visible turns are already summarized; repairing ghosting...');
    const turnsToGhost = visibleTurns.filter((t) => t.index <= boundaryIndex);
    if (turnsToGhost.length > 0) {
        const first = turnsToGhost[0].index;
        const last = turnsToGhost[turnsToGhost.length - 1].index;
        await repairGhostingForRange(first, last, { chatSave: 'deferred', notify });
    }
    await persistChatState({ chatSave: 'deferred' });
    trace('<<< EXITING summarizeBatchFromTurns - REPAIRED GHOSTING');
}

/**
 * Core logic for summarizing a batch of turns.
 * @param {object} p
 * @param {ChatMessage[]} p.chat - Chat array
 * @param {SummaryceptionStore} p.store - Chat store
 * @param {import('./chatutils.js').AssistantTurn[]} p.eligibleTurns - Eligible turns
 * @param {{ catchExceptions: boolean, sourceEndIdx?: number }} p.opts - Options
 * @param {import('./notify.js').NotifyAdapter | undefined} p.notify - Notify adapter
 * @returns {Promise<boolean>}
 */
async function summarizeBatchCore({ chat, store, eligibleTurns, opts, notify }) {
    const batch = eligibleTurns;
    if (batch.length === 0) {
        trace('<<< EXITING summarizeBatchFromTurns - EMPTY BATCH');
        return false;
    }

    const { startIdx, endIdx: batchEndIdx } = getBatchRange(batch);
    const endIdx = getSourceEndIdx(batchEndIdx, opts.sourceEndIdx);
    const summarizedBoundary = getCurrentSummarizedBoundary(chat, store);
    trace('  startIdx:', startIdx, 'endIdx:', endIdx);
    trace('  resolved summarized boundary:', summarizedBoundary);

    info(`Summarizing ${batch.length} assistant turns (indices ${startIdx}–${endIdx})`);

    ensureLayer0(store);
    const passageStart = summarizedBoundary < 0 ? 0 : summarizedBoundary + 1;
    if (!isPassageRangeValid(passageStart, endIdx)) {
        return false;
    }

    return await summarizeSafely(opts.catchExceptions, 'summarizeBatchFromTurns', () =>
        performBatchSummary({ batch, chat, store, passageStart, endIdx, notify }),
    );
}
/**
 * Atomic-partition core. One shared progress handle opens at the first
 * validated passage and closes exactly once at the terminal outcome.
 * @param {import('./partition-planner.js').SourcePartition[]} partitions
 * @param {import('./notify.js').NotifyAdapter | undefined} notify - Notify adapter
 * @returns {Promise<boolean>}
 */
async function summarizeAtomicLayer0PartitionsCore(partitions, notify) {
    const usablePartitions = (partitions || []).filter((partition) => partition?.turns?.length > 0);
    if (usablePartitions.length === 0) {
        return false;
    }

    const chat = getChat();
    const store = getChatStore();
    ensureLayer0(store);
    let progress = null;
    let contextText = buildFullContext(0);
    const snapshots = [];
    const pendingSnippets = [];
    const baseMutationEpoch = getSummaryStoreMutationEpoch(store);

    let progressSettled = false;
    // Same settled-flag guard as commitLayer0Job: runLayer0Summarization's
    // internal close and this core's own failure closes both route through
    // here, so the shared handle closes exactly once with the terminal kind.
    const settleProgressClosed = (handle, kind = BATCH_PROGRESS.FAILED) => {
        if (progressSettled) {
            return;
        }
        progressSettled = true;
        closeBatchProgress(notify, handle, kind);
    };

    for (const partition of usablePartitions) {
        if (getSummaryStoreMutationEpoch(store) !== baseMutationEpoch) {
            settleProgressClosed(progress);
            return false;
        }

        const job = await runLayer0Summarization({
            chat,
            store,
            passageStart: partition.sourceStartIdx,
            endIdx: partition.sourceEndIdx,
            contextText,
            metadata: { assistantTurnCount: partition.turns.length },
            notify,
            progress,
            total: usablePartitions.length,
            settle: settleProgressClosed,
        });
        if (!job) {
            settleProgressClosed(progress);
            return false;
        }

        progress = job.progress;
        snapshots.push(job.snapshot);
        pendingSnippets.push(buildLayer0Snippet(job.snapshot, job.summary));
        contextText = buildPendingLayer0Context(store.layers, pendingSnippets);
        notify?.update(progress, { processed: snapshots.length });
    }

    return await commitLayer0Job({
        kind: 'layer0-atomic-cache',
        snapshot: snapshots[0],
        progress,
        notify,
        commit: () => commitAtomicLayer0Snippets({ snapshots, pendingSnippets, notify }),
    });
}

/**
 * Close a batch progress handle with a terminal event kind. No-ops when the
 * adapter or the handle never opened (silent runs, failures before validation).
 * @param {import('./notify.js').NotifyAdapter | undefined} notify - Notify adapter
 * @param {unknown} progress - Progress handle, or null before the first validation
 * @param {string} kind - Terminal event kind from BATCH_PROGRESS
 * @returns {void}
 */
function closeBatchProgress(notify, progress, kind) {
    if (notify && progress) {
        notify.clear(progress, { kind });
    }
}

/**
 * Rethrow unless catchExceptions is set; log and report failure otherwise.
 * @param {boolean} catchExceptions - Swallow exceptions when true
 * @param {string} source - Caller name used in log prefixes
 * @param {() => Promise<boolean>} run - Summarization step to run
 * @returns {Promise<boolean>}
 */
async function summarizeSafely(catchExceptions, source, run) {
    try {
        return await run();
    } catch (err) {
        if (!catchExceptions) {
            throw err;
        }
        trace('  CAUGHT EXCEPTION:', {
            ...serializeError(err),
            stack: err?.stack?.substring?.(0, 200),
        });
        error(`${source} exception:`, err);
        trace(`<<< EXITING ${source} - EXCEPTION`);
        return false;
    }
}

/**
 * Capture, call the summarizer, and validate one Layer 0 job.
 * The progress handle opens only after the passage validates so earlier
 * failures never leak it.
 * @param {object} p
 * @param {ChatMessage[]} p.chat - Chat array
 * @param {SummaryceptionStore} p.store - Chat store
 * @param {number} p.passageStart - First passage index
 * @param {number} p.endIdx - Last passage index
 * @param {string} [p.contextText] - Prebuilt pending context for multi-partition jobs
 * @param {object} [p.metadata] - Extra callSummarizer options for this job
 * @param {import('./notify.js').NotifyAdapter | undefined} p.notify - Notify adapter
 * @param {unknown} p.progress - Shared batch progress handle; null before the first validation
 * @param {number} p.total - Total partitions in the batch
 * @param {((handle: unknown, kind?: string) => void) | undefined} [p.settle] - Terminal close routed to the atomic caller's settled guard so the shared handle closes exactly once
 * @returns {Promise<{snapshot: import('./summarizer-commit.js').SummarizationJobSnapshot, summary: string, progress: unknown} | null>}
 */
async function runLayer0Summarization({
    chat,
    store,
    passageStart,
    endIdx,
    contextText,
    metadata,
    notify,
    progress,
    total,
    settle,
}) {
    const snapshot = await captureLayer0Snapshot({
        chat,
        store,
        passageStart,
        endIdx,
        contextText,
    });
    tracePassageTokens(snapshot);
    if (!snapshot.passageText.trim()) {
        return null;
    }

    if (!progress && notify) {
        progress = notify.progress({ label: BATCH_PROGRESS.MEMORY, total });
    }

    // Route the close through the atomic caller's settled guard when one is
    // installed; direct callers close their own handle here.
    const failClosed = (kind = BATCH_PROGRESS.FAILED) => {
        if (settle) {
            settle(progress, kind);
            return;
        }
        closeBatchProgress(notify, progress, kind);
    };

    let outcome;
    try {
        outcome = await callSummarizer(
            snapshot.passageText,
            snapshot.contextText,
            {
                kind: 'layer0',
                sourceRange: snapshot.sourceRange,
                regexStats: snapshot.passageStats,
                sourceState: snapshot.sourceState,
                ...metadata,
            },
            notify,
        );
    } catch (err) {
        failClosed();
        throw err;
    }
    if (outcome.status === 'aborted') {
        failClosed(BATCH_PROGRESS.ABORTED);
        return null;
    }
    const summary = outcome.status === 'completed' ? outcome.text : '';
    if (!summary || !isLayer0SummarySafe(summary, snapshot)) {
        failClosed();
        return null;
    }
    return { snapshot, summary, progress };
}

/**
 * Commit a validated Layer 0 job as soon as the prompt guard allows, closing
 * the batch progress with the terminal outcome exactly once.
 * @param {object} p
 * @param {string} p.kind - Commit job kind
 * @param {import('./summarizer-commit.js').SummarizationJobSnapshot} p.snapshot - Job snapshot
 * @param {unknown} p.progress - Batch progress handle
 * @param {import('./notify.js').NotifyAdapter | undefined} p.notify - Notify adapter
 * @param {() => Promise<boolean>} p.commit - Commit executed inside commitWhenSafe's apply
 * @returns {Promise<boolean>}
 */
async function commitLayer0Job({ kind, snapshot, progress, notify, commit }) {
    let settled = false;
    const settle = (committed) => {
        if (settled) {
            return;
        }
        settled = true;
        closeBatchProgress(
            notify,
            progress,
            committed ? BATCH_PROGRESS.UPDATED : BATCH_PROGRESS.FAILED,
        );
    };
    let result;
    try {
        result = await commitWhenSafe({
            kind,
            snapshot,
            apply: async () => {
                const committed = await commit();
                settle(committed);
                return committed;
            },
        });
    } catch (err) {
        settle(false);
        throw err;
    }
    return result !== 'stale';
}

/**
 * Build the passage, call the summarizer, and commit the result.
 * @param {object} p - Batch parameters
 * @param {import('./chatutils.js').AssistantTurn[]} p.batch - Eligible turns
 * @param {ChatMessage[]} p.chat - Chat array
 * @param {SummaryceptionStore} p.store - Chat store
 * @param {number} p.passageStart - First passage index
 * @param {number} p.endIdx - Last passage index
 * @param {import('./notify.js').NotifyAdapter | undefined} p.notify - Notify adapter
 * @returns {Promise<boolean>}
 */
async function performBatchSummary({ chat, store, passageStart, endIdx, notify }) {
    const job = await runLayer0Summarization({
        chat,
        store,
        passageStart,
        endIdx,
        notify,
        progress: null,
        total: 1,
    });
    if (!job) {
        return false;
    }
    notify?.update(job.progress, { processed: 1 });

    return await commitLayer0Job({
        kind: 'layer0',
        snapshot: job.snapshot,
        progress: job.progress,
        notify,
        commit: () => commitLayer0Snippet({ snapshot: job.snapshot, summary: job.summary, notify }),
    });
}

/**
 * Trace token stats for the passage sent to the summarizer.
 * @param {import('./summarizer-commit.js').SummarizationJobSnapshot} snapshot - Job snapshot
 * @returns {void}
 */
function tracePassageTokens(snapshot) {
    if (!isTraceEnabled()) {
        return;
    }

    const stats = snapshot.passageStats;
    trace(
        '  storyTxt tokens:',
        formatTokenValue(stats.finalTokens, stats.finalTokensEstimated),
        `after regex (was ${formatTokenValue(
            stats.rawTokens,
            stats.rawTokensEstimated,
        )} raw tokens)`,
    );
}

/**
 * Capture all state required to safely commit a layer-0 summary later.
 * @param {object} p
 * @param {ChatMessage[]} p.chat
 * @param {SummaryceptionStore} p.store
 * @param {number} p.passageStart
 * @param {number} p.endIdx
 * @param {string} [p.contextText]
 * @returns {Promise<import('./summarizer-commit.js').SummarizationJobSnapshot>}
 */
async function captureLayer0Snapshot({ chat, store, passageStart, endIdx, contextText }) {
    const ctx = getContext();
    const sourceMessageIds = chat.slice(passageStart, endIdx + 1).map((message) => message?.sc_id);
    const stableSourceMessageIds = /** @type {string[]} */ (sourceMessageIds);
    if (
        sourceMessageIds.length !== endIdx - passageStart + 1 ||
        sourceMessageIds.some((id) => typeof id !== 'string' || id.trim() === '')
    ) {
        throw new Error('Cannot summarize messages without stable Summaryception IDs.');
    }
    const passage = await buildPassageFromRangeWithStats(chat, passageStart, endIdx);
    const resolvedContextText = contextText ?? buildFullContext(0);

    return {
        ...buildSnapshotBasis({ chatRef: chat, store, ctx }),
        sourceRange: [passageStart, endIdx],
        sourceMessageIds: stableSourceMessageIds,
        sourceFingerprint: fingerprintSourceRange(chat, passageStart, endIdx),
        passageText: passage.text,
        passageStats: passage.stats,
        contextText: resolvedContextText,
        sourceState: getCurrentStateSnapshotText(store.layers),
    };
}

/**
 * Record a successful summary into Layer 0 and trigger downstream bookkeeping.
 * @param {object} p
 * @param {import('./summarizer-commit.js').SummarizationJobSnapshot} p.snapshot
 * @param {string} p.summary - The LLM-generated summary text
 * @param {import('./notify.js').NotifyAdapter} [p.notify] - Notify adapter threaded to ghosting
 * @returns {Promise<boolean>}
 */
async function commitLayer0Snippet({ snapshot, summary, notify }) {
    if (!isLayer0SnapshotValid(snapshot)) {
        return false;
    }

    const store = getChatStore();
    ensureLayer0(store);

    if (!isLayer0SummarySafe(summary, snapshot)) {
        return false;
    }
    await executeLayer0Commit({
        store,
        sourceMessageIds: snapshot.sourceMessageIds,
        notify,
        rollbackMessage: 'Layer 0 commit persistence failed, rolling back store state:',
        onRollback: () => {
            debug('Layer 0 commit rolled back: post-save persistence failed.');
        },
        mutate: () => {
            store.layers[0].push(buildLayer0Snippet(snapshot, summary));
            bumpSummaryStoreMutationEpoch(store);
            trace('  Added Layer 0 snippet for current source IDs.');
        },
    });

    return true;
}

async function commitAtomicLayer0Snippets({ snapshots, pendingSnippets, notify }) {
    if (snapshots.length === 0 || pendingSnippets.length !== snapshots.length) {
        return false;
    }
    if (!snapshots.every(isLayer0SnapshotValid)) {
        return false;
    }

    const store = getChatStore();
    ensureLayer0(store);
    const sourceMessageIds = snapshots.flatMap((snapshot) => snapshot.sourceMessageIds);

    await executeLayer0Commit({
        store,
        sourceMessageIds,
        notify,
        rollbackMessage: 'Layer 0 commit persistence failed, rolling back store state:',
        onRollback: () => {
            debug('Atomic Layer 0 commit rolled back: post-save persistence failed.');
        },
        mutate: () => {
            for (const snippet of pendingSnippets) {
                store.layers[0].push(snippet);
            }
            bumpSummaryStoreMutationEpoch(store);
        },
    });

    return true;
}

async function executeLayer0Commit({
    store,
    sourceMessageIds,
    notify,
    mutate,
    rollbackMessage,
    onRollback,
}) {
    const chat = getChat();
    const chatRollbackPoint = [...chat];
    await executeLayer0StoreTransaction({
        store,
        mutate,
        rollbackMessage,
        onRollback: async () => {
            chat.splice(0, chat.length, ...chatRollbackPoint);
            onRollback?.();
        },
        persist: async () => {
            await saveChatStore();
            await updateCommittedInjection({ logMemoryStatus: true });
            await ghostSourceMessageIds(sourceMessageIds, notify);
            await persistChatState({ chatSave: 'deferred' });
        },
    });
}

async function ghostSourceMessageIds(sourceMessageIds, notify) {
    const indices = resolveScIdsToIndices(getChat(), sourceMessageIds);
    if (indices.length === 0) {
        return;
    }
    await ghostMessagesInRange(indices[0], indices[indices.length - 1], {
        chatSave: 'deferred',
        notify,
    });
}

function buildLayer0Snippet(snapshot, summary) {
    const parsed = parseSnippet(summary);
    return {
        text: summary,
        sourceMessageIds: [...snapshot.sourceMessageIds],
        ...buildSnippetMetadataFromState(parsed.state),
        timestamp: Date.now(),
    };
}

function buildPendingLayer0Context(layers, pendingSnippets) {
    const workingLayers = Array.isArray(layers)
        ? layers.map((layer) => (Array.isArray(layer) ? [...layer] : []))
        : [];
    if (!workingLayers[0]) {
        workingLayers[0] = [];
    }
    workingLayers[0].push(...pendingSnippets);
    return buildMemoryInjection(workingLayers) || '(none yet)';
}

/**
 * Validate a Layer 0 summary before mutating summary storage.
 * @param {string} summary
 * @param {import('./summarizer-commit.js').SummarizationJobSnapshot} snapshot
 * @returns {boolean}
 */
function isLayer0SummarySafe(summary, snapshot) {
    return isSummarizerOutputSafe(summary, {
        kind: 'layer0',
        sourceRange: snapshot.sourceRange,
        regexStats: snapshot.passageStats,
    });
}

/**
 * Revalidate the active chat and store before committing an LLM result.
 * @param {import('./summarizer-commit.js').SummarizationJobSnapshot} snapshot
 * @returns {boolean}
 */
function isLayer0SnapshotValid(snapshot) {
    const ctx = getContext();
    const store = getChatStore();
    const [startIdx, endIdx] = snapshot.sourceRange;

    if (!isSnapshotStoreCurrent(snapshot, ctx, store)) {
        return false;
    }
    return fingerprintSourceRange(ctx.chat, startIdx, endIdx) === snapshot.sourceFingerprint;
}

/**
 * Get the first and last chat indices for a batch.
 * @param {import('./chatutils.js').AssistantTurn[]} batch
 * @returns {{ startIdx: number, endIdx: number }}
 */
function getBatchRange(batch) {
    return {
        startIdx: batch[0].index,
        endIdx: batch[batch.length - 1].index,
    };
}

/**
 * Resolve the source range endpoint for a batch.
 * @param {number} batchEndIdx - Last assistant turn in the batch
 * @param {number | undefined} sourceEndIdx - Optional forced source endpoint
 * @returns {number}
 */
function getSourceEndIdx(batchEndIdx, sourceEndIdx) {
    if (
        typeof sourceEndIdx === 'number' &&
        Number.isInteger(sourceEndIdx) &&
        sourceEndIdx >= batchEndIdx
    ) {
        return sourceEndIdx;
    }
    return batchEndIdx;
}

/**
 * Ensure Layer 0 exists in the chat store.
 * @param {object} store - Chat store
 * @returns {void}
 */
function ensureLayer0(store) {
    if (!store.layers[0]) {
        store.layers[0] = [];
    }
}

/**
 * Validate the passage range before building text.
 * @param {number} passageStart - First passage index
 * @param {number} endIdx - Last passage index
 * @returns {boolean}
 */
function isPassageRangeValid(passageStart, endIdx) {
    if (passageStart <= endIdx) {
        return true;
    }

    error(`passageStart (${passageStart}) > endIdx (${endIdx}). Batch already summarized?`);
    return false;
}
