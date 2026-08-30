import { beforeEach, describe, expect, it, vi } from 'vitest';

import { onChatCompletionPromptReady, onGenerateAfterData } from '../src/entry/events.js';

const { logger } = globalThis.summaryceptionFoundationMocks;

describe('onChatCompletionPromptReady', () => {
    beforeEach(() => {
        logger.debug.mockClear();
        logger.isDebugEnabled.mockReturnValue(true);
        vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
        vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('reports one prefix summary per real prompt', () => {
        onChatCompletionPromptReady({
            chat: [
                { role: 'system', content: 'fixed' },
                { role: 'user', content: 'first' },
            ],
        });
        logger.debug.mockClear();

        onChatCompletionPromptReady({
            chat: [
                { content: 'fixed', role: 'system' },
                { role: 'user', content: 'second' },
                { role: 'assistant', content: 'new' },
            ],
        });

        expect(console.groupCollapsed).toHaveBeenCalledWith(
            '[Summaryception] [DEBUG] Prompt prefix BROKEN at block 1: previous 2, current 3',
        );
        expect(JSON.parse(console.log.mock.calls[0][0])).toEqual({
            type: 'summaryception.prompt.prefix-broken.v1',
            block: 1,
            previousLength: 2,
            currentLength: 3,
            newBlock: { role: 'user', content: 'second' },
        });
        expect(console.groupEnd).toHaveBeenCalledTimes(1);
    });

    it('ignores dry-run prompt events in either event signature', () => {
        logger.debug.mockClear();
        onChatCompletionPromptReady({ chat: [{ role: 'system', content: 'dry' }] }, true);
        onChatCompletionPromptReady({ chat: [{ role: 'system', content: 'dry' }], dryRun: true });
        expect(logger.debug).not.toHaveBeenCalled();
    });

    it('does not mutate generation data during a dry run', () => {
        const payload = { prompt: [{ role: 'user', content: 'dry' }] };
        onGenerateAfterData(payload, true);
        expect(payload).toEqual({ prompt: [{ role: 'user', content: 'dry' }] });
    });
});
