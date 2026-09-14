import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeMocks = vi.hoisted(() => ({
    buildForceSummaryRoutePlan: vi.fn(),
    buildSlopSummaryRoutePlan: vi.fn(),
}));
const batchMocks = vi.hoisted(() => ({
    summarizeBatchFromTurns: vi.fn(),
    summarizeAtomicLayer0Partitions: vi.fn(),
}));
const stateMocks = vi.hoisted(() => ({
    getChatStore: vi.fn(() => ({})),
    getCurrentSummarizedBoundary: vi.fn(),
    getEffectiveSettings: vi.fn(() => ({})),
}));

vi.mock('../src/core/summarization-routes.js', async (importOriginal) => ({
    ...(await importOriginal()),
    ...routeMocks,
}));
vi.mock('../src/core/summarizer-batch.js', () => batchMocks);
vi.mock('../src/foundation/state.js', () => stateMocks);
vi.mock('../src/core/summarizer-promotion.js', () => ({
    drainPromotionOverflow: vi.fn(async () => ({ status: 'completed', attempts: 0 })),
}));
vi.mock('../src/core/persist-state.js', () => ({
    flushPendingChatSave: vi.fn(async () => {}),
    persistChatState: vi.fn(async () => {}),
}));
vi.mock('../src/core/summary-preflight.js', () => ({
    prepareSummaryCycle: vi.fn(async () => ({ chat: [], store: {} })),
}));

import { resetCommitStateForTests } from '../src/core/summarizer-commit.js';
import { ELASTIC_STRATEGIES, runManual } from '../src/core/summarizer-engine.js';
import { installSummaryContext } from './test-helpers.js';

const TARGET_INDEX = 5;
let boundary = 0;

/** Build manual runner deps with a stub queue. */
function makeDeps() {
    return {
        queue: {
            setPhase: vi.fn(),
            setSummarizing: vi.fn(),
            getIsSummarizing: vi.fn(() => true),
        },
        refreshUi: vi.fn(),
        withUsageRun: vi.fn(async (_label, work) => await work()),
    };
}

/** Build a ready single-batch force route plan. */
function forceRoutePlan() {
    return {
        ready: true,
        reason: 'ready',
        commitMode: 'TURNS',
        batchTurns: [{ index: 2 }],
        partitions: [{}],
        totalBatches: 1,
        targetIndex: TARGET_INDEX,
    };
}

describe('manual run progress callbacks', () => {
    /** Build a ready route plan; unready once the boundary reaches the target. */
    function stubRoutePlan(mock, plan) {
        mock.mockImplementation(async () => ({
            ...plan,
            ready: boundary < TARGET_INDEX,
            reason: boundary < TARGET_INDEX ? 'ready' : 'none',
        }));
    }

    beforeEach(() => {
        vi.clearAllMocks();
        resetCommitStateForTests();
        installSummaryContext({ chat: [] });
        boundary = 0;
        stateMocks.getChatStore.mockReturnValue({});
        stateMocks.getEffectiveSettings.mockReturnValue({});
        stateMocks.getCurrentSummarizedBoundary.mockImplementation(() => boundary);
        // Committing one batch advances the summarized boundary to the target.
        batchMocks.summarizeBatchFromTurns.mockImplementation(async () => {
            boundary = TARGET_INDEX;
            return { status: 'completed' };
        });
    });

    it('reports start and progress for force summarize', async () => {
        stubRoutePlan(routeMocks.buildForceSummaryRoutePlan, forceRoutePlan());
        const onStart = vi.fn();
        const onProgress = vi.fn();

        const outcome = await runManual(makeDeps(), ELASTIC_STRATEGIES.FORCE, {
            onStart,
            onProgress,
        });

        expect(onStart).toHaveBeenCalledWith({
            completed: 0,
            failed: 0,
            totalBatches: 1,
            label: 'Processing',
            title: 'Summaryception Catch-Up',
        });
        expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ completed: 1 }));
        expect(outcome.fullyCommitted).toBe(true);
    });

    it('reports start and progress for slop breaker', async () => {
        stubRoutePlan(routeMocks.buildSlopSummaryRoutePlan, {
            ready: true,
            reason: 'ready',
            commitMode: 'TURNS_WITH_SOURCE_END',
            batchTurns: [{ index: 2 }],
            partitions: [{}],
            totalBatches: 1,
            sourceEndIdx: TARGET_INDEX,
            targetIndex: TARGET_INDEX,
        });
        const onStart = vi.fn();

        const outcome = await runManual(makeDeps(), ELASTIC_STRATEGIES.SLOP, { onStart });

        expect(onStart).toHaveBeenCalledWith({
            completed: 0,
            failed: 0,
            totalBatches: 1,
            label: 'Breaking slop',
            title: 'Summaryception Slop Breaker',
        });
        expect(outcome.fullyCommitted).toBe(true);
    });

    it('cancels before any batch when the signal is already aborted', async () => {
        routeMocks.buildForceSummaryRoutePlan.mockResolvedValue(forceRoutePlan());
        const controller = new AbortController();
        controller.abort();

        const outcome = await runManual(makeDeps(), ELASTIC_STRATEGIES.FORCE, {
            signal: controller.signal,
        });

        expect(outcome.cancelled).toBe(true);
        expect(batchMocks.summarizeBatchFromTurns).not.toHaveBeenCalled();
    });
});

describe('manual run failure limit', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetCommitStateForTests();
        installSummaryContext({ chat: [] });
        stateMocks.getChatStore.mockReturnValue({});
        stateMocks.getEffectiveSettings.mockReturnValue({});
        stateMocks.getCurrentSummarizedBoundary.mockReturnValue(0);
        // Every batch commit fails without moving the summarized boundary.
        batchMocks.summarizeBatchFromTurns.mockResolvedValue({ status: 'failed' });
        routeMocks.buildForceSummaryRoutePlan.mockResolvedValue(forceRoutePlan());
    });

    it('stops the run after three consecutive batch failures', async () => {
        const outcome = await runManual(makeDeps(), ELASTIC_STRATEGIES.FORCE, {});

        expect(outcome.failureLimitReached).toBe(true);
        expect(outcome.failed).toBe(3);
        expect(outcome.completed).toBe(0);
        expect(outcome.fullyCommitted).toBe(false);
        expect(batchMocks.summarizeBatchFromTurns).toHaveBeenCalledTimes(3);
    });
});
