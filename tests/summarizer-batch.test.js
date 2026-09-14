import { afterEach, describe, expect, it, vi } from 'vitest';

const callSummarizer = vi.hoisted(() => vi.fn());
vi.mock('../src/core/summarizer-request.js', () => ({ callSummarizer }));

import {
    summarizeAtomicLayer0Partitions,
    summarizeBatchFromTurns,
} from '../src/core/summarizer-batch.js';
import {
    installSummaryContext,
    makeMessage,
    makeNotifyRecorder,
    makeSummaryStore,
} from './test-helpers.js';

describe('Layer 0 deferred cleanup commit', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        callSummarizer.mockReset();
    });

    function buildChat() {
        return [
            makeMessage({ isUser: true, scId: 'user-id', mes: 'User scene.' }),
            makeMessage({ scId: 'assistant-id', mes: 'Assistant scene.' }),
        ];
    }

    it('notifies one batch progress lifecycle and closes it with success', async () => {
        const recorder = makeNotifyRecorder();
        const chat = buildChat();
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
        let progressOpenAtRequest = false;
        callSummarizer.mockImplementation(async () => {
            progressOpenAtRequest = recorder.events.some((event) => event.type === 'progress');
            return {
                status: 'completed',
                text: `[NARRATIVE]\nA concise summary.\n[STATE]\nlocation: room`,
            };
        });

        await expect(summarizeBatchFromTurns([{ index: 1 }], {}, recorder)).resolves.toBe(true);

        expect(progressOpenAtRequest).toBe(true);
        const progress = recorder.events.filter((event) => event.type === 'progress');
        expect(progress).toHaveLength(1);
        expect(progress[0].label).toBe('batch-memory');
        expect(progress[0].total).toBe(1);
        const updates = recorder.events.filter((event) => event.type === 'update');
        expect(updates.map((event) => event.processed)).toEqual([1]);
        expect(updates[0].handle).toBe(progress[0].handle);
        const clears = recorder.events.filter((event) => event.type === 'clear');
        expect(clears).toHaveLength(1);
        expect(clears[0].handle).toBe(progress[0].handle);
        expect(clears[0].event).toEqual({ kind: 'batch-memory-updated' });
    });

    it('closes the batch progress with an aborted terminal when the request is aborted', async () => {
        const recorder = makeNotifyRecorder();
        const chat = buildChat();
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
        callSummarizer.mockResolvedValue({ status: 'aborted' });

        await expect(summarizeBatchFromTurns([{ index: 1 }], {}, recorder)).resolves.toBe(false);

        const progress = recorder.events.filter((event) => event.type === 'progress');
        expect(progress).toHaveLength(1);
        expect(progress[0].label).toBe('batch-memory');
        expect(recorder.events.filter((event) => event.type === 'update')).toHaveLength(0);
        const clears = recorder.events.filter((event) => event.type === 'clear');
        expect(clears).toHaveLength(1);
        expect(clears[0].handle).toBe(progress[0].handle);
        expect(clears[0].event).toEqual({ kind: 'batch-memory-aborted' });
    });

    it.each([['blocked'], ['failed']])(
        'closes the batch progress with a warning terminal when the request is %s',
        async (status) => {
            const recorder = makeNotifyRecorder();
            const chat = buildChat();
            installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
            callSummarizer.mockResolvedValue({ status });

            await expect(summarizeBatchFromTurns([{ index: 1 }], {}, recorder)).resolves.toBe(
                false,
            );

            const clears = recorder.events.filter((event) => event.type === 'clear');
            expect(clears).toHaveLength(1);
            expect(clears[0].event).toEqual({ kind: 'batch-memory-failed' });
        },
    );

    it('emits no progress events when the passage never validates', async () => {
        const recorder = makeNotifyRecorder();
        const chat = [
            makeMessage({ isUser: true, scId: 'user-id', mes: '' }),
            makeMessage({ scId: 'assistant-id', mes: '' }),
        ];
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
        callSummarizer.mockResolvedValue({
            status: 'completed',
            text: `[NARRATIVE]\nA concise summary.\n[STATE]\nlocation: room`,
        });

        await expect(summarizeBatchFromTurns([{ index: 1 }], {}, recorder)).resolves.toBe(false);

        expect(callSummarizer).not.toHaveBeenCalled();
        expect(recorder.events).toEqual([]);
    });
    it('assigns missing IDs on the live chat before capturing the source snapshot', async () => {
        vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('assistant-id');
        const chat = buildChat();
        delete chat[1].sc_id;
        const metadata = { summaryception: makeSummaryStore() };
        installSummaryContext({ chat, metadata });
        callSummarizer.mockResolvedValue({
            status: 'completed',
            text: `[NARRATIVE]\nA concise summary.\n[STATE]\nlocation: room`,
        });

        await expect(summarizeBatchFromTurns([{ index: 1 }])).resolves.toBe(true);

        expect(metadata.summaryception.layers[0][0].sourceMessageIds).toEqual([
            'user-id',
            'assistant-id',
        ]);
    });

    it('keeps all chat records intact while the summary runs and commits', async () => {
        const chat = buildChat();
        const metadata = { summaryception: makeSummaryStore() };
        const saveMetadata = vi.fn(async () => {});
        const saveChat = vi.fn(async () => {});
        const reloadCurrentChat = vi.fn(async () => {});
        let resolveSummary;
        callSummarizer.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveSummary = resolve;
                }),
        );
        installSummaryContext({
            chat,
            metadata,
            saveMetadata,
            saveChat,
            reloadCurrentChat,
        });

        const resultPromise = summarizeBatchFromTurns([{ index: 1 }]);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(chat.map((message) => message.sc_id)).toEqual(['user-id', 'assistant-id']);
        expect(saveChat).not.toHaveBeenCalled();
        resolveSummary({
            status: 'completed',
            text: `[NARRATIVE]\nA concise summary.\n[STATE]\nlocation: room`,
        });
        await expect(resultPromise).resolves.toBe(true);

        expect(chat.map((message) => message.sc_id)).toEqual(['user-id', 'assistant-id']);
        expect(metadata.summaryception.layers[0]).toHaveLength(1);
        expect(reloadCurrentChat).not.toHaveBeenCalled();
        expect(saveMetadata).toHaveBeenCalled();
    });

    it('restores chat and Layer 0 when post-mutation persistence fails', async () => {
        const chat = buildChat();
        const originalChat = [...chat];
        const metadata = { summaryception: makeSummaryStore() };
        let metadataSaves = 0;
        const saveMetadata = vi.fn(async () => {
            metadataSaves++;
            if (metadataSaves === 1) {
                throw new Error('metadata write failed');
            }
        });
        installSummaryContext({ chat, metadata, saveMetadata });
        callSummarizer.mockResolvedValue({
            status: 'completed',
            text: `[NARRATIVE]\nA concise summary.\n[STATE]\nlocation: room`,
        });
        await expect(summarizeBatchFromTurns([{ index: 1 }])).rejects.toThrow(
            'metadata write failed',
        );

        expect(chat).toEqual(originalChat);
        expect(metadata.summaryception.layers[0]).toEqual([]);
        expect(metadata.summaryception.mutationEpoch).toBe(0);
    });
});

describe('Layer 0 atomic multi-partition progress', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        callSummarizer.mockReset();
    });

    it('closes the shared progress exactly once when a later partition fails validation', async () => {
        const recorder = makeNotifyRecorder();
        const chat = [
            makeMessage({ isUser: true, scId: 'user-id', mes: 'User scene.' }),
            makeMessage({ scId: 'assistant-id', mes: 'First assistant scene.' }),
            makeMessage({ isUser: true, scId: 'user-id-2', mes: 'User scene two.' }),
            makeMessage({ scId: 'assistant-id-2', mes: 'Second assistant scene.' }),
        ];
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });
        callSummarizer
            .mockResolvedValueOnce({
                status: 'completed',
                text: `[NARRATIVE]\nA concise summary.\n[STATE]\nlocation: room`,
            })
            .mockResolvedValueOnce({ status: 'aborted' });
        const partitions = [
            { turns: [{ index: 1 }], sourceStartIdx: 1, sourceEndIdx: 1 },
            { turns: [{ index: 3 }], sourceStartIdx: 3, sourceEndIdx: 3 },
        ];

        await expect(summarizeAtomicLayer0Partitions(partitions, {}, recorder)).resolves.toBe(
            false,
        );

        const progress = recorder.events.filter((event) => event.type === 'progress');
        expect(progress).toHaveLength(1);
        expect(progress[0].label).toBe('batch-memory');
        expect(progress[0].total).toBe(2);
        const updates = recorder.events.filter((event) => event.type === 'update');
        expect(updates.map((event) => event.processed)).toEqual([1]);
        expect(updates[0].handle).toBe(progress[0].handle);
        const clears = recorder.events.filter((event) => event.type === 'clear');
        expect(clears).toHaveLength(1);
        expect(clears[0].handle).toBe(progress[0].handle);
        expect(clears[0].event).toEqual({ kind: 'batch-memory-aborted' });
    });
});

describe('Layer 0 request outcome handling', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        callSummarizer.mockReset();
    });

    it.each([['aborted'], ['blocked'], ['failed']])(
        'skips the commit when the request outcome is %s',
        async (status) => {
            const chat = [
                makeMessage({ isUser: true, scId: 'user-id', mes: 'User scene.' }),
                makeMessage({ scId: 'assistant-id', mes: 'Assistant scene.' }),
            ];
            const metadata = { summaryception: makeSummaryStore() };
            installSummaryContext({ chat, metadata });
            callSummarizer.mockResolvedValue({ status });

            await expect(summarizeBatchFromTurns([{ index: 1 }])).resolves.toBe(false);

            expect(metadata.summaryception.layers[0]).toEqual([]);
            expect(metadata.summaryception.mutationEpoch).toBe(0);
        },
    );
});
