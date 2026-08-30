import { describe, expect, it } from 'vitest';

import {
    findLastMessage,
    getAssistantTurns,
    getPromptDepthsByChatIndex,
    getVisibleAssistantTurns,
    isSummarizerConversationMessage,
    iterateChatRange,
} from '../src/core/chatutils.js';
import {
    installSummaryContext,
    makeMessage,
    makeMessages,
    makeSummaryStore,
} from './test-helpers.js';

describe('getAssistantTurns', () => {
    it('collects non-system assistant turns with their indices and preserved text', () => {
        const chat = [
            makeMessage({ isUser: true, mes: 'hi' }),
            makeMessage({ mes: 'I am assistant one.' }),
            makeMessage({ isSystem: true, mes: 'system note' }),
            makeMessage({ mes: 'I am assistant two.' }),
        ];
        installSummaryContext({ chat });
        const turns = getAssistantTurns(chat);
        expect(turns).toHaveLength(2);
        expect(turns[0].index).toBe(1);
        expect(turns[0].mes).toBe('I am assistant one.');
        expect(turns[1].index).toBe(3);
        expect(turns[1].mes).toBe('I am assistant two.');
    });

    it('excludes hidden and system records from assistant turns', () => {
        const hidden = makeMessage({ isHidden: true, mes: 'hidden' });
        const system = makeMessage({ isSystem: true, mes: 'system' });
        installSummaryContext({ chat: [hidden, system] });

        expect(getAssistantTurns([hidden, system])).toEqual([]);
    });

    it('skips empty/whitespace messages and defaults a missing name', () => {
        // Whitespace-only assistant message is dropped.
        installSummaryContext({ chat: [] });
        const whitespace = getAssistantTurns([makeMessage({ mes: '   ' })]);
        expect(whitespace).toHaveLength(0);

        // A bare assistant message without a name field defaults to 'Assistant'.
        const bare = getAssistantTurns([{ is_user: false, is_system: false, mes: 'hi' }]);
        expect(bare).toHaveLength(1);
        expect(bare[0].name).toBe('Assistant');
    });
});

describe('isSummarizerConversationMessage', () => {
    it('includes only visible user and assistant conversation records', () => {
        const records = [
            makeMessage({ isUser: true, mes: 'user' }),
            makeMessage({ mes: 'assistant' }),
            { ...makeMessage({ mes: 'tool' }), extra: { type: 'tool' } },
            makeMessage({ isSystem: true, mes: 'system' }),
            makeMessage({ isHidden: true, mes: 'hidden' }),
            makeMessage({ mes: '   ' }),
        ];

        expect(records.filter(isSummarizerConversationMessage)).toEqual(records.slice(0, 2));
    });
});

describe('getVisibleAssistantTurns', () => {
    it('returns non-user non-system non-owned assistant turns', () => {
        const owned = makeMessage({ mes: 'ghosted assistant' });
        const chat = [
            makeMessage({ mes: 'plain assistant' }),
            owned,
            makeMessage({ isSystem: true, mes: 'system' }),
            makeMessage({ isUser: true, mes: 'user' }),
        ];
        installSummaryContext({
            chat,
            metadata: { summaryception: makeSummaryStore({ ghostedMessageIds: [owned.sc_id] }) },
        });
        const turns = getVisibleAssistantTurns(chat);
        expect(turns).toHaveLength(1);
        expect(turns[0].mes).toBe('plain assistant');

        // The contract contrast being defended: the ghost flag excludes a
        // turn from getVisibleAssistantTurns but the SAME turn stays in
        // getAssistantTurns (ghosted-away turns still count as assistant turns).
        expect(getAssistantTurns(chat)).toHaveLength(2);
    });
});

describe('iterateChatRange', () => {
    it('iterates forward across an inclusive mid-array range yielding {index, message} pairs', () => {
        const chat = makeMessages(5);
        const out = [...iterateChatRange(chat, 1, 3)];
        expect(out.map((e) => e.index)).toEqual([1, 2, 3]);
        // The yielded message is the exact array element, not a copy.
        expect(out[1].message).toBe(chat[2]);
    });

    it('iterates backward when start exceeds end', () => {
        const chat = makeMessages(5);
        const indices = [...iterateChatRange(chat, 3, 1)].map((e) => e.index);
        expect(indices).toEqual([3, 2, 1]);
    });

    it('clamps bounds into the valid index range', () => {
        const chat = makeMessages(4);
        const allForward = [...iterateChatRange(chat, 0, 99)].map((e) => e.index);
        expect(allForward).toEqual([0, 1, 2, 3]);
        const clampedLow = [...iterateChatRange(chat, -5, 2)].map((e) => e.index);
        expect(clampedLow).toEqual([0, 1, 2]);
    });

    it('yields nothing for empty/non-array chats or non-finite bounds, and one entry for a single-point range', () => {
        expect([...iterateChatRange([], 0, 3)]).toHaveLength(0);
        const chat = makeMessages(3);
        expect([...iterateChatRange(chat, NaN, 2)]).toHaveLength(0);
        expect([...iterateChatRange(chat, 2, 2)]).toHaveLength(1);
    });
});

describe('getPromptDepthsByChatIndex', () => {
    it('skips system messages and assigns depth by distance from the last non-system message', () => {
        const chat = [
            makeMessage({ mes: 'a' }), // index 0, non-system
            makeMessage({ isSystem: true, mes: 'sys' }), // index 1, system; absent from map
            makeMessage({ mes: 'b' }), // index 2
            makeMessage({ mes: 'c' }), // index 3, last non-system, depth 0
        ];
        const depths = getPromptDepthsByChatIndex(chat);
        // System index is not a key.
        expect(depths.has(1)).toBe(false);
        expect([...depths.keys()].sort((x, y) => x - y)).toEqual([0, 2, 3]);
        // Depth grows with distance from the last prompt-visible message.
        expect(depths.get(3)).toBe(0);
        expect(depths.get(2)).toBe(1);
        expect(depths.get(0)).toBe(2);
    });
});

describe('findLastMessage', () => {
    it('scans backward for the latest matching message and respects the minIndex floor', () => {
        const chat = [
            makeMessage({ mes: 'a' }),
            makeMessage({ isUser: true, mes: 'u1' }), // index 1
            makeMessage({ mes: 'b' }),
            makeMessage({ isUser: true, mes: 'u2' }), // index 3
            makeMessage({ mes: 'c' }), // index 4
        ];
        const isUser = (m) => m.is_user;

        // Backward scan from 4 finds the latest user at index 3.
        expect(findLastMessage(chat, 4, isUser)?.index).toBe(3);
        // minIndex=2 still permits reaching index 3.
        expect(findLastMessage(chat, 4, isUser, 2)?.index).toBe(3);
        // minIndex above the latest match finds nothing.
        expect(findLastMessage(chat, 4, isUser, 4)).toBeNull();
        // startIndex below minIndex short-circuits.
        expect(findLastMessage(chat, 1, isUser, 3)).toBeNull();
        // No predicate match at all.
        expect(findLastMessage(chat, 0, () => false)).toBeNull();
    });
});
