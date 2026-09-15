import { MODULE_NAME } from '../foundation/constants.js';
import { getChat, getChatMetadata, saveChat, saveMetadata } from '../foundation/context.js';
import { error, info } from '../foundation/logger.js';
import { refreshUi } from '../foundation/refresh.js';
import { getChatStore, isValidSnippet } from '../foundation/state.js';
import { commitSnippetMutation } from '../core/snippet-commit.js';

// ─── Memory Clear Workflow ───────────────────────────────────────────

/**
 * Clear all Summaryception memory for the current chat and unghost all messages.
 * Shared between the UI button handler and the /sc-clear slash command.
 * @param {{ updateUi?: boolean }} [opts]
 */
export async function clearSummaryceptionMemory(
    /** @type {{ updateUi?: boolean }} */ { updateUi = false } = {},
) {
    const store = getChatStore();
    await commitSnippetMutation(
        store,
        () => {
            store.layers.length = 0;
        },
        { ghost: 'clear', chatSave: 'none' },
    );
    if (updateUi) {
        refreshUi();
    }

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

// ─── Memory Import Workflow ──────────────────────────────────────────

/**
 * Check an imported payload's shape before any store mutation: layers must be
 * an array of snippet arrays, each snippet passing the persisted-snippet
 * check, plus a ghosted-ID array. Rejects before getChatStore() touches
 * chat metadata.
 * @param {any} data - Parsed JSON payload
 * @returns {boolean} True when the payload carries valid layers and ghosted IDs
 */
function validateImportPayload(data) {
    return (
        Array.isArray(data?.layers) &&
        Array.isArray(data.ghostedMessageIds) &&
        data.layers.every((layer) => Array.isArray(layer) && layer.every(isValidSnippet))
    );
}

/**
 * Import summary memory from a parsed JSON export into the current chat store.
 * Unlike clearSummaryceptionMemory, which throws to its caller, invalid
 * payloads are a guard rather than a fault, so every outcome arrives as a
 * structured status for the entry layer to notice.
 * @param {any} data - Parsed JSON payload
 * @param {{ notify?: import('../core/notify.js').NotifyAdapter }} [opts]
 * @returns {Promise<{ status: 'imported', count: number } | { status: 'invalid' } | { status: 'failed', cause: unknown }>}
 */
export async function importSummaryceptionMemory(data, { notify } = {}) {
    if (!validateImportPayload(data)) {
        return { status: 'invalid' };
    }

    try {
        const store = getChatStore();
        await commitSnippetMutation(
            store,
            () => {
                store.layers = data.layers;
            },
            { notify, chatSave: 'immediate' },
        );
        refreshUi();
        const count = store.layers.reduce((sum, layer) => sum + (layer?.length || 0), 0);
        return { status: 'imported', count };
    } catch (err) {
        error(err);
        return { status: 'failed', cause: err };
    }
}
