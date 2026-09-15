import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { SLIDER_LIMITS, defaultSettings } from '../src/foundation/constants.js';

const SETTINGS_HTML_URL = new URL('../settings.html', import.meta.url);

/**
 * Parse the relevant attributes of every <input> tag in the raw HTML source.
 * Plain regex over the file: bounds checks must run in plain node, no DOM.
 * @param {string} html - Raw settings.html source
 * @returns {Array<{id: string|null, type: string|null, key: string|null, min: string|null, max: string|null, step: string|null, value: string|null}>}
 */
function parseInputs(html) {
    const inputs = [];
    for (const tag of html.match(/<input\b[^>]*>/g) ?? []) {
        const attr = (name) => tag.match(new RegExp(`(?<![\\w-])${name}="([^"]*)"`))?.[1] ?? null;
        inputs.push({
            id: attr('id'),
            type: attr('type'),
            key: attr('data-sc-slider-setting') ?? attr('data-sc-setting'),
            min: attr('min'),
            max: attr('max'),
            step: attr('step'),
            value: attr('value'),
        });
    }
    return inputs;
}

/** @param {string|null} raw - Attribute value; absent attributes stay null */
const num = (raw) => (raw === null ? null : Number(raw));

/**
 * Decode a rendered display default: k-suffix values scale ('48k' → 48000),
 * plain numbers parse as-is.
 * @param {string} raw - value attribute text
 * @returns {number}
 */
function decodeDefault(raw) {
    const kMatch = /^(\d+)k$/i.exec(raw.trim());
    return kMatch ? Number(kMatch[1]) * 1000 : Number(raw);
}

describe('settings.html bounds agreement', () => {
    const inputs = parseInputs(readFileSync(SETTINGS_HTML_URL, 'utf8'));
    // Registry-governed controls: range sliders carry data-sc-slider-setting,
    // numeric steppers carry data-sc-setting.
    const boundsControls = inputs.filter(
        (el) => (el.type === 'range' || el.type === 'number') && el.key !== null,
    );
    // Sliders plus their partner text displays, wherever a default is rendered.
    const defaultValueBearers = inputs.filter(
        (el) =>
            el.key !== null &&
            el.value !== null &&
            (el.type === 'range' || el.type === 'text' || el.type === 'number'),
    );

    it('covers exactly the slider keys present in settings.html, both directions', () => {
        expect([...new Set(boundsControls.map((el) => el.key))].sort()).toEqual(
            Object.keys(SLIDER_LIMITS).sort(),
        );
    });

    it('matches every min/max/step attribute to the registry bounds', () => {
        for (const el of boundsControls) {
            const limits = SLIDER_LIMITS[el.key];
            expect(
                limits,
                `settings.html #${el.id}: key "${el.key}" missing from SLIDER_LIMITS`,
            ).toBeDefined();
            expect(num(el.min), `#${el.id} (${el.key}) min`).toBe(limits.MIN);
            expect(num(el.max), `#${el.id} (${el.key}) max`).toBe(limits.MAX);
            expect(num(el.step), `#${el.id} (${el.key}) step`).toBe(limits.STEP);
        }
    });

    it('matches every rendered default value to defaultSettings', () => {
        expect(defaultValueBearers.length).toBeGreaterThan(0);
        for (const el of defaultValueBearers) {
            if (!Object.hasOwn(defaultSettings, el.key)) {
                continue;
            }
            expect(decodeDefault(el.value), `#${el.id} default for ${el.key}`).toBe(
                defaultSettings[el.key],
            );
        }
    });
});
