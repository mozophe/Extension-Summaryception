import { describe, expect, it, vi } from 'vitest';

import { clearSummaryceptionMemory, importSummaryceptionMemory } from '../src/features/memory.js';
import {
    installSummaryContext,
    makeMessage,
    makeNotifyRecorder,
    makeSummaryStore,
} from './test-helpers.js';

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
        expect(saveMetadata).toHaveBeenCalled();
        expect(saveChat).toHaveBeenCalledTimes(1);
    });
});

describe('importSummaryceptionMemory', () => {
    const validLayers = [
        [{ text: 'l0', sourceMessageIds: ['a-1'] }],
        [
            { text: 'l1a', sourceMessageIds: ['b-1'] },
            { text: 'l1b', sourceMessageIds: ['b-2'] },
        ],
    ];

    function installStore(storeOverrides = {}) {
        const store = makeSummaryStore(storeOverrides);
        installSummaryContext({
            metadata: { summaryception: store, unrelated: { keep: true } },
        });
        return store;
    }

    it('imports valid layers through the commit seam and reports the snippet count', async () => {
        const store = installStore();
        const notify = makeNotifyRecorder();

        const result = await importSummaryceptionMemory(
            { layers: validLayers, ghostedMessageIds: ['a-1'] },
            { notify },
        );

        expect(result).toEqual({ status: 'imported', count: 3 });
        expect(store.layers).toEqual(validLayers);
        expect(store.mutationEpoch).toBeGreaterThan(0);
        expect(store.ghostedMessageIds).toEqual(['a-1', 'b-1', 'b-2']);
    });

    it('rejects a payload without layer arrays and leaves the store untouched', async () => {
        const sentinel = [{ text: 'keep', sourceMessageIds: ['keep-1'] }];
        const store = installStore({ layers: [sentinel], ghostedMessageIds: ['keep-1'] });
        const notify = makeNotifyRecorder();

        const result = await importSummaryceptionMemory({ ghostedMessageIds: [] }, { notify });

        expect(result).toEqual({ status: 'invalid' });
        expect(store.layers).toEqual([sentinel]);
        expect(store.mutationEpoch).toBe(0);
    });

    it('rejects a payload without ghosted IDs and leaves the store untouched', async () => {
        const sentinel = [{ text: 'keep', sourceMessageIds: ['keep-1'] }];
        const store = installStore({ layers: [sentinel], ghostedMessageIds: ['keep-1'] });
        const notify = makeNotifyRecorder();

        const result = await importSummaryceptionMemory({ layers: validLayers }, { notify });

        expect(result).toEqual({ status: 'invalid' });
        expect(store.layers).toEqual([sentinel]);
        expect(store.mutationEpoch).toBe(0);
    });

    it('rejects a payload whose snippets fail validation and leaves the store untouched', async () => {
        const sentinel = [{ text: 'keep', sourceMessageIds: ['keep-1'] }];
        const store = installStore({ layers: [sentinel], ghostedMessageIds: ['keep-1'] });
        const notify = makeNotifyRecorder();

        const result = await importSummaryceptionMemory(
            { layers: [[{ text: 'no provenance' }]], ghostedMessageIds: [] },
            { notify },
        );

        expect(result).toEqual({ status: 'invalid' });
        expect(store.layers).toEqual([sentinel]);
        expect(store.mutationEpoch).toBe(0);
    });

    it('reports failure and rolls the store back when the commit fails', async () => {
        const snapshot = [[{ text: 'keep', sourceMessageIds: ['keep-1'] }]];
        const store = installStore({ layers: snapshot, ghostedMessageIds: ['keep-1'] });
        const notify = makeNotifyRecorder();
        const failure = new Error('disk full');
        const saveMetadata = vi.fn().mockRejectedValueOnce(failure);
        installSummaryContext({ metadata: { summaryception: store }, saveMetadata });

        const result = await importSummaryceptionMemory(
            { layers: validLayers, ghostedMessageIds: ['a-1'] },
            { notify },
        );

        expect(result).toEqual({ status: 'failed', cause: failure });
        expect(store.layers).toEqual(snapshot);
        expect(store.ghostedMessageIds).toEqual(['keep-1']);
        expect(store.mutationEpoch).toBe(0);
    });
});
