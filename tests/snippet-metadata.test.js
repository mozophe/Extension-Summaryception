import { describe, expect, it } from 'vitest';

import {
    buildPromotedSnippetMetadata,
    extractSnippetMetadata,
    formatCompactSnippetAnchor,
    formatSnippetAnchor,
    getSnippetDisplayMeta,
} from '../src/core/snippet-metadata.js';
import { installSummaryContext, makeMessages } from './test-helpers.js';

describe('extractSnippetMetadata', () => {
    it('extracts source IDs and a known datetime', () => {
        expect(
            extractSnippetMetadata({
                sourceMessageIds: ['a', 'b'],
                currentDateTime: '2024-01-02 14',
            }),
        ).toEqual({ sourceMessageIds: ['a', 'b'], currentDateTime: '2024-01-02 14' });
    });

    it.each(['unknown', 'UNKNOWN', ''])('drops placeholder datetime (%s)', (currentDateTime) => {
        expect(
            extractSnippetMetadata({ sourceMessageIds: ['a'], currentDateTime }),
        ).not.toHaveProperty('currentDateTime');
    });
});

describe('buildPromotedSnippetMetadata', () => {
    it('unions source IDs in child order', () => {
        expect(
            buildPromotedSnippetMetadata([
                { sourceMessageIds: ['a', 'b'] },
                { sourceMessageIds: ['b', 'c'] },
            ]).sourceMessageIds,
        ).toEqual(['a', 'b', 'c']);
    });

    it('takes the last known datetime', () => {
        expect(
            buildPromotedSnippetMetadata([
                { currentDateTime: '2024-01-01 09' },
                { currentDateTime: '2024-01-03 20' },
            ]).currentDateTime,
        ).toBe('2024-01-03 20');
    });
});

describe('live metadata anchors', () => {
    it('resolves source IDs to current indices', () => {
        installSummaryContext({ chat: makeMessages(8) });
        const snippet = {
            sourceMessageIds: ['message-2', 'message-7'],
            currentDateTime: '2024-01-02 14',
        };

        expect(formatSnippetAnchor(snippet)).toBe('[msgs 2-7; current 2024-01-02 14]');
        expect(formatCompactSnippetAnchor(snippet)).toBe('[2-7@2024-01-02T14]');
    });

    it('omits anchors when no source ID resolves', () => {
        installSummaryContext({ chat: makeMessages(1) });
        expect(formatSnippetAnchor({ sourceMessageIds: ['missing'] })).toBe('');
    });
});

describe('getSnippetDisplayMeta', () => {
    it('derives counts from a source snippet', () => {
        expect(getSnippetDisplayMeta({ sourceMessageIds: ['a', 'b', 'c'] })).toEqual({
            sourceCount: 3,
            mergedCount: 0,
            fromLayer: undefined,
            promoted: false,
        });
    });

    it('derives merge provenance and promotion from a merged snippet', () => {
        expect(getSnippetDisplayMeta({ mergedCount: 4, fromLayer: 1, promoted: 1 })).toEqual({
            sourceCount: 0,
            mergedCount: 4,
            fromLayer: 1,
            promoted: true,
        });
    });

    it('derives safe defaults from a bare snippet', () => {
        expect(getSnippetDisplayMeta({})).toEqual({
            sourceCount: 0,
            mergedCount: 0,
            fromLayer: undefined,
            promoted: false,
        });
    });
});
