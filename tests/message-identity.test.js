import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    ensureChatScIds,
    ensureMessageScId,
    getMessageIndexByScId,
    rangesFromSortedIndices,
    resolveScIdsToIndices,
} from '../src/foundation/message-identity.js';
import { makeMessage } from './test-helpers.js';

describe('message identity', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('assigns missing IDs and preserves top-level identity across extra replacement', () => {
        vi.spyOn(globalThis.crypto, 'randomUUID')
            .mockReturnValueOnce('message-1')
            .mockReturnValueOnce('message-2');
        const first = makeMessage({ scId: undefined });
        const second = makeMessage({ scId: '' });
        const chat = [first, second, null];

        expect(ensureChatScIds(chat)).toBe(true);
        expect(first.sc_id).toBe('message-1');
        expect(second.sc_id).toBe('message-2');

        first.extra = { replacedBySwipe: true };
        expect(ensureMessageScId(first)).toBe('message-1');
        expect(ensureChatScIds(chat)).toBe(false);
    });

    it('keeps the first duplicate ID and resolves unique current indices in order', () => {
        const chat = [
            makeMessage({ scId: 'duplicate' }),
            makeMessage({ scId: 'message-1' }),
            makeMessage({ scId: 'duplicate' }),
            makeMessage({ scId: 'message-3' }),
        ];

        expect(getMessageIndexByScId(chat)).toEqual(
            new Map([
                ['duplicate', 0],
                ['message-1', 1],
                ['message-3', 3],
            ]),
        );
        expect(
            resolveScIdsToIndices(chat, ['message-3', 'missing', 'duplicate', 'message-3']),
        ).toEqual([0, 3]);
        expect(rangesFromSortedIndices([0, 1, 3])).toEqual([
            [0, 1],
            [3, 3],
        ]);
    });

    it('ignores non-message inputs', () => {
        expect(ensureMessageScId(null)).toBeNull();
        expect(ensureMessageScId([])).toBeNull();
        expect(ensureChatScIds('not-chat')).toBe(false);
    });
});
