import { afterEach, describe, expect, it, vi } from 'vitest';

const callSummarizer = vi.hoisted(() => vi.fn());
vi.mock('../src/core/summarizer-request.js', () => ({ callSummarizer }));

import {
    beginForegroundGeneration,
    resetCommitStateForTests,
} from '../src/core/summarizer-commit.js';
import { drainPromotionOverflow } from '../src/core/summarizer-promotion.js';
import { installSummaryContext, makeSummarySettings, makeSummaryStore } from './test-helpers.js';

/**
 * drainPromotionOverflow is the single owner of overflow clearing: one loop,
 * one failure budget, one Foreground Gate. Tests drive the real module through its
 * interface with a mocked summarizer request.
 */
describe('drainPromotionOverflow', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        callSummarizer.mockReset();
        resetCommitStateForTests();
    });

    /**
     * Install a context whose Layer 0 exceeds its token quota (24 ~150-char
     * snippets vs. a 2400-token quota under the length-based test tokenizer).
     */
    function installOverflowingStore() {
        const snippets = Array.from({ length: 24 }, (_, i) => ({
            text: `[NARRATIVE]\nScene ${i}: ${'memory detail '.repeat(10)}\n[STATE]\nlocation: room${i}`,
            sourceMessageIds: [`msg-${i}`],
        }));
        installSummaryContext({
            metadata: { summaryception: makeSummaryStore({ layers: [snippets] }) },
            settings: makeSummarySettings({ memoryTokenBudget: 4000 }),
        });
    }

    function installSettledStore() {
        installSummaryContext({
            metadata: { summaryception: makeSummaryStore() },
            settings: makeSummarySettings({ memoryTokenBudget: 4000 }),
        });
    }

    it('returns completed with zero attempts when no layer overflows', async () => {
        installSettledStore();

        await expect(drainPromotionOverflow({ maxConsecutiveFailures: 1 })).resolves.toEqual({
            status: 'completed',
            attempts: 0,
        });

        expect(callSummarizer).not.toHaveBeenCalled();
    });

    it('stops after one consecutive failed promotion at the auto budget', async () => {
        installOverflowingStore();
        callSummarizer.mockResolvedValue({ status: 'failed' });

        await expect(drainPromotionOverflow({ maxConsecutiveFailures: 1 })).resolves.toEqual({
            status: 'failed',
            attempts: 1,
        });

        expect(callSummarizer).toHaveBeenCalledTimes(1);
    });

    it('tolerates three consecutive failures at the manual budget', async () => {
        installOverflowingStore();
        callSummarizer.mockResolvedValue({ status: 'failed' });

        await expect(drainPromotionOverflow({ maxConsecutiveFailures: 3 })).resolves.toEqual({
            status: 'failed',
            attempts: 3,
        });

        expect(callSummarizer).toHaveBeenCalledTimes(3);
    });

    it('reports blocked before the first attempt when the stop guard trips', async () => {
        installOverflowingStore();
        beginForegroundGeneration();

        await expect(drainPromotionOverflow({ maxConsecutiveFailures: 1 })).resolves.toEqual({
            status: 'blocked',
            attempts: 0,
        });

        expect(callSummarizer).not.toHaveBeenCalled();
    });

    it('reports blocked after an attempt when the stop guard trips mid-drain', async () => {
        installOverflowingStore();
        callSummarizer.mockImplementation(async () => {
            beginForegroundGeneration();
            return { status: 'failed' };
        });

        await expect(drainPromotionOverflow({ maxConsecutiveFailures: 3 })).resolves.toEqual({
            status: 'blocked',
            attempts: 1,
        });

        expect(callSummarizer).toHaveBeenCalledTimes(1);
    });
});
