import { MODULE_NAME } from '../foundation/constants.js';
import {
    executeSlashCommandsWithOptions,
    getChat,
    getChatMetadata,
    saveChat,
    saveMetadata,
} from '../foundation/context.js';
import { info } from '../foundation/logger.js';
import { bumpSummaryStoreMutationEpoch, getChatStore } from '../foundation/state.js';
import { refreshExtensionState } from './persist.js';

// ─── Memory Clear Workflow ───────────────────────────────────────────

/**
 * Clear all Summaryception memory for the current chat and unghost all messages.
 * Shared between the UI button handler and the /sc-clear slash command.
 * @param {{ updateUi?: boolean }} [opts]
 */
export async function clearSummaryceptionMemory(
    /** @type {{ updateUi?: boolean }} */ { updateUi = false } = {},
) {
    const chat = getChat();
    if (chat.length > 0) {
        await executeSlashCommandsWithOptions(`/unhide 0-${chat.length - 1}`, {
            showOutput: false,
        });
    }
    const store = getChatStore();
    store.layers.length = 0;
    store.ghostedMessageIds = [];
    bumpSummaryStoreMutationEpoch(store);
    refreshExtensionState({ injection: true, ui: updateUi });

    delete getChatMetadata()[MODULE_NAME];
    for (const message of getChat()) {
        delete message.sc_id;
        for (const key of Object.keys(message.extra || {})) {
            if (key.startsWith('sc_')) {
                delete message.extra?.[key];
            }
        }
    }

    await saveMetadata();
    await saveChat();
    info('Memory and Summaryception chat metadata cleared; all messages unhidden.');
}
