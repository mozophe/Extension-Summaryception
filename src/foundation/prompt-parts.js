/**
 * OpenVault-style prompt assemblers shared by every summarizer prompt template.
 *
 * System prompt = `<role>` + optional `<role_invariants>`.
 * User prompt   = `<input>` blocks → `<output_schema>` → `<task_rules>` →
 *                  `<critical_rules>` (omitted when empty) → bare `EXECUTION_TRIGGER` line.
 *
 * Pure functions; no settings or runtime imports.
 */

/**
 * Assemble a system prompt from a role sentence and optional role invariants.
 * @param {string} role - The role sentence.
 * @param {string} [invariants] - Role invariants block; appended only when non-empty.
 * @returns {string}
 */
export function buildSystemPrompt(role, invariants) {
    let out = `<role>\n${role}\n</role>`;
    if (typeof invariants === 'string' && invariants.length > 0) {
        out += `\n\n<role_invariants>\n${invariants}\n</role_invariants>`;
    }
    return out;
}

/**
 * Assemble a user prompt from its ordered structural blocks.
 * @param {object} args
 * @param {string} args.inputBlocks - One or more `<input>` XML blocks.
 * @param {string} args.schemaBlock - The `<output_schema>` body.
 * @param {string} args.taskRules - The `<task_rules>` body (durability + format rules).
 * @param {string} [args.criticalRules] - The `<critical_rules>` body; omitted when empty.
 * @param {string} args.triggerLine - Bare affirmative imperative line.
 * @returns {string}
 */
export function buildUserPrompt({
    inputBlocks,
    schemaBlock,
    taskRules,
    criticalRules,
    triggerLine,
}) {
    const parts = [inputBlocks, `<output_schema>\n${schemaBlock}\n</output_schema>`];
    parts.push(`<task_rules>\n${taskRules}\n</task_rules>`);
    if (typeof criticalRules === 'string' && criticalRules.length > 0) {
        parts.push(`<critical_rules>\n${criticalRules}\n</critical_rules>`);
    }
    parts.push(triggerLine);
    return parts.join('\n\n');
}

/**
 * Bare imperative line for Layer 0 generate/repair user prompts.
 */
export const EXECUTION_TRIGGER_L0 =
    'Now output the two sections ([NARRATIVE] then [STATE]) with no preamble, code fences, or commentary.';

/**
 * Bare imperative line for Layer 1+ promotion generate/repair user prompts.
 */
export const EXECUTION_TRIGGER_PROMO =
    'Now output exactly one [NARRATIVE] paragraph with no preamble, code fences, or commentary.';

/**
 * Insert `insert` immediately before the trailing `triggerLine` of an
 * assembled user prompt. Static templates produced by `buildUserPrompt`
 * end with `triggerLine`; runtime appenders use this to place dynamic
 * budget hints, source-range lines, and repair-feedback blocks above the
 * bare execution trigger so the model begins emitting immediately.
 *
 * When the prompt does NOT end with `triggerLine` (e.g. a custom
 * user-edited setting), falls back to appending after the body so dynamic
 * content is never lost. Empty `insert` returns the prompt unchanged.
 * @param {string} prompt - Fully-assembled user prompt ending in `triggerLine`.
 * @param {string} insert - Dynamic block to place before the trigger.
 * @param {string} triggerLine - Bare imperative line the prompt must end with.
 * @returns {string}
 */
export function insertBeforeTrigger(prompt, insert, triggerLine) {
    const body = String(prompt ?? '');
    const trigger = String(triggerLine ?? '');
    const trimmed = body.trimEnd();
    if (trigger && trimmed.endsWith(trigger)) {
        const head = trimmed.slice(0, trimmed.length - trigger.length).trimEnd();
        const extra = String(insert ?? '').trim();
        return extra ? `${head}\n\n${extra}\n\n${trigger}` : `${head}\n\n${trigger}`;
    }
    // Fallback: append after body (preserves prior behavior if the template
    // does not end with the expected trigger (e.g. a custom user setting).
    const extra = String(insert ?? '').trim();
    return extra ? `${body.trimEnd()}\n\n${extra}` : body;
}
