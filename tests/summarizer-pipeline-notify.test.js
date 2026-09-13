import { afterEach, describe, expect, it } from 'vitest';

import { NOTIFY_EVENTS } from '../src/foundation/constants.js';
import { setNotifyAdapter } from '../src/core/notify.js';
import { processSummarizerResponse } from '../src/core/summarizer-pipeline.js';
import {
    installBrowserRuntimeStub,
    makeNotifyRecorder,
    makeSummarySettings,
} from './test-helpers.js';

/**
 * The summarizer pipeline emits structured notify events (ADR-0004) instead of
 * calling the notification library; the entry adapter renders the language-mix
 * retry warning.
 */
describe('summarizer pipeline notify events', () => {
    afterEach(() => {
        setNotifyAdapter(null);
        delete globalThis.toastr;
    });

    it('emits a structured language-mix event when the CN policy rejects a response', async () => {
        const { toastr } = installBrowserRuntimeStub();
        const recorder = makeNotifyRecorder();
        setNotifyAdapter(recorder);

        const result = await processSummarizerResponse(
            '这是一段用于测试的中文摘要文本',
            makeSummarySettings({ stripChineseIdeographs: true }),
            { kind: 'layer0' },
        );

        expect(result.status).toBe('cn-rejected');
        expect(toastr.warning).not.toHaveBeenCalled();
        expect(recorder.events).toEqual([
            {
                type: 'transient',
                kind: NOTIFY_EVENTS.LANGUAGE_MIX_RETRY,
                percent: '100.0',
            },
        ]);
    });
});
