import { getChat } from '../foundation/context.js';
import { sleep } from '../foundation/retry.js';
import {
    getChatStore,
    getCurrentSummarizedBoundary,
    getEffectiveSettings,
} from '../foundation/state.js';
import { debug, info, trace } from '../foundation/logger.js';
import { summarizeAtomicLayer0Partitions, summarizeBatchFromTurns } from './summarizer-batch.js';
import { drainPromotionOverflow } from './summarizer-promotion.js';
import { flushPendingChatSave } from './persist-state.js';
import { recoverStalePromptFreeze, shouldStopPromptWork } from './summarizer-commit.js';
import { formatTokenValue } from './token-count.js';
import {
    SUMMARY_COMMIT_MODES,
    buildAutoSummaryRoutePlan,
    buildForceSummaryRoutePlan,
    buildSlopSummaryRoutePlan,
} from './summarization-routes.js';
import { prepareSummaryCycle } from './summary-preflight.js';
export const ELASTIC_STRATEGIES = Object.freeze({
    FORCE: 'FORCE',
    SLOP: 'SLOP',
});

/**
 * @typedef {object} ManualRunOutcome
 * @property {boolean} cancelled - Whether the manual run was cancelled.
 * @property {boolean} blocked - Whether the prompt guard blocked completion.
 * @property {number} completed - Number of committed batches.
 * @property {number} failed - Number of failed batches.
 * @property {number} totalBatches - Estimated total batches for the run.
 * @property {boolean} fullyCommitted - Whether all requested work was committed and normalized.
 * @property {boolean} shouldReload - Whether the caller should reload chat/UI state.
 * @property {boolean} failureLimitReached - Whether consecutive failures halted the run.
 */

/**
 * @typedef {object} ManualRunProgress
 * @property {number} completed - Number of committed batches so far.
 * @property {number} failed - Number of failed batches so far.
 * @property {number} totalBatches - Estimated total batches for the run.
 * @property {string} label - Short progress label for the active operation.
 * @property {string} title - User-visible progress title.
 */

/**
 * @typedef {object} ManualRunOptions
 * @property {AbortSignal} [signal] - Abort signal for cancelling the manual run.
 * @property {(progress: ManualRunProgress) => void} [onStart] - Called with initial progress.
 * @property {(progress: ManualRunProgress) => void} [onProgress] - Called after batch progress changes.
 * @property {import('./notify.js').NotifyAdapter} [notify] - Adapter for progress notices; absent runs stay silent.
 */
/**
 * Internal manual loop task built from one strategy's initial route plan.
 * @typedef {object} ManualLoopTask
 * @property {number} totalBatches - Estimated total batches for the run.
 * @property {string} label - Short progress label for the active operation.
 * @property {string} title - User-visible progress title.
 * @property {number} targetIndex - Summarized boundary the run must reach.
 * @property {() => Promise<import('./summarization-routes.js').SummaryRoutePlan>} getBatch - Builds the next route plan to commit.
 * @property {(batch: import('./summarization-routes.js').SummaryRoutePlan) => boolean} isBatchReady - Whether a route plan has work.
 * @property {(batch: import('./summarization-routes.js').SummaryRoutePlan, notify?: import('./notify.js').NotifyAdapter) => Promise<{ success: boolean, committed: boolean, done?: boolean }>} processBatch - Commits one route plan.
 * @property {(outcome: ManualRunOutcome, task: ManualLoopTask) => boolean} isComplete - Whether the run reached its target.
 */

/**
 * @typedef {object} ManualRunnerDeps
 * @property {import('./summarizer-queue.js').SummarizerQueue} queue - Shared summarizer queue.
 * @property {() => void} refreshUi - Refreshes visible extension UI state.
 * @property {function(string, function(): Promise<*>): Promise<*>} withUsageRun - Runs work inside a usage accounting scope.
 */

/**
 * Run one automatic elastic summarization action.
 * @param {import('./summarizer-queue.js').SummarizerQueueContext} queue
 * @param {{ refreshUi?: () => void, notify?: import('./notify.js').NotifyAdapter }} [opts]
 * @returns {Promise<'processed' | 'idle' | 'blocked' | 'failed'>}
 */
export async function runElasticAutoCycle(queue, { refreshUi, notify } = {}) {
    await recoverStalePromptFreeze('auto worker', { refreshUi });

    if (shouldStopPromptWork()) {
        queue.setPhase('paused');
        return 'blocked';
    }

    const s = getEffectiveSettings();
    if (!s.enabled || s.autoPaused) {
        queue.setPhase('paused');
        return 'idle';
    }

    const prepared = await prepareSummaryCycle();
    queue.setPhase('promoting');
    const promotion = await drainPromotionOverflow({ maxConsecutiveFailures: 1, notify });
    if (promotion.status !== 'completed' || promotion.attempts > 0) {
        return promotion.status === 'completed' ? 'processed' : promotion.status;
    }

    const routePlan = await buildAutoSummaryRoutePlan(prepared.chat, prepared.store, s);
    logRoutePlan(routePlan, s);

    if (!routePlan.ready) {
        return 'idle';
    }

    queue.setPhase('layer0');
    return await processRoutePlan(routePlan, notify);
}
/**
 * Yield briefly between automatic work units.
 * @returns {Promise<void>}
 */
export async function yieldWorkerCycle() {
    await sleep(0);
}

/**
 * Run Force Summarize or Slop Breaker through the shared engine.
 * The engine builds its own route plan; callers only pass run options.
 * @param {ManualRunnerDeps} deps
 * @param {'FORCE' | 'SLOP'} strategy
 * @param {ManualRunOptions} [options]
 * @returns {Promise<ManualRunOutcome>}
 */
export async function runManual(deps, strategy, options = {}) {
    const manualStrategy = MANUAL_STRATEGIES[strategy];
    if (!manualStrategy) {
        return createManualRunOutcome();
    }
    return await deps.withUsageRun(manualStrategy.usageLabel, async () => {
        if (!(await prepareManualRun(deps, `manual ${strategy.toLowerCase()}`))) {
            return createManualRunOutcome({ blocked: true });
        }

        const prepared = await prepareSummaryCycle();
        const task = await buildManualTask(manualStrategy, prepared);
        if (!task) {
            return createManualRunOutcome();
        }

        const outcome = await executeManualTask(deps, task, options);
        const promotionStatus = await normalizeManualMemory(outcome, options.notify);
        deps.refreshUi();
        return {
            ...outcome,
            blocked: outcome.blocked || promotionStatus === 'blocked',
            fullyCommitted: isManualRunComplete(outcome, task) && promotionStatus === 'completed',
            shouldReload: isManualRunComplete(outcome, task) && promotionStatus === 'completed',
        };
    });
}

/**
 * Describe the manual work one strategy would run, without preflight or side effects.
 * @param {'FORCE' | 'SLOP'} strategy
 * @returns {Promise<{ ready: boolean, backlog: number }>}
 */
export async function describeManualRun(strategy) {
    const chat = getChat();
    const store = getChatStore();
    const settings = getEffectiveSettings();
    if (strategy !== ELASTIC_STRATEGIES.FORCE && strategy !== ELASTIC_STRATEGIES.SLOP) {
        return { ready: false, backlog: 0 };
    }
    const plan =
        strategy === ELASTIC_STRATEGIES.SLOP
            ? await buildSlopSummaryRoutePlan(chat, store, settings)
            : await buildForceSummaryRoutePlan(chat, store, settings);
    return {
        ready: plan.ready,
        backlog: Math.max(plan.batchTurns.length, plan.overflowCount),
    };
}

async function processRoutePlan(routePlan, notify) {
    const success = await commitRoutePlan(routePlan, { catchExceptions: true }, notify);

    if (!success) {
        debug('Route batch failed, stopping summarization cycle to avoid retry loop.');
        return 'failed';
    }
    if (shouldStopPromptWork()) {
        return 'blocked';
    }
    return 'processed';
}

/**
 * Commit one normalized route plan.
 * @param {import('./summarization-routes.js').SummaryRoutePlan} routePlan
 * @param {{ catchExceptions?: boolean }} [options]
 * @param {import('./notify.js').NotifyAdapter} [notify] - Notify adapter for automatic runs; manual runs own their progress UI and stay silent.
 * @returns {Promise<boolean>}
 */
async function commitRoutePlan(routePlan, options = {}, notify) {
    if (routePlan.commitMode === SUMMARY_COMMIT_MODES.ATOMIC_PARTITIONS) {
        return await summarizeAtomicLayer0Partitions(routePlan.partitions, options, notify);
    }
    if (routePlan.commitMode === SUMMARY_COMMIT_MODES.TURNS_WITH_SOURCE_END) {
        return await summarizeBatchFromTurns(
            routePlan.batchTurns,
            {
                ...options,
                sourceEndIdx: routePlan.sourceEndIdx,
            },
            notify,
        );
    }
    return await summarizeBatchFromTurns(routePlan.batchTurns, options, notify);
}

const isManualTargetReached = (_outcome, task) =>
    getCurrentSummarizedBoundary(getChat(), getChatStore()) >= task.targetIndex;

/**
 * Per-strategy manual run configuration. `assessCommit` turns the summarized
 * boundary movement around one batch commit into the batch result flags.
 * @typedef {object} ManualStrategy
 * @property {string} usageLabel - Usage accounting scope label for the run.
 * @property {string} label - Short progress label for the active operation.
 * @property {string} title - User-visible progress title.
 * @property {(prepared?: { chat: ChatMessage[], store: SummaryceptionStore }, targetIndex?: number) => Promise<import('./summarization-routes.js').SummaryRoutePlan>} buildBatch - Builds the next route plan.
 * @property {(plan: import('./summarization-routes.js').SummaryRoutePlan, beforeIndex: number, afterIndex: number) => { committed: boolean, done?: boolean }} assessCommit - Boundary assessment for one committed batch.
 */

const MANUAL_STRATEGIES = Object.freeze({
    [ELASTIC_STRATEGIES.FORCE]: {
        usageLabel: 'force summarize catch-up',
        label: 'Processing',
        title: 'Summaryception Catch-Up',
        buildBatch: buildForceBatch,
        assessCommit: (_plan, beforeIndex, afterIndex) => ({
            committed: afterIndex > beforeIndex,
        }),
    },
    [ELASTIC_STRATEGIES.SLOP]: {
        usageLabel: 'slop breaker',
        label: 'Breaking slop',
        title: 'Summaryception Slop Breaker',
        buildBatch: buildSlopBatch,
        assessCommit: (plan, _beforeIndex, afterIndex) => ({
            committed: plan.sourceEndIdx !== undefined && afterIndex >= plan.sourceEndIdx,
            done: plan.targetIndex !== undefined && afterIndex >= plan.targetIndex,
        }),
    },
});

/**
 * Build the manual loop task for one strategy from its initial route plan.
 * @param {ManualStrategy} strategy
 * @param {{ chat: ChatMessage[], store: SummaryceptionStore }} prepared
 * @returns {Promise<ManualLoopTask | null>}
 */
async function buildManualTask(strategy, prepared) {
    const initialRoutePlan = await strategy.buildBatch(prepared);
    const targetIndex = initialRoutePlan.targetIndex;
    if (!initialRoutePlan.ready || typeof targetIndex !== 'number') {
        return null;
    }

    return {
        totalBatches: initialRoutePlan.totalBatches,
        label: strategy.label,
        title: strategy.title,
        targetIndex,
        getBatch: () => strategy.buildBatch(undefined, targetIndex),
        isBatchReady: (batch) => batch?.ready,
        processBatch: (batch, notify) => processStrategyBatch(batch, strategy, notify),
        isComplete: isManualTargetReached,
    };
}

/**
 * Build the next Force Summarize route plan.
 * @param {{ chat: ChatMessage[], store: SummaryceptionStore }} [prepared]
 * @returns {Promise<import('./summarization-routes.js').SummaryRoutePlan>}
 */
async function buildForceBatch(prepared) {
    const cycle = prepared || (await prepareSummaryCycle());
    const plan = await buildForceSummaryRoutePlan(cycle.chat, cycle.store, getEffectiveSettings());
    trace(`Current visible turns: ${plan.visibleTurnCount}, plan reason: ${plan.reason}`);
    return plan;
}

/**
 * Build the next Slop Breaker route plan. The first plan resolves its own cut;
 * later batches pin the same fixed target boundary.
 * @param {{ chat: ChatMessage[], store: SummaryceptionStore }} [prepared]
 * @param {number} [targetIndex] Fixed chat index the run should summarize through.
 * @returns {Promise<import('./summarization-routes.js').SummaryRoutePlan>}
 */
async function buildSlopBatch(prepared, targetIndex) {
    const cycle = prepared || (await prepareSummaryCycle());
    return await buildSlopSummaryRoutePlan(
        cycle.chat,
        cycle.store,
        getEffectiveSettings(),
        typeof targetIndex === 'number' ? { targetIndex } : {},
    );
}

/**
 * Drive one manual task batch loop to completion.
 * @param {ManualRunnerDeps} deps
 * @param {ManualLoopTask} task
 * @param {ManualRunOptions} options
 * @returns {Promise<ManualRunOutcome>}
 */
async function executeManualTask(deps, task, options) {
    const outcome = createManualRunOutcome({ totalBatches: task.totalBatches });
    let consecutiveFailures = 0;

    options.onStart?.(createProgress(outcome, task));
    deps.queue.setSummarizing(true);

    try {
        while (!isCancelled(options.signal)) {
            const batch = await task.getBatch();
            if (!task.isBatchReady(batch)) {
                break;
            }

            const result = await task.processBatch(batch, options.notify);
            updateManualOutcome({ outcome, result });
            consecutiveFailures = result.success && result.committed ? 0 : consecutiveFailures;

            if (
                (await normalizeAfterCommittedResult(outcome, result, options.notify)) === 'failed'
            ) {
                break;
            }

            if (shouldStopManualLoop(outcome, result, options.signal, deps.queue)) {
                break;
            }

            consecutiveFailures = updateConsecutiveFailures(outcome, result, consecutiveFailures);
            if (outcome.failureLimitReached) {
                break;
            }

            options.onProgress?.(createProgress(outcome, task));
            await sleep(200);
        }

        if (isCancelled(options.signal)) {
            outcome.cancelled = true;
        }
        return outcome;
    } finally {
        deps.queue.setSummarizing(false);
        await flushPendingChatSave();
    }
}

async function normalizeAfterCommittedResult(outcome, result, notify) {
    if (!result.success || !result.committed || outcome.blocked) {
        return 'skipped';
    }

    const promotion = await normalizePromotions(notify);
    if (promotion.status === 'blocked') {
        outcome.blocked = true;
    } else if (promotion.status === 'failed') {
        outcome.failed++;
    }
    return promotion.status;
}

function updateConsecutiveFailures(outcome, result, consecutiveFailures) {
    if (result.success) {
        return consecutiveFailures;
    }

    const failures = consecutiveFailures + 1;
    outcome.failureLimitReached = failures >= 3;
    return failures;
}

function updateManualOutcome({ outcome, result }) {
    if (result.success && result.committed) {
        outcome.completed++;
        if (shouldStopPromptWork()) {
            outcome.blocked = true;
        }
    } else if (result.success) {
        outcome.blocked = true;
    } else {
        outcome.failed++;
    }
}

function shouldStopManualLoop(outcome, result, signal, queue) {
    if (result.done || outcome.blocked) {
        return true;
    }
    if (isCancelled(signal) || !queue.getIsSummarizing()) {
        outcome.cancelled = true;
        return true;
    }
    return false;
}

/**
 * Commit one route plan through the strategy's boundary assessment.
 * @param {import('./summarization-routes.js').SummaryRoutePlan} plan
 * @param {ManualStrategy} strategy
 * @param {import('./notify.js').NotifyAdapter} [notify]
 * @returns {Promise<{ success: boolean, committed: boolean, done?: boolean }>}
 */
async function processStrategyBatch(plan, strategy, notify) {
    const beforeIndex = getCurrentSummarizedBoundary(getChat(), getChatStore());
    const success = await commitRoutePlan(plan, { catchExceptions: true }, notify);
    const afterIndex = getCurrentSummarizedBoundary(getChat(), getChatStore());
    return { success, ...strategy.assessCommit(plan, beforeIndex, afterIndex) };
}

async function normalizeManualMemory(outcome, notify) {
    if (outcome.cancelled || outcome.blocked || outcome.completed === 0 || outcome.failed > 0) {
        return 'skipped';
    }
    if (shouldStopPromptWork()) {
        info('Manual promotion deferred; prompt mutation guard is active.');
        return 'blocked';
    }
    return (await normalizePromotions(notify)).status;
}

async function normalizePromotions(notify) {
    return await drainPromotionOverflow({ maxConsecutiveFailures: 3, notify });
}

function isManualRunComplete(outcome, task) {
    if (outcome.cancelled || outcome.blocked || outcome.failed > 0 || outcome.completed === 0) {
        return false;
    }
    return task.isComplete(outcome, task);
}

async function prepareManualRun(deps, recoverReason) {
    await recoverStalePromptFreeze(recoverReason, { refreshUi: deps.refreshUi });
    return !shouldStopPromptWork();
}

function createManualRunOutcome(overrides = {}) {
    return {
        cancelled: false,
        blocked: false,
        completed: 0,
        failed: 0,
        totalBatches: 0,
        fullyCommitted: false,
        shouldReload: false,
        failureLimitReached: false,
        ...overrides,
    };
}

function createProgress(outcome, task) {
    return {
        completed: outcome.completed,
        failed: outcome.failed,
        totalBatches: outcome.totalBatches,
        label: task.label,
        title: task.title,
    };
}

function isCancelled(signal) {
    return Boolean(signal?.aborted);
}

function logRoutePlan(routePlan, s) {
    const stats = routePlan.tokenStats;
    debug(
        `Mode: ${s.memoryMode}, recent: ${formatTokenValue(stats.verbatimTokens)}/` +
            `${formatTokenValue(stats.verbatimBudget)}, queued: ${formatTokenValue(stats.queuedTokens)}/` +
            `${formatTokenValue(stats.queuedBudget)}, partitions: ${stats.partitionCount}`,
    );
}
