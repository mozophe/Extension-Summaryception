/**
 * Modular STATE category catalog: single source of truth for which state
 * categories exist, their toggle settings, trim priority, and per-category
 * schema text emitted to the L0 summarizer.
 *
 * Consumed by: settings defaults/types, UI toggles + help, L0 schema assembly
 * (summarizer-pipeline.js), the snapshot trim loop (summarizer-state.js), and
 * the L0 budget hint (budget-hint-builder.js).
 * Runtime code resolves effective settings at the call site and passes them in;
 * this module stays a pure data + pure-function foundation module with no
 * upward dependency on core.
 */

/**
 * Frozen catalog of STATE categories. `priorityRank` ascending = trim order:
 * lowest rank loses tokens first. `current_date_time` rank -1 = never trimmed.
 * `lineCapDefault` is the countable per-category line ceiling surfaced to the
 * summarizer (token caps never appear in the model prompt).
 * @type {ReadonlyArray<{
 *   key: string, sourceKey: string, alwaysOn: boolean,
 *   priorityRank: number, lineCapDefault: number,
 *   helpTitle: string, helpShort: string, helpWhen: string, helpRisk: string
 * }>}
 */
export const STATE_CATEGORIES = Object.freeze([
    {
        key: 'current_date_time',
        sourceKey: 'stateCatDateTime',
        alwaysOn: true,
        priorityRank: -1,
        lineCapDefault: 2,
        helpTitle: 'Date & Time',
        helpShort: 'Time anchor carried across every snapshot.',
        helpWhen:
            'Required. The RP must carry date/time info in each assistant message so the summarizer can normalize it.',
        helpRisk:
            'No date in chat = nothing to carry forward; the snapshot loses its temporal anchor.',
    },
    {
        key: 'bonds',
        sourceKey: 'stateCatBonds',
        alwaysOn: false,
        priorityRank: 1,
        lineCapDefault: 6,
        helpTitle: 'Bonds (Relationships RPG)',
        helpShort: 'Persistent relationship engine: BOND/Sparks/Grudge per character pair.',
        helpWhen:
            "Replaces FF5's <internal_bondtracker>. Disable that block in your preset when on.",
        helpRisk:
            'Disable in preset: the bond numbers, gates, and drift rules move here; keep the BOND→DnD DC-mod logic in your preset CoT.',
    },
    {
        key: 'chekhov',
        sourceKey: 'stateCatChekhov',
        alwaysOn: false,
        priorityRank: 2,
        lineCapDefault: 8,
        helpTitle: 'Chekhov (Narrative Gun)',
        helpShort: 'Aging narrative-debt bullets that fire probabilistically.',
        helpWhen:
            "Replaces FF5's <internal_chekhovguntracker> storage. Disable that block in your preset when on.",
        helpRisk:
            'Keep the FIRE-decision d20 logic in your preset CoT; only the bullet register lives here.',
    },
    {
        key: 'gm_notes',
        sourceKey: 'stateCatGmNotes',
        alwaysOn: false,
        priorityRank: 3,
        lineCapDefault: 12,
        helpTitle: 'GM Notes',
        helpShort: 'Persistent GM scratchpad with [R]/[T]/[D] prefixed entries.',
        helpWhen:
            "Replaces FF5's <internal_gmnotebook>. Disable that block in your preset when on.",
        helpRisk: 'Do not duplicate content that already lives in bonds/chekhov/inventory.',
    },
    {
        key: 'inventory',
        sourceKey: 'stateCatInventory',
        alwaysOn: false,
        priorityRank: 4,
        lineCapDefault: 6,
        helpTitle: 'Inventory & Titles',
        helpShort: 'User-only items, titles/skills, and status conditions.',
        helpWhen: "Replaces FF5's <internal_inv>. Disable that block in your preset when on.",
        helpRisk:
            'Track user only, not NPCs. Consumable items go here; future-affecting one-shots go in chekhov.',
    },
    {
        key: 'location',
        sourceKey: 'stateCatLocation',
        alwaysOn: false,
        priorityRank: 5,
        lineCapDefault: 2,
        helpTitle: 'Location',
        helpShort: 'Current scene location.',
        helpWhen:
            'Optional. Needed if your preset uses proximity-based modifiers (e.g. Chekhov location-match).',
        helpRisk: 'Low risk; dispensable if your preset does not key off scene location.',
    },
]);

/**
 * Look up a category object by canonical key.
 * @param {string} key
 * @returns {object | undefined}
 */
export function getCategoryByKey(key) {
    return STATE_CATEGORIES.find((c) => c.key === key);
}

/**
 * Whether a category is enabled. `alwaysOn` categories are always true
 * regardless of the persisted flag. Optional categories read the persisted
 * flag directly, so a raw settings object that predates a key reads as off
 * until `getSettings()` normalization fills in the (enabled) default.
 * @param {ExtensionSettings} settings
 * @param {string} key
 * @returns {boolean}
 */
export function isCategoryEnabled(settings, key) {
    const category = getCategoryByKey(key);
    if (!category) {
        return false;
    }
    if (category.alwaysOn) {
        return true;
    }
    return Boolean(settings?.[category.sourceKey]);
}

/**
 * Enabled category objects ordered by `priorityRank` ascending with
 * `alwaysOn` entries first. `current_date_time` is ALWAYS present.
 * @param {ExtensionSettings} settings
 * @returns {object[]}
 */
export function getEnabledCategories(settings) {
    const enabled = STATE_CATEGORIES.filter((c) => isCategoryEnabled(settings, c.key));
    return enabled.sort((a, b) => {
        if (a.alwaysOn !== b.alwaysOn) {
            return a.alwaysOn ? -1 : 1;
        }
        return a.priorityRank - b.priorityRank;
    });
}

/**
 * Array of enabled canonical key strings (subset of STATE_CATEGORIES keys),
 * ordered by `priorityRank` ascending with `current_date_time` first.
 * @param {ExtensionSettings} settings
 * @returns {string[]}
 */
export function getEnabledStateKeys(settings) {
    return getEnabledCategories(settings).map((c) => c.key);
}

/**
 * Sum of enabled `lineCapDefault`, clamped to [1, ceiling].
 * `ceiling` defaults to Infinity (unclamped) so this pure foundation module
 * need not import the core STATE_KEY_CEILING; the core budget-hint builder
 * passes the real ceiling when it needs the clamp.
 * @param {ExtensionSettings} settings
 * @param {number} [ceiling]
 * @returns {number}
 */
export function getActiveLineCap(settings, ceiling = Number.POSITIVE_INFINITY) {
    const sum = getEnabledCategories(settings).reduce((acc, c) => acc + c.lineCapDefault, 0);
    const top = Number.isFinite(ceiling) ? ceiling : sum;
    return Math.max(1, Math.min(sum, top));
}

// ─── Per-category schema fragments ────────────────────────────────────
// Bodies adapted 1:1 from FF5's <internal_*> tags
// (docs/Freaky Frankenstein 5.0 - Internal States.json) with
// {{setvar::...}}/{{getvar::...}} plumbing stripped; the extension stores
// state in [STATE], not ST setvars. `{cap}` is replaced with the concrete
// `lineCapDefault` integer at build time. Token caps never appear here.
const SCHEMA_FRAGMENTS = Object.freeze({
    current_date_time:
        'current_date_time: <YYYY-MM-DD HH ddd>. Hour-level 24h precision. Normalize from raw bracket headers or passage timestamps; drop minutes. Carry forward prior value if no explicit time in passage. REQUIRED every snapshot.',
    location: 'location: <current place>. One short phrase.',
    bonds: 'bonds: one pair per line, max {cap} lines. Format per pair: "BOND: NPC1↔NPC2=<value -5..+20> | Sparks: <value> | Grudge: <value>". Tiers/Behaviors: -5..-3 hostile; -2..+2 neutral; +3..+7 warmth; +8..+15 trust (+8 nervous crush, +12 confident interest); +16..+20 chosen family (+15 verbal "I love you", irreversible). Physical Gates: +4 friendly hug/shoulder; +8 hand-hold/sustained touch; +14 romantic kiss; +18 full intimacy. BOND shifts: -1 insult/dismissal/ignoring; -2 betrayal/cruelty. NEVER raise BOND directly; only via Sparks conversion. Sparks: +1 per positive interaction (max +2/turn/pair); every 5 turns if Sparks≥7 → BOND+1, reset Sparks; -1 Sparks per 5 turns no contact. Grudge: +1 per slight (max 1/turn/entity); every 3 turns if Grudge≥3 → BOND-1, reset Grudge.',
    chekhov:
        'chekhov: one bullet per line, max {cap} lines. Format: "[BULLET: desc] (weight: 1-3, age: 0/12) [depends: prereq] [secret]". Time-locks as "[LOCKED: T:HH:MM]". Aging: each summarizer call covers one batch of source turns; age every unlocked bullet by the number of turns in that batch (visible in the passage), never by +1 per call; time-locked bullets stay frozen. Cap each per-call increment to the batch turn count (do not add extra age for elapsed wall-clock time not reflected in the passage). Firing threshold (computed by preset CoT, NOT here): base W1=18|W2=13|W3=8, minus age, minus proximity/scene/urgency mods; eligible only at age>=4; prune non-locked at age>=12 or when active>20 (prune oldest/lowest weight). Loading: scan narrative for debt (unresolved setups, promises, foreshadowing) and load 1-2 bullets/turn. Storage only; firing d20 logic stays in preset. Never narrate mechanics in prose.',
    gm_notes:
        'gm_notes: pipe-separated entries, max {cap} entries (prune oldest when exceeded). 1-2 concise sentences per entry. Prefix: [R] Reminder (rules/knowledge limits/OOC directives); [T] Thread (plot arcs/loose ends/foreshadowing); [D] Debug (issues/anomalies/verification). Do NOT log BOND/Sparks/Grudge shifts or anything with a dedicated spot in bonds/chekhov/inventory. Only log elements that lack a dedicated spot elsewhere. Jot and move; no deliberation.',
    inventory:
        'inventory: one line, max {cap} item-groups. Format: "Inv: [items] | Titles: [traits] | Status: [conditions]". Track strictly for {{user}} only; do not track for NPCs. Add items when found, remove when lost/used. Titles are dynamically earned story titles providing passive modifiers. Status = temporary physical/mental conditions (Injured/Tired/Inspired), cleared via time or narrative. Buffs/debuffs capped ±2, domain-locked (e.g. Charmer→social, Slayer→combat). Consumable/one-time items go here; future-affecting one-shots go in chekhov. Never write modifier values in prose.',
});

/**
 * Assemble the per-enabled-category schema text substituted for
 * `{{state_schema}}` in the L0 summarizer templates. One fragment per
 * enabled category in priorityRank-asc order, each with `{cap}` filled.
 * @param {ExtensionSettings} settings
 * @returns {string}
 */
export function buildStateSchemaText(settings) {
    return getEnabledCategories(settings)
        .map((c) => SCHEMA_FRAGMENTS[c.key].replace('{cap}', String(c.lineCapDefault)))
        .join('\n');
}
