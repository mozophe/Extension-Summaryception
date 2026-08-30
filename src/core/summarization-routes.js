import { MEMORY_MODES } from '../foundation/constants.js';
import { buildChatWindowPlan } from './chat-window-planner.js';
import { getSlopBreakerPlan } from './slop-breaker.js';

export const SUMMARY_ROUTES = Object.freeze({
    STANDARD_AUTO: 'standard-auto',
    CACHE_AUTO: 'cache-auto',
    FORCE: 'force',
    SLOP: 'slop',
});

export const SUMMARY_COMMIT_MODES = Object.freeze({
    TURNS: 'turns',
    TURNS_WITH_SOURCE_END: 'turns-with-source-end',
    ATOMIC_PARTITIONS: 'atomic-partitions',
});

const LAYER0_PHASE = /** @type {'layer0'} */ ('layer0');

/**
 * @typedef {object} SummaryRoutePlan
 * @property {string} route Selected route identifier from `SUMMARY_ROUTES`.
 * @property {boolean} ready True when the route can run a summarization batch now.
 * @property {string} reason Underlying chat window plan reason.
 * @property {string} commitMode Store commit strategy from `SUMMARY_COMMIT_MODES`.
 * @property {'layer0'} phase Pipeline phase marker for the route.
 * @property {import('./chatutils.js').AssistantTurn[]} batchTurns Turns selected for the current batch.
 * @property {import('./partition-planner.js').SourcePartition[]} partitions Source partitions to commit.
 * @property {number} overflowCount Eligible turns awaiting summarization.
 * @property {number} totalBatches Batches the route runs, 0 when not ready.
 * @property {number} [sourceEndIdx] Optional exclusive end of the source window.
 * @property {number} [targetIndex] Optional store target index for commits.
 * @property {object} rawPlan Underlying raw plan backing this route.
 */

/**
 * Build the automatic route plan selected by the active memory mode.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {ExtensionSettings} settings
 * @returns {Promise<SummaryRoutePlan>}
 */
export async function buildAutoSummaryRoutePlan(chat, store, settings) {
    const plan = await buildChatWindowPlan(chat, store, settings);
    const atomic = settings.memoryMode === MEMORY_MODES.PREFIX_CACHE;
    if (atomic) {
        return {
            route: SUMMARY_ROUTES.CACHE_AUTO,
            ready: plan.reason === 'ready',
            reason: plan.reason,
            commitMode: SUMMARY_COMMIT_MODES.ATOMIC_PARTITIONS,
            phase: LAYER0_PHASE,
            batchTurns: plan.batchTurns,
            partitions: plan.partitions,
            overflowCount: plan.overflowCount,
            totalBatches: plan.reason === 'ready' ? plan.partitions.length : 0,
            rawPlan: plan,
        };
    }
    return buildTurnRoute({
        route: SUMMARY_ROUTES.STANDARD_AUTO,
        ready: plan.reason !== 'none',
        plan,
        batchTurns: selectLayer0BatchTurns(plan),
        totalBatches: 1,
    });
}

/**
 * Build the Force Summarize route plan.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {ExtensionSettings} settings
 * @returns {Promise<SummaryRoutePlan>}
 */
export async function buildForceSummaryRoutePlan(chat, store, settings) {
    const plan = await buildChatWindowPlan(chat, store, settings, { ignoreReadiness: true });
    return buildTurnRoute({
        route: SUMMARY_ROUTES.FORCE,
        ready: plan.reason !== 'none',
        plan,
        batchTurns: selectLayer0BatchTurns(plan),
        totalBatches: plan.partitions.length,
    });
}

/**
 * Build the Slop Breaker route plan.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {ExtensionSettings} settings
 * @param {{ targetIndex?: number }} [opts]
 * @returns {Promise<SummaryRoutePlan>}
 */
export async function buildSlopSummaryRoutePlan(chat, store, settings, opts = {}) {
    const plan = await getSlopBreakerPlan(chat, store, settings, opts);
    return {
        route: SUMMARY_ROUTES.SLOP,
        ready: plan.reason === 'ready',
        reason: plan.reason,
        commitMode: SUMMARY_COMMIT_MODES.TURNS_WITH_SOURCE_END,
        phase: LAYER0_PHASE,
        batchTurns: plan.batchTurns,
        partitions: plan.partitions,
        overflowCount: plan.eligibleTurns.length,
        totalBatches: plan.totalBatches,
        sourceEndIdx: plan.sourceEndIdx,
        targetIndex: plan.targetIndex,
        rawPlan: plan,
    };
}

function buildTurnRoute({ route, ready, plan, batchTurns, totalBatches }) {
    return {
        route,
        ready,
        reason: plan.reason,
        commitMode: SUMMARY_COMMIT_MODES.TURNS,
        phase: LAYER0_PHASE,
        batchTurns,
        partitions: plan.partitions,
        overflowCount: plan.overflowCount,
        totalBatches: ready ? Math.max(1, totalBatches) : 0,
        rawPlan: plan,
    };
}

function selectLayer0BatchTurns(plan) {
    return plan.reason === 'repair' ? plan.visibleTurns : plan.batchTurns;
}
