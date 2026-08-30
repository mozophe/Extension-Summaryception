import { describe, expect, it } from 'vitest';

import {
    STATE_KEY_CEILING,
    computeSentenceCap,
    computeStateLineCap,
} from '../src/core/token-budget.js';
import {
    buildLayer0BudgetHint,
    buildSizeConstraintsBlock,
    buildSizeTargetLine,
} from '../src/core/token-budget.js';
import { getActiveLineCap } from '../src/foundation/state-categories.js';
import { defaultSettings } from '../src/foundation/constants.js';

describe('computeSentenceCap', () => {
    const degenerateTargets = [undefined, 0, -5, NaN];

    it.each(degenerateTargets)(
        'returns the minimum cap of 1 for a non-finite or non-positive target %s',
        (target) => {
            for (const layer of ['l0', 'l1', 'l2']) {
                expect(computeSentenceCap(layer, target)).toBe(1);
            }
        },
    );

    it('scales the cap upward as the slider target grows, for every layer band', () => {
        for (const layer of ['l0', 'l1', 'l2']) {
            expect(computeSentenceCap(layer, 400)).toBeGreaterThan(computeSentenceCap(layer, 100));
        }
    });

    it('preserves the intended layer ordering l0 > l1 > l2 at a large slider target', () => {
        // Promotions run a tighter safety multiplier than the direct L0 pass, so
        // both promotion bands (l1, l2) fall below l0. At T=2000 the three
        // ratio×safety products (l0 1.275, l1 0.875, l2 0.75) stay far enough
        // apart that Math.floor preserves ordering.
        // A future refactor that intentionally re-orders bands SHOULD fail here.
        const l0 = computeSentenceCap('l0', 2000);
        const l1 = computeSentenceCap('l1', 2000);
        const l2 = computeSentenceCap('l2', 2000);
        expect(l0).toBeGreaterThan(l1);
        expect(l1).toBeGreaterThan(l2);
    });

    it('maps numeric layer indices to the same bands as their string keys', () => {
        const T = 2000;
        expect(computeSentenceCap(0, T)).toBe(computeSentenceCap('l0', T));
        expect(computeSentenceCap(2, T)).toBe(computeSentenceCap('l2', T));
        // Any deep promotion index maps to the l2 band.
        expect(computeSentenceCap(5, T)).toBe(computeSentenceCap('l2', T));
    });

    it('floors tiny positive targets to the minimum cap of 1', () => {
        expect(computeSentenceCap('l0', 1)).toBe(1);
    });
});

describe('computeStateLineCap', () => {
    it('returns STATE_KEY_CEILING for non-finite or non-positive counts', () => {
        for (const n of [undefined, 0, -2, NaN]) {
            expect(computeStateLineCap(n)).toBe(STATE_KEY_CEILING);
        }
    });

    it('returns the count itself below the ceiling and clamps at the ceiling otherwise', () => {
        expect(computeStateLineCap(3)).toBe(3);
        expect(computeStateLineCap(STATE_KEY_CEILING + 5)).toBe(STATE_KEY_CEILING);
    });
});

describe('buildSizeTargetLine', () => {
    it('formats the minimal cap line without a verb or extra clause', () => {
        expect(buildSizeTargetLine({ label: '[NARRATIVE]', cap: 7, unit: 'sentences' })).toBe(
            '[NARRATIVE]: at most 7 sentences.',
        );
    });

    it('inserts a leading verb clause between the label and "at most"', () => {
        const result = buildSizeTargetLine({
            label: '[NARRATIVE]',
            cap: 7,
            unit: 'sentences',
            verb: 'rewrite the full snapshot;',
        });
        expect(result).toContain('rewrite the full snapshot');
        const verbIdx = result.indexOf('rewrite the full snapshot');
        const atMostIdx = result.indexOf('at most');
        expect(verbIdx).toBeLessThan(atMostIdx);
        expect(result.startsWith('[NARRATIVE]')).toBe(true);
    });

    it('appends a trailing extra after the period', () => {
        const result = buildSizeTargetLine({
            label: '[NARRATIVE]',
            cap: 7,
            unit: 'sentences',
            extra: 'Tail.',
        });
        expect(result.endsWith('Tail.')).toBe(true);
        expect(result).toContain('sentences.');
    });
});

describe('buildSizeConstraintsBlock', () => {
    it('wraps the target and repair lines between matching tags', () => {
        const result = buildSizeConstraintsBlock({
            wrapperTag: 'summaryception_promotion_constraints',
            targetLine: 'L',
            repairLine: 'R',
        });
        expect(result.startsWith('<summaryception_promotion_constraints>\nL')).toBe(true);
        // Both target and repair lines sit between the wrapper tags.
        expect(result).toContain('R</summaryception_promotion_constraints>');
        expect(result.endsWith('</summaryception_promotion_constraints>')).toBe(true);
    });

    it('still closes the wrapper when the repair line is omitted', () => {
        const result = buildSizeConstraintsBlock({
            wrapperTag: 'summaryception_promotion_constraints',
            targetLine: 'L',
        });
        expect(result.endsWith('</summaryception_promotion_constraints>')).toBe(true);
    });
});

describe('buildLayer0BudgetHint', () => {
    it('emits counting caps and never leaks token figures when no prior state exists', () => {
        const result = buildLayer0BudgetHint({
            sourceStateTokens: 0,
            sourceStateKeyCount: 0,
            targetTokens: 250,
            settings: defaultSettings,
        });
        expect(result).toContain('<summaryception_source_budget>');
        expect(result).toContain('</summaryception_source_budget>');
        expect(result).toContain('No existing [STATE] yet');
        expect(result).toContain('[NARRATIVE]');
        expect(result).toContain('[STATE]');
        // The model cannot count tokens, so none should appear in the hint.
        expect(/\d+\s*tokens?/i.test(result)).toBe(false);
    });

    it('reports the existing state-key count and a matching state line cap when prior state exists', () => {
        const result = buildLayer0BudgetHint({
            sourceStateTokens: 100,
            sourceStateKeyCount: 4,
            targetTokens: 250,
            settings: defaultSettings,
        });
        expect(result).toContain('Existing [STATE]: 4 keys.');
        // The [STATE] cap line equals computeStateLineCap(4) (cross-check via
        // the same exported function the builder uses; never a literal).
        expect(result).toContain(`at most ${computeStateLineCap(4)} lines`);
    });

    it('anchors the state line cap to the enabled modular categories when settings are supplied with no prior state', () => {
        const settings = {
            stateCatDateTime: true,
            stateCatBonds: true,
            stateCatChekhov: true,
            stateCatGmNotes: true,
            stateCatInventory: true,
            stateCatLocation: true,
        };
        const result = buildLayer0BudgetHint({
            sourceStateTokens: 0,
            sourceStateKeyCount: 0,
            targetTokens: 250,
            settings,
        });
        // With all six categories enabled the raw sum is 36, clamped to the
        // STATE_KEY_CEILING (12); the same contract getActiveLineCap encodes.
        expect(getActiveLineCap(settings, STATE_KEY_CEILING)).toBe(12);
        expect(result).toContain('at most 12 lines');
        // Must never leak the unclamped 36 figure.
        expect(result).not.toContain('at most 36 lines');
    });
});
