import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateValidatedPromotion } from '../src/core/promotion-candidate.js';
import { resolveCallProfile } from '../src/core/call-profile.js';
import { NOTIFY_EVENTS } from '../src/foundation/constants.js';
import {
    installSummaryContext,
    makeNotifyRecorder,
    makeSummarySettings,
    makeSummaryStore,
} from './test-helpers.js';

/**
 * The setup context installs a length-based test tokenizer and a
 * layer0SummaryTokenTarget of 100, so a Layer 0 promotion accepts 40..175
 * tokens and rejects anything outside that band.
 */

const settings = makeSummarySettings({ layer0SummaryTokenTarget: 100 });
// Merged sources of 312 tokens / 3 merges sit below this slider, so the
// effective target drops to 104 and the L0->L1 floor to floor(104 * 0.4) = 41.
const shortSourceSettings = makeSummarySettings({ layer0SummaryTokenTarget: 280 });
/** The dispatch stand-in; returns the outcome the real request layer would. */
const dispatch = vi.fn();
const GOOD_NARRATIVE = 'word '.repeat(30).trim(); // 149 tokens: inside the band
const SHORT_NARRATIVE = 'short'; // 5 tokens: under the 40-token floor
const LONG_NARRATIVE = 'word '.repeat(40).trim(); // 199 tokens: over the 175 hard max
function overflowLayers() {
    return Array.from({ length: 4 }, (_, i) => ({
        text: 'x'.repeat(1000),
        sourceMessageIds: [`msg-a-${i}`],
    }));
}
function installStore(layers = [overflowLayers()], storeSettings = settings) {
    installSummaryContext({
        metadata: { summaryception: makeSummaryStore({ layers }) },
        settings: storeSettings,
    });
}

// Store snippets must carry provenance or normalizeChatStore drops them.
function makePrepared(overrides = {}) {
    const toMerge = overflowLayers().slice(0, 3);
    const storyTxt = toMerge.map((snippet) => snippet.text).join('\n\n');
    const memoryTokensBefore = { count: 400, estimated: false };
    return {
        layerIndex: 0,
        settings,
        mergeCount: 3,
        toMerge,
        sourceNarrativeText: storyTxt,
        memoryTokensBefore,
        storyTxt,
        contextStr: 'context',
        promotedMetadata: { sourceMessageIds: ['msg-0', 'msg-2'] },
        // The real producer resolves this dispatch metadata with the source
        // memory size, so the profile's provenance carries it verbatim.
        promotionMetadata: {
            kind: 'promotion',
            layerIndex: 0,
            memoryTokensBefore: memoryTokensBefore.count,
            memoryTokensBeforeEstimated: memoryTokensBefore.estimated,
        },
        ...overrides,
    };
}

/** Completed dispatch outcome whose profile resolves from the dispatch metadata. */
function outcomeWithProfile(text, profileSettings = settings) {
    return async ({ metadata }) => ({
        status: 'completed',
        text,
        profile: resolveCallProfile(profileSettings, metadata),
    });
}

describe('generateValidatedPromotion', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        dispatch.mockReset();
        delete globalThis.toastr;
    });

    it('accepts a first-pass promotion that fits the size band and compresses memory', async () => {
        installStore();
        const recorder = makeNotifyRecorder();
        const prepared = makePrepared();
        dispatch.mockImplementation(outcomeWithProfile(GOOD_NARRATIVE));

        const result = await generateValidatedPromotion(prepared, { notify: recorder, dispatch });

        expect(result).toEqual({ text: GOOD_NARRATIVE, sourceMessageIds: ['msg-0', 'msg-2'] });
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch.mock.calls[0]).toEqual([
            {
                storyTxt: prepared.storyTxt,
                contextStr: prepared.contextStr,
                metadata: prepared.promotionMetadata,
                notify: recorder,
            },
        ]);
        expect(recorder.events).toEqual([
            {
                type: 'transient',
                kind: NOTIFY_EVENTS.PROMOTION_STARTED,
                mergedCount: 3,
                fromLayer: 0,
                toLayer: 1,
            },
        ]);
    });

    it('repairs an over-merged output once and accepts the repaired summary', async () => {
        installStore();
        const recorder = makeNotifyRecorder();
        const prepared = makePrepared();
        dispatch
            .mockImplementationOnce(outcomeWithProfile(SHORT_NARRATIVE))
            .mockImplementationOnce(outcomeWithProfile(GOOD_NARRATIVE));

        const result = await generateValidatedPromotion(prepared, { notify: recorder, dispatch });

        expect(result).toEqual({ text: GOOD_NARRATIVE, sourceMessageIds: ['msg-0', 'msg-2'] });
        expect(dispatch).toHaveBeenCalledTimes(2);
        const { storyTxt, contextStr, metadata, notify } = dispatch.mock.calls[1][0];
        expect(storyTxt).toBe(prepared.storyTxt);
        expect(contextStr).toBe(prepared.contextStr);
        expect(notify).toBe(recorder);
        expect(metadata.promotionRepair).toMatchObject({
            reason: 'too-short',
            outputTokens: SHORT_NARRATIVE.length,
            sourceTokens: 400,
            rejectedSummary: SHORT_NARRATIVE,
        });
        // The repair pass reuses the generation's single notify event.
        expect(recorder.events).toEqual([
            {
                type: 'transient',
                kind: NOTIFY_EVENTS.PROMOTION_STARTED,
                mergedCount: 3,
                fromLayer: 0,
                toLayer: 1,
            },
        ]);
    });

    it('repairs an oversized output once and rejects when the repair still misses', async () => {
        installStore();
        const prepared = makePrepared();
        dispatch
            .mockImplementationOnce(outcomeWithProfile(LONG_NARRATIVE))
            .mockImplementationOnce(outcomeWithProfile(SHORT_NARRATIVE));

        const result = await generateValidatedPromotion(prepared, {
            notify: makeNotifyRecorder(),
            dispatch,
        });

        expect(result).toBeNull();
        expect(dispatch).toHaveBeenCalledTimes(2);
        expect(dispatch.mock.calls[1][0].metadata.promotionRepair).toMatchObject({
            reason: 'compression-ratio',
            outputTokens: LONG_NARRATIVE.length,
            hardMaxTokens: 175,
        });
    });

    it('rejects a valid-sized promotion that does not compress memory', async () => {
        installStore([
            [
                { text: 'a', sourceMessageIds: ['m-1'] },
                { text: 'b', sourceMessageIds: ['m-2'] },
                { text: 'c', sourceMessageIds: ['m-3'] },
            ],
        ]);
        const prepared = makePrepared();
        dispatch.mockImplementation(outcomeWithProfile(GOOD_NARRATIVE));

        const result = await generateValidatedPromotion(prepared, {
            notify: makeNotifyRecorder(),
            dispatch,
        });

        expect(result).toBeNull();
        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('returns null and stays silent beyond the notify event when the request fails', async () => {
        installStore();
        const recorder = makeNotifyRecorder();
        dispatch.mockResolvedValue({ status: 'failed' });

        const result = await generateValidatedPromotion(makePrepared(), {
            notify: recorder,
            dispatch,
        });

        expect(result).toBeNull();
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(recorder.events).toEqual([
            {
                type: 'transient',
                kind: NOTIFY_EVENTS.PROMOTION_STARTED,
                mergedCount: 3,
                fromLayer: 0,
                toLayer: 1,
            },
        ]);
    });

    it('returns null when the narrative carries no usable summary', async () => {
        installStore();
        dispatch.mockResolvedValue({ status: 'completed', text: '' });

        const result = await generateValidatedPromotion(makePrepared(), {
            notify: makeNotifyRecorder(),
            dispatch,
        });

        expect(result).toBeNull();
        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    /** Prepared promotion whose 3 merged sources (312 tokens) sit below the 280 slider target. */
    function makeShortSourcePrepared(overrides = {}) {
        const memoryTokensBefore = { count: 312, estimated: false };
        return makePrepared({
            settings: shortSourceSettings,
            memoryTokensBefore,
            promotionMetadata: {
                kind: 'promotion',
                layerIndex: 0,
                memoryTokensBefore: memoryTokensBefore.count,
                memoryTokensBeforeEstimated: memoryTokensBefore.estimated,
            },
            ...overrides,
        });
    }

    it('lowers the promotion floor when the merged sources are smaller than the slider target', async () => {
        installStore();
        // 90 tokens clears floor(312 / 3 * 0.4) = 41 but not the slider-anchored 112.
        dispatch.mockImplementation(outcomeWithProfile('x'.repeat(90), shortSourceSettings));

        const result = await generateValidatedPromotion(makeShortSourcePrepared(), {
            notify: makeNotifyRecorder(),
            dispatch,
        });

        expect(result).toEqual({ text: 'x'.repeat(90), sourceMessageIds: ['msg-0', 'msg-2'] });
        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('keeps the slider-anchored floor when the merged sources match the slider target', async () => {
        installStore();
        const memoryTokensBefore = { count: 840, estimated: false };
        dispatch
            .mockImplementationOnce(outcomeWithProfile('x'.repeat(90), shortSourceSettings))
            .mockImplementationOnce(outcomeWithProfile('x'.repeat(120), shortSourceSettings));

        const result = await generateValidatedPromotion(
            makePrepared({
                settings: shortSourceSettings,
                memoryTokensBefore,
                promotionMetadata: {
                    kind: 'promotion',
                    layerIndex: 0,
                    memoryTokensBefore: memoryTokensBefore.count,
                    memoryTokensBeforeEstimated: memoryTokensBefore.estimated,
                },
            }),
            { notify: makeNotifyRecorder(), dispatch },
        );

        expect(result).toEqual({ text: 'x'.repeat(120), sourceMessageIds: ['msg-0', 'msg-2'] });
        // 840 / 3 merges = 280 = the slider, so the floor stays floor(280 * 0.4) = 112
        // and a 90-token output that a lowered floor would accept stays too-short.
        const { metadata } = dispatch.mock.calls[1][0];
        expect(metadata.promotionRepair).toMatchObject({ reason: 'too-short', targetTokens: 112 });
    });

    it('reports the lowered floor in the repair diagnostics for a too-short output', async () => {
        installStore();
        dispatch
            .mockImplementationOnce(outcomeWithProfile('x'.repeat(20), shortSourceSettings))
            .mockImplementationOnce(outcomeWithProfile('x'.repeat(90), shortSourceSettings));

        const result = await generateValidatedPromotion(makeShortSourcePrepared(), {
            notify: makeNotifyRecorder(),
            dispatch,
        });

        expect(result).toEqual({ text: 'x'.repeat(90), sourceMessageIds: ['msg-0', 'msg-2'] });
        const { metadata } = dispatch.mock.calls[1][0];
        expect(metadata.promotionRepair).toMatchObject({ reason: 'too-short', targetTokens: 41 });
        const draft = metadata.promotionRepair.diagnostics.sections.find(
            (section) => section.id === 'draft',
        );
        expect(draft.minimumTokens).toBe(41);
    });

    it('applies the deeper-layer ratio to the lowered floor', async () => {
        // The L1+ hypothetical must find source snippets on the destination side,
        // so layer 1 carries its own overflow snippets.
        installStore([overflowLayers(), overflowLayers().slice(0, 3)]);
        // 40 tokens clears floor(104 * 0.3) = 31 but not the slider-anchored 84.
        dispatch.mockImplementation(outcomeWithProfile('x'.repeat(40), shortSourceSettings));

        const result = await generateValidatedPromotion(
            makeShortSourcePrepared({
                layerIndex: 1,
                promotionMetadata: {
                    kind: 'promotion',
                    layerIndex: 1,
                    memoryTokensBefore: 312,
                    memoryTokensBeforeEstimated: false,
                },
            }),
            { notify: makeNotifyRecorder(), dispatch },
        );

        expect(result).toEqual({ text: 'x'.repeat(40), sourceMessageIds: ['msg-0', 'msg-2'] });
        expect(dispatch).toHaveBeenCalledTimes(1);
    });
});
