import { describe, expect, it } from 'vitest';

import { repairOrphanedMessages } from '../src/features/maintenance.js';
import { makeMessage, makeSummaryStore, installSummaryContext } from './test-helpers.js';

/**
 * Orphan repair exists to recover messages Summaryception hid and then lost the
 * `sc_ghosted` marker for. Ownership is recorded twice: on the message as
 * `extra.sc_ghosted`, and in chat metadata as `store.ghostedIndices`. A genuine
 * orphan is an index the metadata still claims whose message no longer carries
 * the marker.
 *
 * "Hidden and not mine" is not the same statement. Every other extension that
 * hides a message, and every manual /hide on a character message, matches it —
 * and repair unhides and saves, so the damage persists.
 */
describe('orphaned hidden message repair', () => {
    it('leaves hidden messages Summaryception never ghosted alone', async () => {
        const chat = [
            makeMessage({ mes: 'turn zero' }),
            makeMessage({
                isSystem: true,
                mes: '![generated image](/user/images/Yelena/imagine_1787168510390_0.webp)',
                name: 'Camera',
            }),
        ];
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });

        const result = await repairOrphanedMessages();

        expect(chat[1].is_system).toBe(true);
        expect(result).toEqual({ status: 'none', repaired: 0 });
    });

    it('leaves a manually hidden character message alone', async () => {
        const chat = [
            makeMessage({ mes: 'turn zero' }),
            makeMessage({ isSystem: true, mes: 'hidden by hand' }),
        ];
        installSummaryContext({ chat, metadata: { summaryception: makeSummaryStore() } });

        await repairOrphanedMessages();

        expect(chat[1].is_system).toBe(true);
    });

    it('unhides a message it ghosted whose ownership marker was lost', async () => {
        const chat = [
            makeMessage({ mes: 'turn zero' }),
            makeMessage({ isSystem: true, mes: 'summarized turn' }),
        ];
        installSummaryContext({
            chat,
            metadata: { summaryception: makeSummaryStore({ ghostedIndices: [1] }) },
        });

        const result = await repairOrphanedMessages();

        expect(chat[1].is_system).toBe(false);
        expect(result).toEqual({ status: 'repaired', repaired: 1 });
    });

    it('leaves a ghosted message that still carries its marker alone', async () => {
        const chat = [
            makeMessage({ mes: 'turn zero' }),
            makeMessage({ isSystem: true, mes: 'summarized turn', ghosted: true }),
        ];
        installSummaryContext({
            chat,
            metadata: { summaryception: makeSummaryStore({ ghostedIndices: [1] }) },
        });

        await repairOrphanedMessages();

        expect(chat[1].is_system).toBe(true);
    });
});
