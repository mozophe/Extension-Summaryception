import { silentAdapter } from './notify.js';
import {
    abortCurrentSummarizerRequest,
    callSummarizer,
    hasActiveAbortController,
} from './summarizer-request.js';
import { SummarizerQueue } from './summarizer-queue.js';
import { withUsageRun } from './summarizer-usage.js';
import { flushPendingChatSave } from './persist-state.js';
import {
    pauseAutoSummarization as runEnginePause,
    resumeAutoSummarization as runEngineResume,
    runElasticAutoCycle,
    runManual as runEngineManual,
} from './summarizer-engine.js';
import { refreshUi } from '../foundation/refresh.js';
import { sleep } from '../foundation/retry.js';
import {
    beginForegroundGeneration as beginCommitFreeze,
    endForegroundGeneration as endCommitFreeze,
    isPromptMutationFrozen,
    setCommitCallbacks,
} from './summarizer-commit.js';

export { callSummarizer, hasActiveAbortController };
export { recoverStalePromptFreeze, resetPromptMutationGuard } from './summarizer-commit.js';

/** @typedef {import('./summarizer-engine.js').ManualRunOptions} ManualRunOptions */
/** @typedef {import('./summarizer-engine.js').ManualRunOutcome} ManualRunOutcome */
/** @typedef {import('./summarizer-engine.js').PauseLatchDeps} PauseLatchDeps */

/** @type {import('./notify.js').NotifyAdapter} */
let notifyAdapter = silentAdapter;

const summarizerQueue = new SummarizerQueue({
    drainOneCycle: (queue) => runElasticAutoCycle(queue, { refreshUi, notify: notifyAdapter }),
    abort: abortCurrentSummarizerRequest,
    refreshUi,
    withUsageRun,
    yieldCycle: async () => {
        await sleep(0);
    },
    afterDrain: flushPendingChatSave,
});

setCommitCallbacks({
    requeue: () => {
        void requestSummarization();
    },
});

/**
 * Check whether Summaryception is currently deferring prompt mutations.
 * @returns {boolean}
 */
export function hasFrozenPromptMutations() {
    return isPromptMutationFrozen();
}

/**
 * Register the notify adapter used by automatic summarization cycles.
 * @param {import('./notify.js').NotifyAdapter | null | undefined} adapter - Toastr-backed adapter from entry, or a falsy value to reset to silent.
 * @returns {void}
 */
export function setNotify(adapter) {
    notifyAdapter = adapter || silentAdapter;
}

/**
 * Check whether a summarization cycle is currently running.
 * @returns {boolean}
 */
export function getIsSummarizing() {
    return summarizerQueue.getIsSummarizing();
}

/**
 * Set the manual summarizing flag.
 * @param {boolean} value
 * @returns {void}
 */
export function setSummarizing(value) {
    summarizerQueue.setSummarizing(value);
}

/**
 * Abort the in-flight summarization request.
 * @returns {void}
 */
export function abortSummarization() {
    summarizerQueue.abort();
}

/**
 * Register injection callbacks used by safe summary commits.
 * @param {() => void} updateInjection
 * @param {() => void} reassertInjection
 * @returns {void}
 */
export function setInjectionUpdater(updateInjection, reassertInjection) {
    setCommitCallbacks({
        updateInjection,
        reassertInjection,
        requeue: () => {
            void requestSummarization();
        },
    });
}

/**
 * Freeze summary commits while SillyTavern assembles a foreground prompt.
 * @returns {void}
 */
export function beginForegroundGeneration() {
    beginCommitFreeze();
    refreshUi();
}

/**
 * Flush deferred commits and resume work after foreground generation ends.
 * @returns {Promise<void>}
 */
export async function endForegroundGeneration() {
    try {
        await endCommitFreeze();
        await flushPendingChatSave();
        await requestSummarization();
    } finally {
        refreshUi();
    }
}

/**
 * Queue or coalesce an automatic summarization request.
 * @returns {Promise<void>}
 */
export function requestSummarization() {
    return summarizerQueue.request();
}

export { describeManualRun, ELASTIC_STRATEGIES } from './summarizer-engine.js';

/**
 * Run Force Summarize or Slop Breaker through the shared engine.
 * @param {'FORCE' | 'SLOP'} strategy
 * @param {ManualRunOptions} [options]
 * @returns {Promise<ManualRunOutcome>}
 */
export async function runManual(strategy, options = {}) {
    return await runEngineManual(getManualRunnerDeps(), strategy, options);
}

/**
 * Build dependencies for manual runner calls.
 * @returns {import('./summarizer-engine.js').ManualRunnerDeps}
 */
function getManualRunnerDeps() {
    return {
        queue: summarizerQueue,
        refreshUi,
        withUsageRun,
    };
}

/**
 * Stop path for the pause latch: abort any live run, persist `autoPaused`, and let the queue settle.
 * @returns {Promise<'paused' | 'already-paused' | 'idle'>}
 */
export function pauseAutoSummarization() {
    return runEnginePause(getPauseLatchDeps());
}

/**
 * Resume path for the pause latch: clear `autoPaused` and kick one automatic cycle.
 * @returns {Promise<'resumed' | 'not-paused'>}
 */
export function resumeAutoSummarization() {
    return runEngineResume(getPauseLatchDeps());
}

/**
 * Build dependencies for pause latch control calls.
 * @returns {PauseLatchDeps}
 */
function getPauseLatchDeps() {
    return {
        queue: summarizerQueue,
        hasActiveAbortController,
    };
}
