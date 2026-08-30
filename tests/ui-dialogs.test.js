import { beforeEach, describe, expect, it } from 'vitest';

import { showStaleCacheAdvice } from '../src/entry/ui-dialogs.js';
import { makeToastrMock } from './test-helpers.js';

describe('showStaleCacheAdvice', () => {
    beforeEach(() => {
        globalThis.toastr = makeToastrMock();
    });

    it('shows a long-lived action toast for a stale cache', () => {
        showStaleCacheAdvice({
            advise: true,
            reason: 'stale',
            staleMinutes: 75,
            ttlMinutes: 30,
            queuedTurns: 5,
            queuedTokens: 4000,
        });

        expect(globalThis.toastr.info).toHaveBeenCalledTimes(1);
        const [message, title, options] = globalThis.toastr.info.mock.calls[0];
        expect(title).toContain('Stale Cache');
        expect(message).toContain('75 minutes old');
        expect(message).toContain('Force Summarize now');
        expect(message).toContain('sc_stale_cache_force');
        expect(options).toMatchObject({
            timeOut: 60000,
            extendedTimeOut: 60000,
            closeButton: true,
            tapToDismiss: false,
            escapeHtml: false,
        });
    });
});
