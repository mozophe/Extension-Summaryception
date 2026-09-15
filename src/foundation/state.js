import {
    BATCH_TRIGGER_LIMITS,
    CACHE_TTL,
    EASY_CONTEXT_LIMITS,
    L0_SOURCE_LIMITS,
    MASK_USER_ROLE_MODES,
    MEMORY_MODE_PRESETS,
    MEMORY_MODES,
    MEMORY_POSITIONS,
    MEMORY_ROLES,
    MODULE_NAME,
    PROMOTION_PROMPT_PRESETS,
    PROMOTION_REPAIR_PROMPT_PRESETS,
    PROMOTION_SYSTEM_PROMPT_PRESETS,
    PROMPT_PRESETS,
    PROMPT_SETTING_KEYS,
    REQUEST_TIMEOUT,
    RETENTION_BUDGET_LIMITS,
    SUMMARIZER_REPAIR_PROMPT_PRESETS,
    SUMMARIZER_SYSTEM_PROMPT_PRESETS,
    UI_MODES,
    defaultSettings,
} from './constants.js';
import {
    getChatMetadata,
    getExtensionSettings,
    getName1,
    saveMetadata,
    saveSettingsDebounced,
} from './context.js';
import { resolveScIdsToIndices } from './message-identity.js';
import { clampInteger, clampToStep } from './numeric.js';

const PROMPT_PRESET_VALUES = Object.freeze(['narrative', 'custom']);

/**
 * Get the extension settings object.
 * @returns {ExtensionSettings} The current settings
 */
export function getSettings() {
    const extensionSettings = getExtensionSettings();
    if (!isPlainObject(extensionSettings[MODULE_NAME])) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    const settings = extensionSettings[MODULE_NAME];
    const settingsRecord = /** @type {Record<string, unknown>} */ (
        /** @type {unknown} */ (settings)
    );
    const defaultsRecord = /** @type {Record<string, unknown>} */ (defaultSettings);
    const hadUiMode = Object.hasOwn(settings, 'uiMode');
    const hadMaskUserRoleMode = Object.hasOwn(settings, 'maskUserRoleMode');
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(settings, key)) {
            settingsRecord[key] = defaultsRecord[key];
        }
    }
    const modeSettingsNormalized = normalizeModeSettings(settings, hadUiMode);
    const memorySettingsNormalized = normalizeMemorySettings(settings);
    const roleMaskSettingsNormalized = normalizeRoleMaskSettings(settings, hadMaskUserRoleMode);
    normalizeVerbatimWindowSettings(settings);
    normalizeRequestTimeouts(settings);
    const promptSettingsNormalized = normalizePromptSettings(settings);
    if (
        modeSettingsNormalized ||
        memorySettingsNormalized ||
        roleMaskSettingsNormalized ||
        promptSettingsNormalized
    ) {
        saveSettingsDebounced();
    }
    return settings;
}

/**
 * Get settings after applying the selected Easy/Advanced operating mode.
 * Runtime code should use this when behavior must follow the visible mode.
 * @returns {ExtensionSettings}
 */
export function getEffectiveSettings() {
    const settings = getSettings();
    return settings.uiMode === UI_MODES.OFF ? { ...settings, enabled: false } : settings;
}

/**
 *
 */
export function saveSettings() {
    saveSettingsDebounced();
}

/**
 * Keys a defaults reset never touches: the selected memory/UI/config modes,
 * every connection/merge/fallback route setting including per-route timeouts,
 * and debugMode (re-enabled explicitly after the reset loop).
 * @type {Set<string>}
 */
const RESET_PRESERVED_KEYS = new Set([
    'memoryMode',
    'uiMode',
    'configMode',
    'connectionSource',
    'connectionProfileId',
    'requestTimeoutSeconds',
    'mergeConnectionSource',
    'mergeConnectionProfileId',
    'mergeSummarizerResponseLength',
    'mergeRequestTimeoutSeconds',
    'fallbackConnectionSource',
    'fallbackConnectionProfileId',
    'fallbackSummarizerResponseLength',
    'fallbackRequestTimeoutSeconds',
    'debugMode',
]);

/** Preset text tables for each prompt profile, keyed by the profile's preset setting. */
const PROMPT_PRESET_TABLES = Object.freeze({
    summarizerSystemPromptPreset: SUMMARIZER_SYSTEM_PROMPT_PRESETS,
    promptPreset: PROMPT_PRESETS,
    summarizerRepairPromptPreset: SUMMARIZER_REPAIR_PROMPT_PRESETS,
    promotionSystemPromptPreset: PROMOTION_SYSTEM_PROMPT_PRESETS,
    promotionPromptPreset: PROMOTION_PROMPT_PRESETS,
    promotionRepairPromptPreset: PROMOTION_REPAIR_PROMPT_PRESETS,
});

/**
 * Reset every Prompt Profile to its default preset unless set to custom.
 * Custom profiles keep their edited text.
 * @param {ExtensionSettings} settings - Settings object mutated in place.
 * @returns {void}
 */
function resetPromptValues(settings) {
    const defaultsRecord = /** @type {Record<string, unknown>} */ (
        /** @type {unknown} */ (defaultSettings)
    );
    const settingsRecord = /** @type {Record<string, unknown>} */ (
        /** @type {unknown} */ (settings)
    );
    for (const { presetKey, settingKey } of PROMPT_SETTING_KEYS) {
        if (settingsRecord[presetKey] === 'custom') {
            continue;
        }
        const defaultPreset = defaultsRecord[presetKey];
        settingsRecord[presetKey] = defaultPreset;
        settingsRecord[settingKey] =
            PROMPT_PRESET_TABLES[presetKey][defaultPreset] || defaultsRecord[settingKey];
    }
}

/**
 * Reset all settings to their defaults in place, preserving the selected
 * modes, connection routes, and per-route timeouts. Prompt profiles return
 * to their default preset unless set to custom. Retention budgets follow the
 * preserved memory mode's preset, and debug output re-enables so F12
 * diagnostics stay available.
 * @returns {void}
 */
export function resetSettingsToDefaults() {
    const s = getSettings();
    const promptKeys = new Set(
        PROMPT_SETTING_KEYS.flatMap(({ presetKey, settingKey }) => [presetKey, settingKey]),
    );
    for (const key of Object.keys(defaultSettings)) {
        if (RESET_PRESERVED_KEYS.has(key) || promptKeys.has(key)) {
            continue;
        }
        const value = defaultSettings[key];
        s[key] = Array.isArray(value) ? [...value] : value;
    }

    resetPromptValues(s);

    // Retention budgets follow the preserved memory mode's preset, not the plain defaults.
    const retentionPreset = MEMORY_MODE_PRESETS[s.memoryMode] || MEMORY_MODE_PRESETS.balanced;
    s.verbatimTokenBudget = retentionPreset.verbatimTokenBudget;
    s.queuedTokenBudget = retentionPreset.queuedTokenBudget;

    // Debug output deliberately re-enables on reset so F12 diagnostics stay available.
    s.debugMode = true;
}

/**
 * Get the chat-specific summary store.
 * @returns {SummaryceptionStore}
 */
export function getChatStore() {
    const chatMetadata = getChatMetadata();
    if (!isPlainObject(chatMetadata[MODULE_NAME])) {
        chatMetadata[MODULE_NAME] = createDefaultChatStore();
    }
    return normalizeChatStore(chatMetadata[MODULE_NAME]);
}

/**
 *
 */
export async function saveChatStore() {
    getChatStore();
    await saveMetadata();
}

/**
 * Get the current summary-store mutation epoch.
 * @param {SummaryceptionStore} store
 * @returns {number}
 */
export function getSummaryStoreMutationEpoch(store) {
    return normalizeMutationEpoch(store?.mutationEpoch);
}

/**
 * Advance the summary-store mutation epoch after any store mutation.
 * @param {SummaryceptionStore} store
 * @returns {number}
 */
export function bumpSummaryStoreMutationEpoch(store) {
    store.mutationEpoch = getSummaryStoreMutationEpoch(store) + 1;
    return store.mutationEpoch;
}

/**
 * Collect unique snippet provenance ids across summary layers, keeping
 * first-seen order. Non-string and blank ids are skipped; ids are compared
 * and kept raw (never trimmed).
 * @param {Array<Array<SummaryceptionSnippet>> | null | undefined} layers
 * @param {{ layerIndex?: number }} [options] - Read only this layer when given.
 * @returns {string[]}
 */
export function collectSnippetSourceIds(layers, { layerIndex } = {}) {
    const sources = layerIndex === undefined ? layers || [] : [layers?.[layerIndex] || []];
    const ids = [];
    const seen = new Set();
    for (const layer of sources) {
        for (const snippet of layer || []) {
            for (const id of snippet?.sourceMessageIds || []) {
                if (typeof id !== 'string' || id.trim() === '' || seen.has(id)) {
                    continue;
                }
                seen.add(id);
                ids.push(id);
            }
        }
    }
    return ids;
}

/**
 * Resolve the highest current chat index owned by a Layer 0 snippet.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @returns {number}
 */
export function getCurrentSummarizedBoundary(chat, store) {
    const sourceMessageIds = collectSnippetSourceIds(store?.layers, { layerIndex: 0 });
    const indices = resolveScIdsToIndices(chat, sourceMessageIds);
    return indices.length > 0 ? indices[indices.length - 1] : -1;
}

/**
 * Normalize persisted chat metadata in place.
 * @param {SummaryceptionStore} store
 * @returns {SummaryceptionStore}
 */
function normalizeChatStore(store) {
    store.layers = normalizeLayers(store.layers);
    store.ghostedMessageIds = normalizeStringArray(store.ghostedMessageIds);
    store.mutationEpoch = normalizeMutationEpoch(store.mutationEpoch);
    return /** @type {SummaryceptionStore} */ (store);
}

/**
 * Normalize memory placement settings in place.
 * @param {ExtensionSettings} settings
 * @returns {boolean} Whether settings were changed.
 */
function normalizeMemorySettings(settings) {
    let changed = false;
    if (settings.memoryMode === 'append_only') {
        settings.memoryMode = MEMORY_MODES.PREFIX_CACHE;
        changed = true;
    }
    const validModes = [MEMORY_MODES.BALANCED, MEMORY_MODES.PREFIX_CACHE];
    if (!isSettingValue(validModes, settings.memoryMode)) {
        settings.memoryMode = defaultSettings.memoryMode;
        changed = true;
    }
    if (!isSettingValue(['default', 'profile'], settings.connectionSource)) {
        settings.connectionSource = defaultSettings.connectionSource;
        changed = true;
    }
    if (!isSettingValue(['inherit', 'profile'], settings.mergeConnectionSource)) {
        settings.mergeConnectionSource = defaultSettings.mergeConnectionSource;
        changed = true;
    }
    if (!isSettingValue(Object.values(MEMORY_POSITIONS), settings.customMemoryPosition)) {
        settings.customMemoryPosition = defaultSettings.customMemoryPosition;
        changed = true;
    }
    if (!isSettingValue(Object.values(MEMORY_ROLES), settings.customMemoryRole)) {
        settings.customMemoryRole = defaultSettings.customMemoryRole;
        changed = true;
    }
    const customMemoryDepth = clampInteger(settings.customMemoryDepth, 0, 10000);
    if (settings.customMemoryDepth !== customMemoryDepth) {
        settings.customMemoryDepth = customMemoryDepth;
        changed = true;
    }
    return changed;
}

/**
 * Normalize request-only user-role masking settings in place.
 * @param {ExtensionSettings} settings
 * @param {boolean} hadMode
 * @returns {boolean} Whether settings were changed.
 */
function normalizeRoleMaskSettings(settings, hadMode) {
    const validMode =
        hadMode && isSettingValue(Object.values(MASK_USER_ROLE_MODES), settings.maskUserRoleMode);
    if (validMode) {
        return false;
    }
    settings.maskUserRoleMode = defaultSettings.maskUserRoleMode;
    return true;
}

/**
 * Check whether a persisted setting is one of the allowed string values.
 * @param {ReadonlyArray<string>} values
 * @param {unknown} value
 * @returns {boolean}
 */
function isSettingValue(values, value) {
    return values.includes(String(value));
}

/**
 * Normalize retention settings in place.
 * @param {ExtensionSettings} settings
 * @returns {void}
 */
function normalizeVerbatimWindowSettings(settings) {
    settings.advancedModelContext = clampToStep(
        settings.advancedModelContext,
        EASY_CONTEXT_LIMITS.MIN,
        EASY_CONTEXT_LIMITS.MAX,
        EASY_CONTEXT_LIMITS.STEP,
    );
    settings.minSummaryTurns = clampInteger(settings.minSummaryTurns, 2, 10);
    settings.maxSummaryTurns = clampInteger(settings.maxSummaryTurns, 3, 20);
    settings.layer0SummaryTokenTarget = clampInteger(settings.layer0SummaryTokenTarget, 80, 700);
    settings.maxL0SourceTokens = clampToStep(
        settings.maxL0SourceTokens,
        L0_SOURCE_LIMITS.MIN,
        L0_SOURCE_LIMITS.MAX,
        L0_SOURCE_LIMITS.STEP,
    );
    settings.verbatimTokenBudget = clampToStep(
        settings.verbatimTokenBudget,
        RETENTION_BUDGET_LIMITS.MIN,
        RETENTION_BUDGET_LIMITS.MAX,
        RETENTION_BUDGET_LIMITS.STEP,
    );
    settings.queuedTokenBudget = clampToStep(
        settings.queuedTokenBudget,
        RETENTION_BUDGET_LIMITS.MIN,
        RETENTION_BUDGET_LIMITS.MAX,
        RETENTION_BUDGET_LIMITS.STEP,
    );
    settings.memoryTokenBudget = clampToStep(settings.memoryTokenBudget, 4000, 32000, 1000);
    settings.snippetsPerLayer = clampInteger(settings.snippetsPerLayer, 20, 40);
    settings.snippetsPerPromotion = clampInteger(settings.snippetsPerPromotion, 3, 4);
    settings.cacheTtlMinutes = clampToStep(
        settings.cacheTtlMinutes,
        CACHE_TTL.MIN_MINUTES,
        CACHE_TTL.MAX_MINUTES,
        CACHE_TTL.STEP_MINUTES,
    );
    enforceRetentionInvariants(settings);
}

/**
 * Enforce the cross-setting retention invariants: maxSummaryTurns never
 * drops below minSummaryTurns, and minSummaryBudget never exceeds the
 * Layer 0 source token cap. Mutates the settings object in place.
 * @param {ExtensionSettings} settings
 * @returns {void}
 */
export function enforceRetentionInvariants(settings) {
    if (settings.maxSummaryTurns < settings.minSummaryTurns) {
        settings.maxSummaryTurns = settings.minSummaryTurns;
    }
    const sourceCap = Math.max(
        L0_SOURCE_LIMITS.MIN,
        Number(settings.maxL0SourceTokens) || defaultSettings.maxL0SourceTokens,
    );
    settings.minSummaryBudget = clampToStep(
        settings.minSummaryBudget,
        BATCH_TRIGGER_LIMITS.MIN,
        Math.min(BATCH_TRIGGER_LIMITS.MAX, sourceCap),
        BATCH_TRIGGER_LIMITS.STEP,
    );
}

/**
 * Clamp the three per-route request timeout settings (in seconds) to the slider bounds.
 * Applies to Layer 0 (requestTimeoutSeconds), L1+ merge (mergeRequestTimeoutSeconds),
 * and the fallback route (fallbackRequestTimeoutSeconds).
 * @param {ExtensionSettings} settings
 * @returns {void}
 */
function normalizeRequestTimeouts(settings) {
    settings.requestTimeoutSeconds = clampToStep(
        settings.requestTimeoutSeconds,
        REQUEST_TIMEOUT.MIN_SECONDS,
        REQUEST_TIMEOUT.MAX_SECONDS,
        REQUEST_TIMEOUT.STEP_SECONDS,
    );
    settings.mergeRequestTimeoutSeconds = clampToStep(
        settings.mergeRequestTimeoutSeconds,
        REQUEST_TIMEOUT.MIN_SECONDS,
        REQUEST_TIMEOUT.MAX_SECONDS,
        REQUEST_TIMEOUT.STEP_SECONDS,
    );
    settings.fallbackRequestTimeoutSeconds = clampToStep(
        settings.fallbackRequestTimeoutSeconds,
        REQUEST_TIMEOUT.MIN_SECONDS,
        REQUEST_TIMEOUT.MAX_SECONDS,
        REQUEST_TIMEOUT.STEP_SECONDS,
    );
}

function normalizeModeSettings(settings, hadMode) {
    if (!hadMode || !isSettingValue(Object.values(UI_MODES), settings.uiMode)) {
        settings.uiMode = settings.enabled === false ? UI_MODES.OFF : defaultSettings.uiMode;
    }

    // configMode tracks the Easy/Advanced complexity panel independently of
    // on/off, so config stays visible (and editable) even when the extension
    // is off. Backfill from the current/active mode when it's a complexity
    // mode, else from the default.
    if (
        !Object.hasOwn(settings, 'configMode') ||
        !isSettingValue([UI_MODES.EASY, UI_MODES.ADVANCED], settings.configMode)
    ) {
        settings.configMode =
            settings.uiMode === UI_MODES.ADVANCED ? UI_MODES.ADVANCED : defaultSettings.configMode;
    }

    const nextEnabled = settings.uiMode !== UI_MODES.OFF;
    const changed = !hadMode || settings.enabled !== nextEnabled;
    settings.enabled = nextEnabled;
    return changed;
}

function deriveEasySourceCap(contextTokens) {
    const context = clampToStep(
        contextTokens,
        EASY_CONTEXT_LIMITS.MIN,
        EASY_CONTEXT_LIMITS.MAX,
        EASY_CONTEXT_LIMITS.STEP,
    );
    return Math.min(
        L0_SOURCE_LIMITS.MAX,
        Math.max(L0_SOURCE_LIMITS.MIN, Math.floor(context * 0.5)),
    );
}

/**
 * Derive Advanced engine mechanics from the model-context field.
 * Mutates settings in place. Fires only when the user edits Model context.
 * @param {ExtensionSettings} settings
 * @returns {void}
 */
export function deriveAdvancedEngineTuning(settings) {
    const sourceCap = deriveEasySourceCap(settings.advancedModelContext);
    settings.maxL0SourceTokens = sourceCap;
    settings.minSummaryBudget = Math.min(BATCH_TRIGGER_LIMITS.MAX, sourceCap);
    settings.layer0SummaryTokenTarget = clampToStep(
        Number(settings.memoryTokenBudget) * 0.02,
        80,
        700,
        10,
    );
}

function normalizePromptSettings(settings) {
    let changed = false;
    for (const binding of PROMPT_SETTING_KEYS) {
        const defaults = /** @type {Record<string, unknown>} */ (defaultSettings);
        const settingsRecord = /** @type {Record<string, unknown>} */ (
            /** @type {unknown} */ (settings)
        );
        const preset = settingsRecord[binding.presetKey];
        const isCustom = preset === 'custom';

        if (!isSettingValue(PROMPT_PRESET_VALUES, preset)) {
            settingsRecord[binding.presetKey] = defaults[binding.presetKey];
            settingsRecord[binding.settingKey] = defaults[binding.settingKey];
            changed = true;
            continue;
        }

        const promptText = settingsRecord[binding.settingKey];
        if (isCustom && typeof promptText === 'string' && promptText.trim()) {
            continue;
        }

        if (settingsRecord[binding.presetKey] !== defaults[binding.presetKey]) {
            settingsRecord[binding.presetKey] = defaults[binding.presetKey];
            changed = true;
        }
        if (settingsRecord[binding.settingKey] !== defaults[binding.settingKey]) {
            settingsRecord[binding.settingKey] = defaults[binding.settingKey];
            changed = true;
        }
    }
    return changed;
}

/**
 * Normalize layer arrays and drop malformed snippets.
 * @param {unknown} layers
 * @returns {Array<Array<SummaryceptionSnippet>>}
 */
function normalizeLayers(layers) {
    if (!Array.isArray(layers)) {
        return [];
    }
    return layers.map((layer) => {
        if (!Array.isArray(layer)) {
            return [];
        }
        return layer.filter(isValidSnippet).map(normalizeSnippet);
    });
}

function createDefaultChatStore() {
    return {
        layers: [],
        ghostedMessageIds: [],
        mutationEpoch: 0,
    };
}

/**
 * Check whether a persisted snippet is usable.
 * @param {unknown} snippet
 * @returns {snippet is SummaryceptionSnippet}
 */
export function isValidSnippet(snippet) {
    return (
        isPlainObject(snippet) &&
        typeof snippet.text === 'string' &&
        normalizeStringArray(snippet.sourceMessageIds).length > 0
    );
}

function normalizeSnippet(snippet) {
    snippet.sourceMessageIds = normalizeStringArray(snippet.sourceMessageIds);
    return snippet;
}

/**
 * Check whether a value is a plain object record.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Normalize a stable message ID array.
 * @param {unknown} values
 * @returns {string[]}
 */
function normalizeStringArray(values) {
    if (!Array.isArray(values)) {
        return [];
    }
    const result = [];
    const seen = new Set();
    for (const value of values) {
        if (typeof value !== 'string' || value.trim() === '' || seen.has(value)) {
            continue;
        }
        seen.add(value);
        result.push(value);
    }
    return result;
}

/**
 * Normalize the summary-layer mutation epoch.
 * @param {unknown} value
 * @returns {number}
 */
function normalizeMutationEpoch(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        return 0;
    }
    return Math.max(0, value);
}

/**
 * Get the player's display name.
 * @returns {string} The player name from ST context, or 'User' as fallback
 */
export function getPlayerName() {
    return getName1();
}
