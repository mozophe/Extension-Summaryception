import { executeSlashCommandsWithOptions, getChat, saveChat } from '../foundation/context.js';
import { warn } from '../foundation/logger.js';
import { getChatStore } from '../foundation/state.js';

/**
 * Check whether a hidden message is no longer owned by Summaryception.
 *
 * Ownership is recorded twice: on the message as `extra.sc_ghosted`, and in
 * chat metadata as `store.ghostedIndices`. An orphan is an index the metadata
 * still claims whose message has lost the marker. Without the metadata check
 * this matches every message any other extension hid, and every manual /hide
 * on a character message — and repair unhides and saves, so it sticks.
 * @param {ChatMessage | undefined} message
 * @param {number} index
 * @param {SummaryceptionStore} store
 * @returns {boolean}
 */
export function isOrphanedHiddenMessage(message, index, store) {
    return Boolean(
        message &&
        (message.is_system || message.is_hidden) &&
        !message.is_user &&
        !message.extra?.sc_ghosted &&
        store?.ghostedIndices?.includes(index) &&
        message.mes &&
        message.mes.trim().length > 0,
    );
}

/**
 * Scan the chat for orphaned hidden messages and unhide them.
 * @param {{ onProgress?: (repaired: number) => void }} [options]
 * @returns {Promise<{ status: 'repaired' | 'none', repaired: number }>}
 */
export async function repairOrphanedMessages({ onProgress = () => {} } = {}) {
    const chat = getChat();
    const store = getChatStore();
    let repaired = 0;

    for (let i = 0; i < chat.length; i++) {
        if (!isOrphanedHiddenMessage(chat[i], i, store)) {
            continue;
        }

        await repairOrphanedMessage(chat[i], i);
        repaired++;
        onProgress(repaired);
    }

    if (repaired === 0) {
        return { status: 'none', repaired };
    }

    await saveChatAfterRepair();
    return { status: 'repaired', repaired };
}

async function repairOrphanedMessage(message, index) {
    try {
        await executeSlashCommandsWithOptions(`/unhide ${index}`, { showOutput: false });
    } catch (e) {
        warn(`Repair: failed to unhide ${index}:`, e);
    }

    message.is_system = false;
    delete message.is_hidden;
}

async function saveChatAfterRepair() {
    try {
        await saveChat();
    } catch (e) {
        warn('Could not save chat:', e);
    }
}
