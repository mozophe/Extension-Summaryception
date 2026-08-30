import { describe, expect, it } from 'vitest';

import { compileGlobalState, parseSnippet } from '../src/core/summarizer-state.js';

describe('parseSnippet current_date_time weekday normalization', () => {
    it('corrects a hallucinated weekday against the ISO date', () => {
        // Dec 3 2024 is Tuesday, not Friday (the kind of slip seen in f12 log).
        const parsed = parseSnippet(
            '[NARRATIVE]\nScene.\n\n[STATE]\ncurrent_date_time: 2024-12-03 06 Fri',
        );
        expect(parsed.state.current_date_time).toBe('2024-12-03 06 Tue');
    });

    it('preserves an already-correct weekday', () => {
        // July 4 2024 is Thursday, the canonical prompt example, verified correct.
        const parsed = parseSnippet(
            '[NARRATIVE]\nScene.\n\n[STATE]\ncurrent_date_time: 2024-07-04 16 Thu',
        );
        expect(parsed.state.current_date_time).toBe('2024-07-04 16 Thu');
    });

    it('inserts the weekday when the model omitted it', () => {
        const parsed = parseSnippet(
            '[NARRATIVE]\nScene.\n\n[STATE]\ncurrent_date_time: 2024-07-07 06',
        );
        expect(parsed.state.current_date_time).toBe('2024-07-07 06 Sun');
    });

    it('drops stray minutes and re-derives the weekday', () => {
        const parsed = parseSnippet(
            '[NARRATIVE]\nScene.\n\n[STATE]\ncurrent_date_time: 2024-07-04 16:32 Wed',
        );
        // Wrong weekday AND minutes present; hour retained, minutes dropped, weekday fixed.
        expect(parsed.state.current_date_time).toBe('2024-07-04 16 Thu');
    });

    it('leaves malformed values untouched rather than fabricating', () => {
        const parsed = parseSnippet(
            '[NARRATIVE]\nScene.\n\n[STATE]\ncurrent_date_time: someday soon',
        );
        expect(parsed.state.current_date_time).toBe('someday soon');
    });

    it('rejects impossible calendar dates and leaves them verbatim', () => {
        const parsed = parseSnippet(
            '[NARRATIVE]\nScene.\n\n[STATE]\ncurrent_date_time: 2024-02-30 06 Sat',
        );
        // Feb 30 does not exist; do not silently coerce.
        expect(parsed.state.current_date_time).toBe('2024-02-30 06 Sat');
    });

    it('reads only the latest Layer 0 state snapshot', () => {
        const state = compileGlobalState([
            [
                { text: '[NARRATIVE]\nOld.\n[STATE]\nlocation: cellar\nbonds: wary' },
                { text: '[NARRATIVE]\nNow.\n[STATE]\nlocation: rooftop' },
            ],
        ]);

        expect(state).toEqual({ location: 'rooftop' });
    });

    it('preserves other state keys alongside the corrected timestamp', () => {
        const parsed = parseSnippet(
            "[NARRATIVE]\nScene.\n\n[STATE]\ncurrent_date_time: 2024-12-03 06 Fri\nlocation: Vova's house",
        );
        expect(parsed.state.current_date_time).toBe('2024-12-03 06 Tue');
        expect(parsed.state.location).toBe("Vova's house");
    });

    it('keeps headerless key-value lines in narrative instead of guessing state', () => {
        const parsed = parseSnippet('[NARRATIVE]\nScene.\nlocation: rooftop\nbonds: wary');

        expect(parsed).toEqual({
            narrative: 'Scene.\nlocation: rooftop\nbonds: wary',
            state: {},
        });
    });
});
