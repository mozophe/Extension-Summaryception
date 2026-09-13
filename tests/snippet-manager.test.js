import { afterEach, describe, expect, it, vi } from 'vitest';

const stateMocks = vi.hoisted(() => ({
    saveChatStore: vi.fn(async () => {}),
}));

vi.mock('../src/foundation/state.js', async (importOriginal) => ({
    ...(await importOriginal()),
    saveChatStore: stateMocks.saveChatStore,
}));

const summarizerMocks = vi.hoisted(() => ({
    callSummarizer: vi.fn(),
    getIsSummarizing: vi.fn(() => false),
    setSummarizing: vi.fn(),
}));
vi.mock('../src/core/summarizer.js', () => summarizerMocks);

const { installSummaryContext, makeMessage, makeSummaryStore } = await import('./test-helpers.js');
const { isRegenerationCandidate, updateSnippetTextAt } =
    await import('../src/features/snippet-manager.js');

describe('updateSnippetTextAt', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        stateMocks.saveChatStore.mockClear();
    });

    async function installWithSnippet() {
        const chat = [makeMessage({ role: 'user', content: 'hello' })];
        const store = makeSummaryStore({
            layers: [[{ text: 'old text', sourceMessageIds: ['sc-1'] }]],
        });
        installSummaryContext({ chat, metadata: { summaryception: store } });
        return store;
    }

    it('persists the store after an applied edit', async () => {
        await installWithSnippet();

        await expect(updateSnippetTextAt(0, 0, 'new text')).resolves.toEqual({
            status: 'updated',
        });

        expect(stateMocks.saveChatStore).toHaveBeenCalledTimes(1);
    });
});

describe('isRegenerationCandidate', () => {
    function installReadySnippet() {
        const chat = [
            makeMessage({ isUser: true, scId: 'user-id', mes: 'User scene.' }),
            makeMessage({ scId: 'assistant-id', mes: 'Assistant scene.' }),
        ];
        const store = makeSummaryStore({
            layers: [[{ text: 'summary', sourceMessageIds: ['user-id', 'assistant-id'] }]],
        });
        installSummaryContext({ chat, metadata: { summaryception: store } });
        return store;
    }

    it('is true for a contiguous Layer 0 source range', () => {
        installReadySnippet();
        expect(isRegenerationCandidate(0, 0)).toBe(true);
    });

    it('is false for a deeper-layer snippet', () => {
        installReadySnippet();
        expect(isRegenerationCandidate(1, 0)).toBe(false);
    });

    it('is false for a missing snippet', () => {
        installReadySnippet();
        expect(isRegenerationCandidate(0, 5)).toBe(false);
    });

    it('is false for non-contiguous source ids', () => {
        const chat = [
            makeMessage({ isUser: true, scId: 'user-id', mes: 'User scene.' }),
            makeMessage({ scId: 'gap-id', mes: 'Gap scene.' }),
            makeMessage({ scId: 'assistant-id', mes: 'Assistant scene.' }),
        ];
        const store = makeSummaryStore({
            layers: [[{ text: 'summary', sourceMessageIds: ['user-id', 'assistant-id'] }]],
        });
        installSummaryContext({ chat, metadata: { summaryception: store } });
        expect(isRegenerationCandidate(0, 0)).toBe(false);
    });
});
