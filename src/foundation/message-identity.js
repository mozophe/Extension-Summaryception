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
    chatMessage.sc_id = createUuid();
    return chatMessage.sc_id;
}

/**
 * Generate a v4 UUID. crypto.randomUUID only exists in secure contexts
 * (HTTPS or localhost); SillyTavern served over plain HTTP on a LAN lacks it,
 * so fall back to getRandomValues, which is available everywhere.
 * @returns {string}
 */
export function createUuid() {
    const cryptoApi = globalThis.crypto;
    if (typeof cryptoApi?.randomUUID === 'function') {
        return cryptoApi.randomUUID();
    }
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
