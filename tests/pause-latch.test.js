import { afterEach, describe, expect, it, vi } from 'vitest';

const { installSummaryContext } = await import('./test-helpers.js');
const { getSettings } = await import('../src/foundation/state.js');
const { pauseAutoSummarization, resumeAutoSummarization } =
    await import('../src/core/summarizer-engine.js');

/** Stub queue exposing only the surface the pause latch seam touches. */
function makeQueue({ running = false, request = async () => {} } = {}) {
    return {
        getIsSummarizing: vi.fn(() => running),
        abort: vi.fn(),
        request: vi.fn(request),
    };
}

/**
 * Bootstrap a Summaryception context and build stub pause-latch deps.
 * One getSettings() settles one-time settings normalization so later
 * saveSettingsDebounced calls can only come from the code under test.
 */
function makeDeps({ running = false, latch = false, liveRequest = false, request } = {}) {
    const saveSettings = vi.fn();
    installSummaryContext({ settings: { autoPaused: latch }, saveSettingsDebounced: saveSettings });
    getSettings();
    saveSettings.mockClear();
    const queue = makeQueue({ running, request });
    const hasActiveAbortController = vi.fn(() => liveRequest);
    return {
        deps: { queue, hasActiveAbortController },
        queue,
        hasActiveAbortController,
        saveSettings,
    };
}

describe('pauseAutoSummarization', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("returns 'idle' and does nothing when nothing runs and the latch is clear", async () => {
        const { deps, queue, saveSettings } = makeDeps();

        await expect(pauseAutoSummarization(deps)).resolves.toBe('idle');

        expect(queue.abort).not.toHaveBeenCalled();
        expect(saveSettings).not.toHaveBeenCalled();
        expect(getSettings().autoPaused).toBe(false);
    });

    it("returns 'already-paused' without side effects when nothing runs and the latch is set", async () => {
        const { deps, queue, saveSettings } = makeDeps({ latch: true });

        await expect(pauseAutoSummarization(deps)).resolves.toBe('already-paused');

        expect(queue.abort).not.toHaveBeenCalled();
        expect(saveSettings).not.toHaveBeenCalled();
        expect(getSettings().autoPaused).toBe(true);
    });

    it("returns 'paused', aborts once, latches, and saves when the queue is summarizing", async () => {
        const { deps, queue, saveSettings } = makeDeps({ running: true });

        await expect(pauseAutoSummarization(deps)).resolves.toBe('paused');

        expect(queue.abort).toHaveBeenCalledTimes(1);
        expect(getSettings().autoPaused).toBe(true);
        expect(saveSettings).toHaveBeenCalledTimes(1);
    });

    it("returns 'paused' with the same latch write when only an abort controller is live", async () => {
        const { deps, queue, hasActiveAbortController, saveSettings } = makeDeps({
            liveRequest: true,
        });

        await expect(pauseAutoSummarization(deps)).resolves.toBe('paused');

        expect(hasActiveAbortController).toHaveBeenCalled();
        expect(queue.abort).toHaveBeenCalledTimes(1);
        expect(getSettings().autoPaused).toBe(true);
        expect(saveSettings).toHaveBeenCalledTimes(1);
    });
});

describe('resumeAutoSummarization', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("returns 'not-paused' and does not kick when the latch is clear", async () => {
        const { deps, queue, saveSettings } = makeDeps();

        await expect(resumeAutoSummarization(deps)).resolves.toBe('not-paused');

        expect(queue.request).not.toHaveBeenCalled();
        expect(saveSettings).not.toHaveBeenCalled();
    });

    it("returns 'resumed', clears the latch, saves, and kicks exactly one cycle", async () => {
        const { deps, queue, saveSettings } = makeDeps({ latch: true });

        await expect(resumeAutoSummarization(deps)).resolves.toBe('resumed');

        expect(getSettings().autoPaused).toBe(false);
        expect(saveSettings).toHaveBeenCalledTimes(1);
        expect(queue.request).toHaveBeenCalledTimes(1);
    });

    it('resolves without throwing when the kicked cycle rejects', async () => {
        const { deps } = makeDeps({
            latch: true,
            request: async () => {
                throw new Error('kick failed');
            },
        });

        await expect(resumeAutoSummarization(deps)).resolves.toBe('resumed');
    });
});
