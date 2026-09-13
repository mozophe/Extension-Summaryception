import { defaultSettings } from '../foundation/constants.js';
import { getActiveLineCap } from '../foundation/state-categories.js';
import { countTextTokens } from './token-count.js';
import { parseStateBlock } from './summarizer-state.js';

export const STATE_KEY_CEILING = 12;
export const TOKENS_PER_SENTENCE = 35;
export const LAYER_MIN_RATIO = { l0: 0.4, l1: 0.4, l2: 0.3 };
export const LAYER_HARD_MAX_RATIO = { l0: 1.5, l1: 1.75, l2: 1.5 };
export const LAYER0_REPAIR_RATIO = 1.65;
export const LAYER_SAFETY_MULTIPLIER = { l0: 0.85, l1: 0.5, l2: 0.5 };

/**
 * Maximum number of `[STATE]` key:value lines the model should emit.
 * @param {number | undefined} sourceStateKeyCount
 * @returns {number}
 */
export function computeStateLineCap(sourceStateKeyCount) {
    const count = Number(sourceStateKeyCount);
    if (!Number.isFinite(count) || count <= 0) {
        return STATE_KEY_CEILING;
    }
    return Math.min(count, STATE_KEY_CEILING);
}

/**
 * Integer sentence cap for a layer, anchored to slider target T.
 * @param {'l0' | 'l1' | 'l2' | number} layer
 * @param {number | undefined} targetTokens
 * @returns {number}
 */
export function computeSentenceCap(layer, targetTokens) {
    const key = getLayerKey(layer);
    const target = Number(targetTokens);
    if (!Number.isFinite(target) || target <= 0) {
        return 1;
    }
    const raw = Math.floor(
        (LAYER_HARD_MAX_RATIO[key] * target * LAYER_SAFETY_MULTIPLIER[key]) / TOKENS_PER_SENTENCE,
    );
    return Math.max(1, raw);
}

/**
 * @param {'l0' | 'l1' | 'l2' | number} layer
 * @returns {'l0' | 'l1' | 'l2'}
 */
function getLayerKey(layer) {
    if (layer === 'l0' || layer === 0) {
        return 'l0';
    }
    if (layer === 'l1') {
        return 'l1';
    }
    return 'l2';
}

/**
 * Format a countable size-cap line shared by L0 and L1+ prompt blocks.
 * @param {object} p
 * @param {string} p.label
 * @param {number} p.cap
 * @param {string} p.unit
 * @param {string} [p.verb]
 * @param {string} [p.extra]
 * @returns {string}
 */
export function buildSizeTargetLine({ label, cap, unit, verb = '', extra = '' }) {
    const verbClause = verb ? `${verb} ` : '';
    const base = `${label}: ${verbClause}at most ${cap} ${unit}.`;
    return extra ? `${base} ${extra}` : base;
}

/**
 * Format the standalone size-constraints block appended to a prompt.
 * @param {object} p
 * @param {string} p.wrapperTag
 * @param {string} p.targetLine
 * @param {string} [p.repairLine]
 * @returns {string}
 */
export function buildSizeConstraintsBlock({ wrapperTag, targetLine, repairLine = '' }) {
    return `<${wrapperTag}>\n${targetLine}\n${repairLine}</${wrapperTag}>`;
}

/**
 * Build the Layer 0 model-countable source budget block.
 * @param {object} p
 * @param {number} p.sourceStateTokens
 * @param {number} p.sourceStateKeyCount
 * @param {number} p.targetTokens
 * @param {ExtensionSettings} p.settings
 * @returns {string}
 */
export function buildLayer0BudgetHint({
    sourceStateTokens,
    sourceStateKeyCount,
    targetTokens,
    settings,
}) {
    const sentenceCap = computeSentenceCap('l0', targetTokens);
    const hasState = Number(sourceStateTokens) > 0;
    const stateLineCap = hasState
        ? computeStateLineCap(sourceStateKeyCount)
        : getActiveLineCap(settings, STATE_KEY_CEILING);
    const existingStateLine = hasState
        ? `Existing [STATE]: ${sourceStateKeyCount} keys.`
        : 'No existing [STATE] yet; build the first snapshot.';

    return [
        '<summaryception_source_budget>',
        'Compress the source passage hard.',
        buildSizeTargetLine({
            label: '[NARRATIVE]',
            verb: 'write',
            cap: sentenceCap,
            unit: 'sentences',
        }),
        existingStateLine,
        buildSizeTargetLine({
            label: '[STATE]',
            verb: 'rewrite the full snapshot;',
            cap: stateLineCap,
            unit: 'lines',
        }),
        '</summaryception_source_budget>',
    ].join('\n');
}

/**
 * Resolve the source-side token count for a summarizer call.
 * @param {{ sourceTokensBefore?: number, regexStats?: { finalTokens?: number }, memoryTokensBefore?: number }} [metadata]
 * @returns {number}
 */
export function getSourceTokenCount(metadata = {}) {
    const candidates = [
        metadata.sourceTokensBefore,
        metadata.regexStats?.finalTokens,
        metadata.memoryTokensBefore,
    ];
    for (const value of candidates) {
        const count = Number(value);
        if (Number.isFinite(count) && count > 0) {
            return count;
        }
    }
    return 0;
}

/**
 * Compute narrative and prior-state token counts for a Layer 0 call.
 * @param {object} p
 * @param {number} p.sourceNarrativeTokens
 * @param {string} p.sourceStateText
 * @returns {Promise<{ narrativeTokens: number, stateTokens: number, stateKeyCount: number }>}
 */
export async function countLayer0SourceBudget({ sourceNarrativeTokens, sourceStateText }) {
    const narrativeValue = Number(sourceNarrativeTokens);
    const narrativeTokens = Number.isFinite(narrativeValue) ? narrativeValue : 0;
    const stateText = String(sourceStateText || '').trim();
    if (!stateText) {
        return { narrativeTokens, stateTokens: 0, stateKeyCount: 0 };
    }

    const stateTokens = (await countTextTokens(stateText)).count;
    return {
        narrativeTokens,
        stateTokens,
        stateKeyCount: Object.keys(parseStateBlock(stateText).state).length,
    };
}

/** Overhead of the surrounding SillyTavern prompt in the main-request preview. */
const PREVIEW_BASE_PROMPT_OVERHEAD = 2000;
/** Fixed allowance for deep-layer snippets in the L1 preview line. */
const PREVIEW_DEEP_MEMORY_OVERHEAD = 1000;

/**
 * Estimate the injected-context sizes shown by the settings preview panel.
 * @param {ReturnType<typeof import('../foundation/state.js').getSettings>} settings
 * @returns {{ rawChatMin: number, rawChatMax: number, mainMin: number, mainMax: number, l0Typical: number, l0Max: number, l1Total: number }}
 */
export function estimateContextPreview(settings) {
    const memoryBudget = readTokenSetting(settings, 'memoryTokenBudget');
    const verbatimBudget = readTokenSetting(settings, 'verbatimTokenBudget');
    const queuedBudget = readTokenSetting(settings, 'queuedTokenBudget');
    const minL0Source = readTokenSetting(settings, 'minSummaryBudget');
    const maxL0Source = readTokenSetting(settings, 'maxL0SourceTokens');
    const snippetsPerPromotion = readTokenSetting(settings, 'snippetsPerPromotion');
    const summaryTarget = readTokenSetting(settings, 'layer0SummaryTokenTarget');
    return {
        rawChatMin: verbatimBudget,
        rawChatMax: verbatimBudget + queuedBudget,
        mainMin: memoryBudget + verbatimBudget,
        mainMax: memoryBudget + verbatimBudget + queuedBudget,
        l0Typical: minL0Source + memoryBudget + PREVIEW_BASE_PROMPT_OVERHEAD,
        l0Max: maxL0Source + memoryBudget + PREVIEW_BASE_PROMPT_OVERHEAD,
        l1Total:
            snippetsPerPromotion * summaryTarget +
            Math.round(memoryBudget * LAYER_SAFETY_MULTIPLIER.l1) +
            PREVIEW_DEEP_MEMORY_OVERHEAD,
    };
}

/**
 * Read a numeric token setting, falling back to its default when unset or invalid.
 * @param {object} settings
 * @param {string} key
 * @returns {number}
 */
function readTokenSetting(settings, key) {
    const number = Number(settings[key]);
    return Number.isFinite(number) ? number : defaultSettings[key];
}
