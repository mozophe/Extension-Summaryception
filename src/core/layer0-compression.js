import { defaultSettings } from '../foundation/constants.js';
import {
    STATE_SNAPSHOT_MAX_TOKENS,
    STATE_SNAPSHOT_SOFT_TARGET_TOKENS,
} from '../foundation/prompt-constants.js';
import {
    buildRepairDiagnostics,
    countSentences,
    formatRepairDiagnostics,
} from './repair-diagnostics.js';
import {
    insertBeforeTrigger,
    EXECUTION_TRIGGER_L0,
    EXECUTION_TRIGGER_PROMO,
} from '../foundation/prompt-parts.js';
import {
    buildSizeConstraintsBlock,
    buildSizeTargetLine,
    computeSentenceCap,
    LAYER_HARD_MAX_RATIO,
    LAYER_MIN_RATIO,
    LAYER0_REPAIR_RATIO,
} from './token-budget.js';

const MIN_LAYER0_TARGET_TOKENS = 80;
const MIN_LAYER0_OUTPUT_TOKENS = 50;
const MAX_LAYER0_TARGET_TOKENS = 700;

/**
 * Check whether a summarizer call should receive runtime compression controls.
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [metadata]
 * @returns {boolean}
 */
export function isLayer0CompressionCall(metadata = {}) {
    return (
        metadata.kind === 'layer0' ||
        metadata.kind === 'regenerate' ||
        metadata.kind === 'promotion'
    );
}

/**
 * Normalize the configured Layer 0 summary target.
 * @param {Partial<ExtensionSettings>} [settings]
 * @returns {number}
 */
export function getLayer0SummaryTokenTarget(settings = {}) {
    const parsed = Number(settings.layer0SummaryTokenTarget);
    const fallback = defaultSettings.layer0SummaryTokenTarget;
    const value = Number.isFinite(parsed) ? Math.round(parsed) : fallback;
    return Math.min(MAX_LAYER0_TARGET_TOKENS, Math.max(MIN_LAYER0_TARGET_TOKENS, value));
}

/**
 * Compute the accepted Layer 0 output-size band for a configured target.
 * @param {Partial<ExtensionSettings>} [settings]
 * @returns {{ target: number, min: number, max: number }}
 */
export function getLayer0SummaryTokenBounds(settings = {}) {
    const target = getLayer0SummaryTokenTarget(settings);
    return {
        target,
        min: MIN_LAYER0_OUTPUT_TOKENS,
        max: Math.round(target * LAYER_HARD_MAX_RATIO.l0),
    };
}

/**
 * Compute the narrow narrative grace ceiling used to avoid retrying near-miss
 * outputs from slow providers. The model-facing hard maximum remains the
 * normal Layer 0 bound.
 * @param {Partial<ExtensionSettings>} [settings]
 * @returns {number}
 */
export function getLayer0SummaryRepairCeiling(settings = {}) {
    return Math.round(getLayer0SummaryTokenTarget(settings) * LAYER0_REPAIR_RATIO);
}

/**
 * Check whether a summarizer call should receive Layer 0 size validation.
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [metadata]
 * @returns {boolean}
 */
export function isLayer0SizeGuardCall(metadata = {}) {
    return metadata.kind === 'layer0' || metadata.kind === 'regenerate';
}

/**
 * Build attempt-local repair feedback for a rejected Layer 0 output.
 * @param {object} p
 * @param {object} [p.diagnostics]
 * @param {'too-short' | 'too-long'} [p.reason]
 * @param {number} [p.outputTokens]
 * @param {{ target: number, min: number, max: number }} [p.bounds]
 * @returns {string}
 */
export function buildLayer0SizeRepairFeedback({ diagnostics, reason, outputTokens, bounds }) {
    const resolvedDiagnostics =
        diagnostics ||
        buildRepairDiagnostics({
            scope: 'Layer 0',
            totalTokens: outputTokens ?? 0,
            sections: [
                {
                    id: 'narrative',
                    label: '[NARRATIVE]',
                    actualTokens: outputTokens ?? 0,
                    targetTokens: bounds?.target ?? 0,
                    hardMaxTokens: bounds?.max ?? 0,
                    minimumTokens: reason === 'too-short' ? (bounds?.min ?? 0) : 0,
                },
            ],
        });
    return formatRepairDiagnostics(resolvedDiagnostics, {
        wrapperTag: 'summaryception_l0_repair_feedback',
        rejectedSectionTagPrefix: 'rejected_',
        instructions: [
            'Aim for each section soft target, not merely its hard maximum. Rewrite only the rejected section or sections. Reproduce every preserved section exactly.',
            'Output exactly one [NARRATIVE] section followed by exactly one [STATE] section.',
        ],
    });
}

/**
 * Build repair feedback for an oversized state snapshot.
 * @param {object} p
 * @param {number} p.stateTokens
 * @param {string} [p.stateText]
 * @returns {string}
 */
export function buildStateSnapshotSizeRepairFeedback({ stateTokens, stateText = '' }) {
    const diagnostics = buildRepairDiagnostics({
        scope: 'Layer 0',
        totalTokens: stateTokens,
        sections: [
            {
                id: 'state',
                label: '[STATE]',
                actualTokens: stateTokens,
                targetTokens: STATE_SNAPSHOT_SOFT_TARGET_TOKENS,
                hardMaxTokens: STATE_SNAPSHOT_MAX_TOKENS,
                text: stateText,
                repairInstruction:
                    'rewrite the complete snapshot more abstractly and remove transient facts',
                preservationInstruction:
                    'keep only the fixed state keys and the most consequential active continuity',
            },
        ],
        rejectedDraft: stateText,
    });
    return buildLayer0SizeRepairFeedback({ diagnostics });
}

/**
 * Add non-persisted compression constraints to the final prompt.
 * @param {string} prompt
 * @param {Partial<ExtensionSettings>} settings
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} [metadata]
 * @returns {string}
 */
export function appendLayer0PromptConstraints(prompt, settings, metadata = {}) {
    if (!isLayer0CompressionCall(metadata)) {
        return prompt;
    }

    if (metadata.kind === 'promotion') {
        return appendPromotionPromptConstraints(prompt, settings, metadata);
    }

    const sourceRangeLine = buildLayer0SourceRangeLine(metadata);
    const budgetHint = metadata.budgetHint ? String(metadata.budgetHint).trim() : '';
    const insert = [budgetHint, sourceRangeLine].filter(Boolean).join('\n\n');
    return insertBeforeTrigger(prompt, insert, EXECUTION_TRIGGER_L0);
}

function buildLayer0SourceRangeLine(metadata = {}) {
    const range = metadata.sourceRange;
    if (!Array.isArray(range) || range.length < 2) {
        return '';
    }
    return (
        `This passage covers chat messages ${range[0]}-${range[1]}. ` +
        `Message ${range[1]} is the latest summarized message. ` +
        'current_date_time must be the scene time at the end of that message.\n'
    );
}

/**
 * Compute the target size for a promotion, anchored to the slider target T.
 * Doubles as the acceptance floor: a shorter output is rejected as over-merged.
 * @param {object} p
 * @param {number} p.layerIndex - Promotion SOURCE layer (0 => produces L1, >=1 => L2+).
 * @param {number} p.targetTokens - Slider target T.
 * @returns {number}
 */
export function getPromotionSummaryTokenTarget({ layerIndex, targetTokens }) {
    const key = Number(layerIndex) >= 1 ? 'l2' : 'l1';
    return Math.max(1, Math.floor(targetTokens * LAYER_MIN_RATIO[key]));
}

/**
 * Compute the hard maximum size for a promotion, anchored to the slider
 * target T.
 * @param {object} p
 * @param {number} p.layerIndex - Promotion SOURCE layer (0 => produces L1, >=1 => L2+).
 * @param {number} p.targetTokens - Slider target T.
 * @returns {number}
 */
export function getPromotionSummaryTokenHardMax({ layerIndex, targetTokens }) {
    const key = Number(layerIndex) >= 1 ? 'l2' : 'l1';
    return Math.max(1, Math.round(targetTokens * LAYER_HARD_MAX_RATIO[key]));
}
/**
 * Add Layer 1+ promotion-specific consolidation constraints.
 * @param {string} prompt
 * @param {Partial<ExtensionSettings>} settings
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} metadata
 * @returns {string}
 */
function appendPromotionPromptConstraints(prompt, settings, metadata = {}) {
    const targetTokens = getLayer0SummaryTokenTarget(settings);
    const layerIndex = Number(metadata.layerIndex);
    const sentenceCap = computeSentenceCap(layerIndex >= 1 ? 'l2' : 'l1', targetTokens);
    const withSchemaCap = fillSentenceCapPlaceholders(prompt, sentenceCap);

    const targetLine = buildSizeTargetLine({
        label: '[NARRATIVE]',
        verb: 'merge into',
        cap: sentenceCap,
        unit: 'sentences',
        extra: buildPromotionTargetExtra(metadata),
    });
    const repairLine = buildPromotionRepairLine(metadata, targetTokens);

    const block = buildSizeConstraintsBlock({
        wrapperTag: 'summaryception_promotion_constraints',
        targetLine,
        repairLine,
    });
    return insertBeforeTrigger(withSchemaCap, block, EXECUTION_TRIGGER_PROMO);
}

// Small cardinals for dual-framing the sentence cap in <output_schema>
// (e.g. "AT MOST five (5)"). Falls back to the digit for larger values.
const SENTENCE_CAP_WORDS = [
    'zero',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
];

/**
 * Replace {{max_sentences}} / {{max_sentences_word}} schema placeholders with
 * the computed cap. No-op when the template omits them (e.g. repair prompt).
 * @param {string} prompt
 * @param {number} sentenceCap
 * @returns {string}
 */
function fillSentenceCapPlaceholders(prompt, sentenceCap) {
    const word = SENTENCE_CAP_WORDS[sentenceCap] || String(sentenceCap);
    return prompt
        .replaceAll('{{max_sentences_word}}', word)
        .replaceAll('{{max_sentences}}', String(sentenceCap));
}

/**
 * Build the trailing clause of the promotion target line: an L1+-specific
 * "compress-harder" reminder for deep-layer folds.
 * @param {object} metadata
 * @returns {string}
 */
function buildPromotionTargetExtra(metadata) {
    return Number(metadata.layerIndex) >= 1
        ? 'This is a deep-layer fold: merge whole scenes into single outcome sentences; do not replay beats.'
        : '';
}

function buildPromotionRepairLine(metadata = {}, sliderTargetTokens) {
    if (!metadata.promotionRepair) {
        return '';
    }

    const repair = metadata.promotionRepair;
    const outputTokens = Number(repair.outputTokens);
    const hardMaxTokens = Number(repair.hardMaxTokens ?? repair.requiredMaxTokens);
    const tooShort = repair.reason === 'too-short';
    const rejected = String(repair.rejectedSummary || '').trim();
    const diagnostics =
        repair.diagnostics ||
        buildRepairDiagnostics({
            scope: 'Layer 1+ promotion',
            totalTokens: outputTokens,
            sections: [
                {
                    id: 'draft',
                    label: '[NARRATIVE]',
                    actualTokens: outputTokens,
                    targetTokens: Number(repair.targetTokens),
                    hardMaxTokens,
                    minimumTokens: tooShort ? Number(repair.targetTokens) : 0,
                    text: rejected,
                    repairInstruction: tooShort
                        ? 'expand the fold: it over-merged; restore the dropped durable beats'
                        : 'rewrite as macro-level prose only; remove dialogue, scene replay, micro-actions, and transient detail',
                    preservationInstruction:
                        'retain only macro-level durable chronology and continuity',
                },
            ],
            rejectedDraft: rejected,
        });
    const feedback = formatRepairDiagnostics(diagnostics, {
        wrapperTag: 'summaryception_promotion_repair_feedback',
        rejectedSectionTagPrefix: 'rejected_promotion_',
    });

    if (tooShort) {
        return (
            'Repair task: the rejected narrative over-merged and dropped durable beats. Expand the fold.\n' +
            'Restore the dropped durable events, agreements, position changes, and unresolved hooks while keeping macro-level prose.\n' +
            feedback +
            '\n'
        );
    }

    const layerIndex = Number(metadata.layerIndex);
    const sentenceCap = computeSentenceCap(layerIndex >= 1 ? 'l2' : 'l1', sliderTargetTokens);
    const sentences = countSentences(rejected);
    const overMsg =
        Number.isFinite(outputTokens) &&
        Number.isFinite(hardMaxTokens) &&
        outputTokens > hardMaxTokens &&
        sentences > 0
            ? `Draft contained ${sentences} sentences; the limit is ${sentenceCap}. Delete at least ${Math.max(1, sentences - sentenceCap)} sentences. Output at most ${sentenceCap} sentences total.`
            : '';
    return (
        'Repair task: rewrite the rejected narrative toward the sentence cap.\n' +
        (overMsg ? overMsg + '\n' : '') +
        'Keep only macro-level durable chronology, current position, relationship/state changes, permanent rules, and unresolved hooks.\n' +
        feedback +
        '\n'
    );
}
