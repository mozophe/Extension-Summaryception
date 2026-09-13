import { afterEach, describe, expect, it, vi } from 'vitest';

const callSummarizer = vi.hoisted(() => vi.fn());
vi.mock('../src/core/summarizer-request.js', () => ({ callSummarizer }));

import { drainPromotionOverflow } from '../src/core/summarizer-promotion.js';
import { NOTIFY_EVENTS } from '../src/foundation/constants.js';
import {
    installBrowserRuntimeStub,
    installSummaryContext,
    makeNotifyRecorder,
    makeSummarySettings,
    makeSummaryStore,
} from './test-helpers.js';

/**
 * The promotion cycle emits a structured notify event (ADR-0004) instead of
 * calling the notification library; the entry adapter renders the notice.
 */
describe('summarizer promotion notify events', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        callSummarizer.mockReset();
        delete globalThis.toastr;
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

    it('emits one structured promotion-started event and never calls toastr', async () => {
        const { toastr } = installBrowserRuntimeStub();
        const recorder = makeNotifyRecorder();
        installOverflowingStore();
        callSummarizer.mockResolvedValue({ status: 'failed' });

        await expect(
            drainPromotionOverflow({ maxConsecutiveFailures: 1, notify: recorder }),
        ).resolves.toEqual({
            status: 'failed',
            attempts: 1,
        });

        expect(toastr.info).not.toHaveBeenCalled();
        expect(recorder.events).toEqual([
            {
                type: 'transient',
                kind: NOTIFY_EVENTS.PROMOTION_STARTED,
                mergedCount: 3,
                fromLayer: 0,
                toLayer: 1,
            },
        ]);
    });

    it('stays silent without an adapter', async () => {
        installOverflowingStore();
        callSummarizer.mockResolvedValue({ status: 'failed' });

        await expect(drainPromotionOverflow({ maxConsecutiveFailures: 1 })).resolves.toEqual({
            status: 'failed',
            attempts: 1,
        });

        expect(callSummarizer).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr).toBeUndefined();
    });
});
