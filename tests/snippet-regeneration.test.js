import { afterEach, describe, expect, it, vi } from 'vitest';

const summarizerMocks = vi.hoisted(() => ({
    callSummarizer: vi.fn(),
    getIsSummarizing: vi.fn(() => false),
    setSummarizing: vi.fn(),
}));
vi.mock('../src/core/summarizer.js', () => summarizerMocks);

import { regenerateSnippetAt } from '../src/features/snippet-manager.js';
import { installSummaryContext, makeMessage, makeSummaryStore } from './test-helpers.js';

describe('snippet regeneration request outcomes', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        summarizerMocks.callSummarizer.mockReset();
    });

    function installReadyTarget() {
        const chat = [
            makeMessage({ isUser: true, scId: 'user-id', mes: 'User scene.' }),
            makeMessage({ scId: 'assistant-id', mes: 'Assistant scene.' }),
        ];
        const snippet = {
            text: 'old summary',
            sourceMessageIds: ['user-id', 'assistant-id'],
            timestamp: 0,
        };
        const store = makeSummaryStore({ layers: [[snippet]] });
        installSummaryContext({ chat, metadata: { summaryception: store } });
        return { store, snippet };
    }

    it('writes the regenerated snippet when the outcome is completed', async () => {
        const { store, snippet } = installReadyTarget();
        summarizerMocks.callSummarizer.mockResolvedValue({
            status: 'completed',
            text: `[NARRATIVE]\nA fresh summary.\n[STATE]\nlocation: room`,
        });

        await expect(regenerateSnippetAt(0, 0)).resolves.toEqual({
            status: 'regenerated',
            range: [0, 1],
        });

        expect(snippet.text).toContain('A fresh summary.');
        expect(snippet.regenerated).toBe(true);
        // Ghost step acquires snippet ownership (bump) + the Snippet Commit's own bump.
        expect(store.mutationEpoch).toBe(2);
    });

    it('returns aborted without mutating the store when the outcome is aborted', async () => {
        const { store, snippet } = installReadyTarget();
        summarizerMocks.callSummarizer.mockResolvedValue({ status: 'aborted' });

        await expect(regenerateSnippetAt(0, 0)).resolves.toEqual({ status: 'aborted' });

        expect(snippet.text).toBe('old summary');
        expect(store.mutationEpoch).toBe(0);
    });

    it('returns blocked without mutating the store when the outcome is blocked', async () => {
        const { store, snippet } = installReadyTarget();
        summarizerMocks.callSummarizer.mockResolvedValue({ status: 'blocked' });

        await expect(regenerateSnippetAt(0, 0)).resolves.toEqual({ status: 'blocked' });

        expect(snippet.text).toBe('old summary');
        expect(store.mutationEpoch).toBe(0);
    });
});
