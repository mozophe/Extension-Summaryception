import { beforeEach, describe, expect, it } from 'vitest';

import { countLayer0SourceBudget, getSourceTokenCount } from '../src/core/token-budget.js';
import { installSummaryContext } from './test-helpers.js';

describe('getSourceTokenCount', () => {
    it('prefers sourceTokensBefore', () => {
        expect(
            getSourceTokenCount({
                sourceTokensBefore: 100,
                regexStats: { finalTokens: 50 },
                memoryTokensBefore: 30,
            }),
        ).toBe(100);
    });

    it('falls to regexStats.finalTokens when sourceTokensBefore is absent', () => {
        expect(
            getSourceTokenCount({ regexStats: { finalTokens: 50 }, memoryTokensBefore: 30 }),
        ).toBe(50);
    });

    it('skips a zero sourceTokensBefore and uses regexStats.finalTokens', () => {
        expect(
            getSourceTokenCount({ sourceTokensBefore: 0, regexStats: { finalTokens: 50 } }),
        ).toBe(50);
    });

    it('falls to memoryTokensBefore last', () => {
        expect(getSourceTokenCount({ memoryTokensBefore: 30 })).toBe(30);
    });

    it.each([
        ['empty object', {}],
        ['no argument', undefined],
        ['negative', { sourceTokensBefore: -5 }],
        ['non-numeric', { sourceTokensBefore: 'abc' }],
    ])('returns 0 when no candidate is a positive number (%s)', (_label, metadata) => {
        expect(getSourceTokenCount(metadata)).toBe(0);
    });
});

describe('countLayer0SourceBudget', () => {
    beforeEach(() => {
        installSummaryContext({ getTokenCountAsync: async (text) => String(text).length });
    });

    it.each(['', '   '])(
        'reports zero state for empty state text (%s)',
        async (sourceStateText) => {
            expect(
                await countLayer0SourceBudget({ sourceNarrativeTokens: 42, sourceStateText }),
            ).toEqual({ narrativeTokens: 42, stateTokens: 0, stateKeyCount: 0 });
        },
    );

    it.each([
        ['non-numeric', 'x'],
        ['NaN', NaN],
    ])('coerces a non-finite narrative to 0 (%s)', async (_label, sourceNarrativeTokens) => {
        const result = await countLayer0SourceBudget({
            sourceNarrativeTokens,
            sourceStateText: '',
        });
        expect(result.narrativeTokens).toBe(0);
    });

    it('passes a finite narrative through unchanged, including negatives', async () => {
        const result = await countLayer0SourceBudget({
            sourceNarrativeTokens: -3,
            sourceStateText: '',
        });
        expect(result.narrativeTokens).toBe(-3);
    });

    it('counts a headerless state body and its keys', async () => {
        const sourceStateText = 'location: tavern\nmood: tense';
        const result = await countLayer0SourceBudget({
            sourceNarrativeTokens: 10,
            sourceStateText,
        });
        expect(result.stateTokens).toBe(sourceStateText.length);
        expect(result.stateKeyCount).toBeGreaterThanOrEqual(1);
    });

    it('counts a state body with an explicit [STATE] header', async () => {
        const sourceStateText = '[STATE]\nlocation: tavern';
        const result = await countLayer0SourceBudget({
            sourceNarrativeTokens: 10,
            sourceStateText,
        });
        expect(result.stateKeyCount).toBeGreaterThanOrEqual(1);
        expect(result.stateTokens).toBe(sourceStateText.length);
    });

    it('yields zero keys but nonzero tokens for a header-only state body', async () => {
        const sourceStateText = '[STATE]\n';
        const result = await countLayer0SourceBudget({
            sourceNarrativeTokens: 10,
            sourceStateText,
        });
        expect(result.stateKeyCount).toBe(0);
        expect(result.stateTokens).toBe(sourceStateText.trim().length);
    });
});
