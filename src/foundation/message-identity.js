// Stable per-message identity and runtime index resolution.

/**
 * Ensure one chat message has a Summaryception-owned ID.
 * @param {ChatMessage | unknown} message
 * @returns {string | null}
 */
export function ensureMessageScId(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return null;
    }
    const chatMessage = /** @type {ChatMessage} */ (message);
    if (typeof chatMessage.sc_id === 'string' && chatMessage.sc_id.trim() !== '') {
        return chatMessage.sc_id;
    }
    chatMessage.sc_id = globalThis.crypto.randomUUID();
    return chatMessage.sc_id;
}

/**
 * Ensure every object message in a chat has a stable ID.
 * @param {ChatMessage[] | unknown} chat
 * @returns {boolean} Whether any message changed.
 */
export function ensureChatScIds(chat) {
    if (!Array.isArray(chat)) {
        return false;
    }
    let changed = false;
    for (const message of chat) {
        const previousId = message?.sc_id;
        const id = ensureMessageScId(message);
        if (id !== null && id !== previousId) {
            changed = true;
        }
    }
    return changed;
}

/**
 * Map stable message IDs to their first current chat index.
 * @param {ChatMessage[] | unknown} chat
 * @returns {Map<string, number>}
 */
export function getMessageIndexByScId(chat) {
    const indices = new Map();
    if (!Array.isArray(chat)) {
        return indices;
    }
    for (let index = 0; index < chat.length; index++) {
        const id = chat[index]?.sc_id;
        if (typeof id === 'string' && id.trim() !== '' && !indices.has(id)) {
            indices.set(id, index);
        }
    }
    return indices;
}

/**
 * Resolve stable message IDs to sorted current chat indices.
 * @param {ChatMessage[] | unknown} chat
 * @param {unknown} ids
 * @returns {number[]}
 */
export function resolveScIdsToIndices(chat, ids) {
    if (!Array.isArray(ids)) {
        return [];
    }
    const messageIndices = getMessageIndexByScId(chat);
    const seenIds = new Set();
    const indices = [];
    for (const id of ids) {
        if (typeof id !== 'string' || id.trim() === '' || seenIds.has(id)) {
            continue;
        }
        seenIds.add(id);
        const index = messageIndices.get(id);
        if (index !== undefined) {
            indices.push(index);
        }
    }
    return indices.sort((a, b) => a - b);
}

/**
 * Convert sorted indices into contiguous ranges.
 * @param {number[]} indices
 * @returns {Array<[number, number]>}
 */
export function rangesFromSortedIndices(indices) {
    /** @type {Array<[number, number]>} */
    const ranges = [];
    for (const index of indices) {
        const last = ranges[ranges.length - 1];
        if (last && index === last[1] + 1) {
            last[1] = index;
        } else {
            ranges.push([index, index]);
        }
    }
    return ranges;
}
