import { describe, expect, it } from 'vitest';

import { buildMemoryInjectionParts } from '../src/core/memory-injection.js';

/**
 * Build a Layer 0 snippet carrying a [NARRATIVE] and a compact [STATE] block.
 */
function snippetWithState(narrative, stateLines) {
    const state = stateLines.map((line) => line).join('\n');
    return {
        text: `[NARRATIVE]\n${narrative}\n[STATE]\n${state}`,
    };
}

describe('buildMemoryInjectionParts with injectCurrentState', () => {
    it('prepends the [CURRENT STATE] block by default', () => {
        const layers = [
            [
                snippetWithState('The party reached the tavern.', [
                    'location: tavern',
                    'mood: tense',
                ]),
            ],
        ];

        const parts = buildMemoryInjectionParts(layers);

        expect(parts.stateText).toContain('[CURRENT STATE]');
        expect(parts.memoryText).toContain('[CURRENT STATE]');
        expect(parts.memoryText).toContain('[CHRONOLOGY]');
    });

    it('drops the state block and keeps only chronology when injectCurrentState is false', () => {
        const layers = [
            [
                snippetWithState('The party reached the tavern.', [
                    'location: tavern',
                    'mood: tense',
                ]),
            ],
        ];

        const parts = buildMemoryInjectionParts(layers, { injectCurrentState: false });

        expect(parts.stateText).toBe('');
        expect(parts.memoryText).not.toContain('[CURRENT STATE]');
        expect(parts.memoryText).not.toContain('[STATE]');
        expect(parts.memoryText).toContain('[CHRONOLOGY]');
    });

    it('still reports the chronology parts when the state is suppressed', () => {
        const layers = [[snippetWithState('First beat.', ['location: tavern'])]];

        const parts = buildMemoryInjectionParts(layers, { injectCurrentState: false });

        expect(parts.chronologyParts).toHaveLength(1);
        expect(parts.chronologyParts[0].layerIndex).toBe(0);
        expect(parts.chronologyParts[0].text).toContain('First beat.');
    });
});
