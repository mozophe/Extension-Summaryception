import { describe, expect, it, vi } from 'vitest';

const store = { layers: [[], []] };
const settings = { snippetsPerLayer: 20, snippetsPerPromotion: 3, memoryTokenBudget: 6000 };

// L0 token count is whatever the test sets; everything else is irrelevant to overflow detection.
let layer0Tokens = 0;

vi.mock('../src/foundation/state.js', () => ({
    bumpSummaryStoreMutationEpoch: vi.fn(),
    getEffectiveSettings: () => settings,
    getChatStore: () => store,
    saveChatStore: vi.fn(),
}));
vi.mock('../src/core/memory-budget.js', () => ({
    getEffectiveMemoryUsage: async (layers) => ({
        // Promoting 3 of L0's snippets removes 3/22 of its tokens.
        total: { count: layer0Tokens },
        layers: [{ layerIndex: 0, count: Math.round((layer0Tokens * layers[0].length) / 22) }],
        state: null,
    }),
}));

const { hasPromotionOverflow } = await import('../src/core/summarizer-promotion.js');

function seedLayer0(count) {
    store.layers[0] = Array.from({ length: count }, (_, i) => ({ text: `s${i}` }));
}

describe('hasPromotionOverflow', () => {
    // L0 quota = floor(6000 * 0.6) = 3600, retention floor = floor(3600 * 0.4) = 1440.
    it('reports overflow when the merge keeps L0 above its retention floor', async () => {
        seedLayer0(22);
        layer0Tokens = 3000; // after merging 3: ~2591, above 1440
        expect(await hasPromotionOverflow(0)).toBe(true);
    });

    it('reports no overflow when the merge would drop L0 under its retention floor', async () => {
        seedLayer0(22);
        layer0Tokens = 1600; // after merging 3: ~1382, below 1440
        expect(await hasPromotionOverflow(0)).toBe(false);
    });
});
