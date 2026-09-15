/** @typedef {'idle' | 'layer0' | 'promoting' | 'yielding' | 'paused'} SummarizerQueuePhase */
import { sleep } from '../foundation/retry.js';
import { refreshUi } from '../foundation/refresh.js';
import { silentAdapter } from './notify.js';
import { flushPendingChatSave } from './persist-state.js';
import { runElasticAutoCycle } from './summarizer-engine.js';
import { abortCurrentSummarizerRequest } from './summarizer-request.js';
import { withUsageRun } from './summarizer-usage.js';

/**
 * @typedef {object} SummarizerQueueContext
 * @property {(phase: SummarizerQueuePhase) => void} setPhase - Update the visible queue phase.
 * @property {() => SummarizerQueuePhase} getPhase - Read the current queue phase.
 */

/**
 * @typedef {object} SummarizerQueueDependencies
 * @property {(ctx: SummarizerQueueContext) => Promise<import('./run-outcome.js').SummarizationRunOutcome>} drainOneCycle - Runs one automatic queue cycle.
 * @property {() => void} abort - Aborts the current summarizer request.
 * @property {() => void} refreshUi - Refreshes visible extension UI state.
 * @property {function(string, function(): Promise<*>): Promise<*>} withUsageRun - Runs work inside a usage accounting scope.
 * @property {{ log?: (...args: unknown[]) => void } | ((...args: unknown[]) => void)} [logger] - Optional queue logger.
 * @property {() => Promise<void>} [yieldCycle] - Yields between processed work units.
 * @property {() => Promise<void>} [afterDrain] - Runs after the worker drain completes.
 */

/**
 * Coalesces automatic summarization requests into one self-draining worker.
 */
export class SummarizerQueue {
    /**
     * @param {SummarizerQueueDependencies} deps
     */
    constructor({ drainOneCycle, abort, refreshUi, withUsageRun, logger, yieldCycle, afterDrain }) {
        this.drainOneCycle = drainOneCycle;
        this.abortRequest = abort;
        this.refreshUi = refreshUi;
        this.withUsageRun = withUsageRun;
        this.yieldCycle = yieldCycle || defaultYieldCycle;
        this.afterDrain = afterDrain || defaultAfterDrain;
        this.log = typeof logger === 'function' ? logger : logger?.log;

        this.running = false;
        this.pending = false;
        this.dirty = false;
        this.workerPromise = null;
        this.manualSummarizing = false;
        /** @type {SummarizerQueuePhase} */
        this.phase = 'idle';

        /** @type {SummarizerQueueContext} */
        this.context = {
            setPhase: (phase) => this.#setPhase(phase),
            getPhase: () => this.phase,
        };
    }

    /**
     * Queue or coalesce an automatic summarization request.
     * @returns {Promise<void>}
     */
    request() {
        this.pending = true;

        if (this.running) {
            this.dirty = true;
            return this.workerPromise || Promise.resolve();
        }

        this.workerPromise = this.#drainSummarizationWorker().finally(() => {
            this.workerPromise = null;
        });
        return this.workerPromise;
    }

    /**
     * Abort in-flight summarization and clear queued work.
     * @returns {void}
     */
    abort() {
        this.abortRequest();
        this.pending = false;
        this.dirty = false;
        this.manualSummarizing = false;
        if (!this.running) {
            this.#setPhase('idle');
        }
    }

    /**
     * Check whether the queue or a manual task is active.
     * @returns {boolean}
     */
    getIsSummarizing() {
        return this.running || this.manualSummarizing;
    }

    /**
     * Set the manual summarization busy state.
     * @param {boolean} value
     * @returns {void}
     */
    setSummarizing(value) {
        this.manualSummarizing = Boolean(value);
    }

    /**
     * Read the current worker phase.
     * @returns {SummarizerQueuePhase}
     */
    getPhase() {
        return this.phase;
    }

    /**
     * Drain coalesced work until stable, guarded, or failed.
     * @returns {Promise<void>}
     */
    async #drainSummarizationWorker() {
        await this.withUsageRun('auto worker drain', async () => {
            this.running = true;
            this.refreshUi();

            try {
                await this.#drainRequestedWork();
            } finally {
                try {
                    await this.afterDrain();
                } finally {
                    this.running = false;
                    this.#setPhase('idle', { force: true });
                }
            }
        });
    }

    /**
     * Run requested work, preserving dirty reruns except after failures.
     * @returns {Promise<void>}
     */
    async #drainRequestedWork() {
        let failed = false;

        do {
            this.pending = false;
            this.dirty = false;
            const result = await this.#drainReadyWork();
            failed = result.status === 'failed';

            if (failed) {
                this.log?.('Summarization cycle failed; waiting for the next trigger.');
                this.pending = false;
                this.dirty = false;
            }
        } while (!failed && (this.pending || this.dirty));
    }

    /**
     * Drain ready automatic work until no immediate work remains.
     * @returns {Promise<import('./run-outcome.js').SummarizationRunOutcome>}
     */
    async #drainReadyWork() {
        while (true) {
            const result = await this.drainOneCycle(this.context);
            if (result.status === 'blocked') {
                this.#setPhase('paused');
            }
            if (result.status !== 'completed') {
                return result;
            }

            this.#setPhase('yielding');
            await this.yieldCycle();
        }
    }

    /**
     * Update phase and refresh observers when it changes.
     * @param {SummarizerQueuePhase} phase
     * @param {{ force?: boolean }} [opts]
     * @returns {void}
     */
    #setPhase(phase, { force = false } = {}) {
        if (!isQueuePhase(phase)) {
            throw new Error(`Invalid summarizer queue phase: ${phase}`);
        }
        if (!force && this.phase === phase) {
            return;
        }

        this.phase = phase;
        this.refreshUi();
    }
}

/**
 * Yield to the browser event loop between background work units.
 * @returns {Promise<void>}
 */
async function defaultYieldCycle() {
    await sleep(0);
}

async function defaultAfterDrain() {}

/**
 * Check whether a value is a supported queue phase.
 * @param {unknown} phase
 * @returns {phase is SummarizerQueuePhase}
 */
function isQueuePhase(phase) {
    return (
        phase === 'idle' ||
        phase === 'layer0' ||
        phase === 'promoting' ||
        phase === 'yielding' ||
        phase === 'paused'
    );
}

/** @type {import('./notify.js').NotifyAdapter} */
let notifyAdapter = silentAdapter;

/**
 * The one summarizer queue instance, built from static core imports.
 * @type {SummarizerQueue}
 */
export const summarizerQueue = new SummarizerQueue({
    drainOneCycle: (queue) => runElasticAutoCycle(queue, { refreshUi, notify: notifyAdapter }),
    abort: abortCurrentSummarizerRequest,
    refreshUi,
    withUsageRun,
    yieldCycle: async () => {
        await sleep(0);
    },
    afterDrain: flushPendingChatSave,
});

/**
 * Queue or coalesce an automatic summarization request.
 * @returns {Promise<void>}
 */
export function requestSummarization() {
    return summarizerQueue.request();
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
 * Register the notify adapter used by automatic summarization cycles.
 * @param {import('./notify.js').NotifyAdapter | null | undefined} adapter - Toastr-backed adapter from entry, or a falsy value to reset to silent.
 * @returns {void}
 */
export function setNotify(adapter) {
    notifyAdapter = adapter || silentAdapter;
}
