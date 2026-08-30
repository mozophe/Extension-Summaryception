import { getChat } from '../foundation/context.js';
import { rangesFromSortedIndices, resolveScIdsToIndices } from '../foundation/message-identity.js';
import { getChatStore } from '../foundation/state.js';
import { debug } from '../foundation/logger.js';
import { repairGhostingForRange } from './ghosting.js';

/**
 * Repair missing ghosting for surviving Layer 0 source messages.
 * @returns {Promise<boolean>} True when repair work was started.
 */
export async function repairMissingGhostingForSummaries() {
    const chat = getChat();
    const store = getChatStore();
    const sourceMessageIds = (store.layers[0] || []).flatMap(
        (snippet) => snippet.sourceMessageIds || [],
    );
    const indices = resolveScIdsToIndices(chat, sourceMessageIds);
    const ranges = rangesFromSortedIndices(indices);
    if (ranges.length === 0) {
        return false;
    }

    debug(`Repairing summarized ghosting for ${indices.length} surviving source messages.`);
    for (const [start, end] of ranges) {
        await repairGhostingForRange(start, end);
    }
    return true;
}
