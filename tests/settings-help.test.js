import { describe, expect, it } from 'vitest';

import { SETTINGS_HELP } from '../src/entry/settings-help-data.js';

describe('settings help data', () => {
    it('documents the Clear Memory button with the reprocess recipe', () => {
        const entry = SETTINGS_HELP.clear_memory;
        expect(entry).toBeDefined();
        expect(entry.controls).toContain('#sc_clear_memory');
        expect(entry.short.trim()).not.toBe('');
        expect(entry.detail).toContain('Clear Memory');
        expect(entry.detail).toContain('Ctrl+F5');
        expect(entry.detail).toContain('Force Summarize');
    });

    it('gives every opt-in state setting a plain-language short and detail', () => {
        const keys = [
            'inject_current_state',
            'state_cat_bonds',
            'state_cat_chekhov',
            'state_cat_gm_notes',
            'state_cat_inventory',
            'state_cat_location',
        ];
        for (const key of keys) {
            const entry = SETTINGS_HELP[key];
            expect(entry, `help entry for ${key}`).toBeDefined();
            expect(entry.short.trim(), `${key}.short`).not.toBe('');
            expect(entry.detail.trim(), `${key}.detail`).not.toBe('');
        }
    });
});
