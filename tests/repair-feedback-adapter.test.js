import { describe, expect, it } from 'vitest';

import {
    buildRepairDiagnostics,
    buildStructuralRepairFeedback,
    countSentences,
} from '../src/core/repair-diagnostics.js';
import { computeSentenceCap, computeStateLineCap } from '../src/core/token-budget.js';

describe('countSentences', () => {
    it.each([
        ['', 0],
        ['   ', 0],
        [null, 0],
    ])('returns 0 for empty input (%s)', (text, expected) => {
        expect(countSentences(text)).toBe(expected);
    });

    it('counts a single unterminated sentence as 1', () => {
        expect(countSentences('a lone fragment with no terminal mark')).toBe(1);
    });

    it('splits on terminal punctuation followed by whitespace', () => {
        expect(countSentences('One. Two! Three?')).toBe(3);
    });

    it('counts a trailing sentence with no following whitespace', () => {
        expect(countSentences('One. Two')).toBe(2);
    });
});

// Build a size-rejection diagnostics object via the shared contract so the
// adapter tests track buildRepairDiagnostics rather than hand-crafted shapes.
function makeViolation({ id, text, reason = 'above-hard-maximum' }) {
    const hardMaxTokens = reason === 'above-hard-maximum' ? 1 : 0;
    const minimumTokens = reason === 'below-minimum' ? 100 : 0;
    return buildRepairDiagnostics({
        sections: [
            {
                id,
                actualTokens: reason === 'below-minimum' ? 1 : 100,
                hardMaxTokens,
                minimumTokens,
                text,
            },
        ],
    });
}

describe('buildStructuralRepairFeedback', () => {
    it('returns "" when violations is missing or not an array', () => {
        expect(buildStructuralRepairFeedback({}, {})).toBe('');
        expect(buildStructuralRepairFeedback({ violations: 'nope' }, {})).toBe('');
    });

    it('returns "" when the only violation is below-minimum (not above-hard-maximum)', () => {
        const diagnostics = makeViolation({
            id: 'state',
            text: 'a: 1\nb: 2\nc: 3',
            reason: 'below-minimum',
        });
        expect(buildStructuralRepairFeedback(diagnostics, {})).toBe('');
    });

    it('emits a state line mentioning actual count and cap when key:value lines exceed the cap', () => {
        const sourceBudget = { sourceStateKeyCount: 2 };
        const cap = computeStateLineCap(sourceBudget.sourceStateKeyCount);
        // Four key:value lines, plus a blank line and a colon-less line that are ignored.
        const text = 'a: 1\nb: 2\nc: 3\nd: 4\n\nno colon here';
        const diagnostics = makeViolation({ id: 'state', text });
        const feedback = buildStructuralRepairFeedback(diagnostics, sourceBudget);
        expect(feedback).toContain('4');
        expect(feedback).toContain(String(cap));
        expect(feedback).toContain('lines');
    });

    it('emits a narrative line mentioning sentences and the cap when the count exceeds it', () => {
        const sourceBudget = { layer: 'l0', targetTokens: 100 };
        const cap = computeSentenceCap('l0', 100);
        const sentences = Array.from({ length: cap + 3 }, (_v, i) => `Sentence ${i}.`).join(' ');
        const diagnostics = makeViolation({ id: 'narrative', text: sentences });
        const feedback = buildStructuralRepairFeedback(diagnostics, sourceBudget);
        expect(feedback).toContain(String(cap + 3));
        expect(feedback).toContain(String(cap));
        expect(feedback.toLowerCase()).toContain('sentences');
    });

    it('joins multiple actionable violations with newlines', () => {
        const sourceBudget = { sourceStateKeyCount: 1, layer: 'l0', targetTokens: 100 };
        const stateCap = computeStateLineCap(sourceBudget.sourceStateKeyCount);
        const narrativeCap = computeSentenceCap('l0', 100);
        const stateText = Array.from({ length: stateCap + 2 }, (_v, i) => `k${i}: v`).join('\n');
        const narrativeText = Array.from(
            { length: narrativeCap + 2 },
            (_v, i) => `Sentence ${i}.`,
        ).join(' ');
        // Two above-hard-maximum sections in one diagnostics object.
        const diagnostics = buildRepairDiagnostics({
            sections: [
                { id: 'state', actualTokens: 100, hardMaxTokens: 1, text: stateText },
                { id: 'narrative', actualTokens: 100, hardMaxTokens: 1, text: narrativeText },
            ],
        });
        const feedback = buildStructuralRepairFeedback(diagnostics, sourceBudget);
        expect(feedback.split('\n')).toHaveLength(2);
    });

    it('does not throw and applies default caps when sourceBudget is omitted', () => {
        const cap = computeStateLineCap(undefined);
        const text = Array.from({ length: cap + 1 }, (_v, i) => `k${i}: v`).join('\n');
        const diagnostics = makeViolation({ id: 'state', text });
        const feedback = buildStructuralRepairFeedback(diagnostics);
        expect(feedback).toContain(String(cap));
        expect(feedback).toContain(String(cap + 1));
    });
});
