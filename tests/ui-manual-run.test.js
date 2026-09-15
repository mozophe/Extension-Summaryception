import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindManualRunControls } from '../src/entry/ui-manual-run.js';
import { TOAST_TITLE } from '../src/foundation/constants.js';
import { createJQueryHarness, installSummaryContext, makeToastrMock } from './test-helpers.js';

vi.mock('../src/entry/ui.js', async (importOriginal) => ({
    ...(await importOriginal()),
    updateUI: vi.fn(),
}));
const summarizerMocks = vi.hoisted(() => ({
    describeManualRun: vi.fn(),
    runManual: vi.fn(),
}));

vi.mock('../src/core/summarizer.js', async (importOriginal) => ({
    ...(await importOriginal()),
    describeManualRun: summarizerMocks.describeManualRun,
    runManual: summarizerMocks.runManual,
}));

describe('manual run failure handling', () => {
    const forceIdleHtml = '<i class="fa-solid fa-bolt"></i><span>Force Summarize</span>';
    let dom;
    let button;

    beforeEach(() => {
        installSummaryContext();
        globalThis.toastr = makeToastrMock();
        globalThis.document = {};
        dom = createJQueryHarness();
        globalThis.$ = dom.$;
        summarizerMocks.describeManualRun.mockResolvedValue({ ready: true, backlog: 2 });
        summarizerMocks.runManual.mockRejectedValue(new Error('provider exploded'));
        bindManualRunControls({ notify: null });
        button = dom.element('#sc_force_summarize');
    });

    afterEach(() => {
        delete globalThis.document;
    });

    it('logs a failed manual run, shows an error toast, and restores the button', async () => {
        await dom.trigger('click', '#sc_force_summarize, #sc_easy_force_summarize', button);

        expect(summarizerMocks.runManual).toHaveBeenCalledTimes(1);
        expect(globalThis.summaryceptionFoundationMocks.logger.error).toHaveBeenCalled();
        expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.error.mock.calls[0][1]).toBe(TOAST_TITLE);
        expect(button.prop('disabled')).toBe(false);
        expect(button.html()).toBe(forceIdleHtml);
    });
});
