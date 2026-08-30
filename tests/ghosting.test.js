import { describe, expect, it } from 'vitest';

import { repairMissingGhostingForSummaries } from '../src/core/ghosting-reconcile.js';
import { resetCommitStateForTests } from '../src/core/summarizer-commit.js';
import { makeMessage, makeSummaryStore, installSummaryContext } from './test-helpers.js';

/**
 * Gap-hide contract: text-less messages inside the summarized range (images,
 * tool calls) must be hidden together with the text around them, so the model
 * does not see a perforated range that still costs context. On by default,
 * off by setting.
 */
describe('hide non-text messages in summarized range', () => {
    function buildChat() {
        return [
            makeMessage({ mes: 'turn zero', scId: 'message-0' }),
            makeMessage({ mes: 'turn one', scId: 'message-1' }),
            // No text: an image or tool-call message that carries no summary text.
            makeMessage({ mes: '', name: 'Image', scId: 'message-2' }),
            makeMessage({ mes: 'turn three', scId: 'message-3' }),
        ];
    }

    function makeSummarydStore() {
        return makeSummaryStore({
            ghostedMessageIds: [],
            layers: [
                [
                    {
                        text: 'summary snippet',
                        sourceMessageIds: ['message-0', 'message-1', 'message-2', 'message-3'],
                    },
                ],
            ],
        });
    }

    /** Collect /hide commands and return a predicate testing index coverage. */
    async function runWith({ hideNonTextMessages }) {
        resetCommitStateForTests();
        const calls = [];
        installSummaryContext({
            chat: buildChat(),
            metadata: { summaryception: makeSummarydStore() },
            settings: { hideNonTextMessages },
            executeSlashCommandsWithOptions: async (command) => {
                calls.push(String(command));
            },
        });
        await repairMissingGhostingForSummaries();
        return calls;
    }

    /** True when one of the /hide ranges contains the index. */
    function isHidden(calls, index) {
        return calls.some((cmd) => {
            if (!cmd.startsWith('/hide')) {
                return false;
            }
            const spec = cmd.slice('/hide '.length).trim();
            const dash = spec.indexOf('-');
            const lo = Number(dash < 0 ? spec : spec.slice(0, dash));
            const hi = Number(dash < 0 ? spec : spec.slice(dash + 1));
            return index >= lo && index <= hi && !Number.isNaN(lo) && !Number.isNaN(hi);
        });
    }

    it('hides text-less messages alongside the text around them', async () => {
        const calls = await runWith({ hideNonTextMessages: true });
        expect(isHidden(calls, 0)).toBe(true);
        expect(isHidden(calls, 1)).toBe(true);
        expect(isHidden(calls, 2)).toBe(true);
        expect(isHidden(calls, 3)).toBe(true);
    });

    it('skips text-less messages when the setting is disabled', async () => {
        const calls = await runWith({ hideNonTextMessages: false });
        expect(isHidden(calls, 2)).toBe(false);
        expect(isHidden(calls, 0)).toBe(true);
        expect(isHidden(calls, 1)).toBe(true);
        expect(isHidden(calls, 3)).toBe(true);
    });

    it('repairs only contiguous surviving UUID ranges and ignores a missing ID', async () => {
        resetCommitStateForTests();
        const calls = [];
        const chat = Array.from({ length: 11 }, (_value, index) =>
            makeMessage({ mes: `turn ${index}`, scId: `message-${index}` }),
        );
        installSummaryContext({
            chat,
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [
                        [
                            {
                                text: 'summary snippet',
                                sourceMessageIds: [
                                    ...Array.from(
                                        { length: 5 },
                                        (_value, index) => `message-${index + 1}`,
                                    ),
                                    'missing-message',
                                    ...Array.from(
                                        { length: 4 },
                                        (_value, index) => `message-${index + 7}`,
                                    ),
                                ],
                            },
                        ],
                    ],
                }),
            },
            executeSlashCommandsWithOptions: async (command) => calls.push(String(command)),
        });

        await repairMissingGhostingForSummaries();

        expect(calls).toEqual(['/hide 1-5', '/hide 7-10']);
    });
});
