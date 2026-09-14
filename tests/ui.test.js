import { beforeEach, describe, expect, it, vi } from 'vitest';

import { estimateContextPreview } from '../src/core/token-budget.js';
import { bindDataSettingElements, readLines } from '../src/entry/ui-bind.js';
import { getSettings } from '../src/foundation/state.js';
import { buildTriggerGaugeModel } from '../src/entry/ui.js';
import { createJQueryHarness, installSummaryContext } from './test-helpers.js';

describe('context limit and trigger gauge UI models', () => {
    it('builds the context preview estimates from token budgets and defaults', () => {
        expect(
            estimateContextPreview({
                memoryTokenBudget: 10000,
                verbatimTokenBudget: 16000,
                queuedTokenBudget: 32000,
            }),
        ).toEqual({
            rawChatMin: 16000,
            rawChatMax: 48000,
            mainMin: 26000,
            mainMax: 58000,
            l0Typical: 28000,
            l0Max: 36000,
            l1Total: 6840,
        });
    });

    it('builds the queued gauge from the auto work read model and the queued budget', () => {
        expect(
            buildTriggerGaugeModel(
                { queuedTokens: 4321.2, queuedEstimated: true },
                { queuedTokenBudget: 16000 },
            ),
        ).toMatchObject({
            queuedTokens: 4322,
            queuedEstimated: true,
            triggerTokens: 16000,
        });
    });
});

describe('data-attr setting binding engine', () => {
    beforeEach(() => {
        installSummaryContext({ settings: { debugMode: false, stripPatterns: [] } });
    });

    it('reads textarea content as trimmed non-empty lines', () => {
        expect(readLines({ val: () => '  foo\n\n  bar \n   \nbaz' })).toEqual([
            'foo',
            'bar',
            'baz',
        ]);
        expect(readLines({ val: () => '' })).toEqual([]);
    });

    it('binds checkbox settings from data attributes on change and syncs at bind time', () => {
        const dom = createJQueryHarness({
            attributes: {
                '#sc_debug_mode': { type: 'checkbox', 'data-sc-setting': 'debugMode' },
            },
        });
        globalThis.$ = dom.$;

        bindDataSettingElements('#sc_debug_mode', { eventName: 'change' });

        expect(dom.element('#sc_debug_mode').prop('checked')).toBe(false);
        expect(() => dom.trigger('input', '#sc_debug_mode')).toThrow(
            'No handler registered for input',
        );
        dom.element('#sc_debug_mode').prop('checked', true);
        dom.trigger('change', '#sc_debug_mode');
        expect(getSettings().debugMode).toBe(true);
    });

    it('binds lines and plain string settings from their declared data types', () => {
        const dom = createJQueryHarness({
            attributes: {
                '#sc_strip_patterns': {
                    'data-sc-setting': 'stripPatterns',
                    'data-sc-type': 'lines',
                },
                '#sc_custom_memory_position': {
                    'data-sc-setting': 'customMemoryPosition',
                },
            },
        });
        globalThis.$ = dom.$;
        const afterSave = vi.fn();

        bindDataSettingElements('#sc_strip_patterns, #sc_custom_memory_position', {
            eventName: 'change',
            afterSave,
        });

        dom.element('#sc_strip_patterns').val('  foo\n\nbar ');
        dom.trigger('change', '#sc_strip_patterns');
        dom.trigger('change', '#sc_custom_memory_position');
        expect(getSettings().stripPatterns).toEqual(['foo', 'bar']);
        expect(getSettings().customMemoryPosition).toBe('in_prompt');
        expect(afterSave).toHaveBeenCalledTimes(2);
    });
});
