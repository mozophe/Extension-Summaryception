import { describe, expect, it, vi } from 'vitest';

import { clearSummaryceptionMemory } from '../src/features/memory.js';
import { installSummaryContext, makeMessage, makeSummaryStore } from './test-helpers.js';

describe('clearSummaryceptionMemory', () => {
    it('unhides the full chat and removes all Summaryception chat metadata', async () => {
        const calls = [];
        const saveMetadata = vi.fn();
        const saveChat = vi.fn();
        const chat = [
            {
                ...makeMessage({ isUser: true, isSystem: true, mes: 'user', scId: 'user-id' }),
                extra: { sc_ghosted: true, sc_token_count: { rawTokens: 1 }, reasoning: 'keep' },
            },
            makeMessage({ isSystem: true, mes: 'temporary', scId: 'temporary-id' }),
            {
                ...makeMessage({ mes: 'assistant', scId: 'assistant-id' }),
                extra: { sc_ghosted: true, api: 'keep' },
            },
        ];
        const metadata = {
            summaryception: makeSummaryStore({
                layers: [[{ text: 'summary', sourceMessageIds: ['user-id', 'assistant-id'] }]],
                ghostedMessageIds: ['user-id', 'assistant-id'],
            }),
            unrelated: { keep: true },
        };
        const runtime = installSummaryContext({
            chat,
            metadata,
            executeSlashCommandsWithOptions: async (command) => calls.push(command),
            deleteMessage: async (index) => chat.splice(index, 1),
            saveMetadata,
            saveChat,
        });

        await clearSummaryceptionMemory();

        expect(calls).toEqual(['/unhide 0-2']);
        expect(runtime.chat).toHaveLength(3);
        expect(runtime.chatMetadata).toEqual({ unrelated: { keep: true } });
        expect(runtime.chat).toEqual([
            expect.objectContaining({
                extra: { reasoning: 'keep' },
            }),
            expect.objectContaining({ mes: 'temporary' }),
            expect.objectContaining({
                extra: { api: 'keep' },
            }),
        ]);
        expect(runtime.chat.every((message) => !Object.hasOwn(message, 'sc_id'))).toBe(true);
        expect(saveMetadata).toHaveBeenCalledOnce();
        expect(saveChat).toHaveBeenCalledTimes(1);
    });
});
