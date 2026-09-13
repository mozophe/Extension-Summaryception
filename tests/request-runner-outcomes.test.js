import { afterEach, describe, expect, it, vi } from 'vitest';

const attemptMocks = vi.hoisted(() => ({
    runSingleAttempt: vi.fn(),
    classifyAttemptError: vi.fn(),
    appendRepairFeedback: vi.fn((prompt) => prompt),
    notifyRetryAndWait: vi.fn(async () => {}),
    notifyRouteCycleFailedAndWait: vi.fn(async () => {}),
}));
vi.mock('../src/core/request-attempt.js', () => attemptMocks);

import { RequestRunner } from '../src/core/request-runner.js';
import { RETRY_CONFIG } from '../src/foundation/retry.js';
import {
    installBrowserRuntimeStub,
    makeNotifyRecorder,
    makeSummarySettings,
} from './test-helpers.js';

describe('RequestRunner.run outcomes', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        for (const mock of Object.values(attemptMocks)) {
            mock.mockReset();
        }
        delete globalThis.toastr;
        delete globalThis.$;
    });

    function makeRequest({ signal, notify } = {}) {
        return {
            settings: makeSummarySettings(),
            systemPrompt: 'system',
            prompt: 'prompt',
            repairPrompt: 'repair',
            signal: signal ?? new AbortController().signal,
            metadata: { kind: 'layer0' },
            notify,
        };
    }

    it('returns completed with the summary text on a first-attempt success', async () => {
        installBrowserRuntimeStub();
        attemptMocks.runSingleAttempt.mockResolvedValue({
            success: true,
            result: 'THE SUMMARY',
            error: undefined,
            cleanedResult: 'THE SUMMARY',
        });

        const outcome = await new RequestRunner().run(makeRequest());

        expect(outcome).toEqual({ status: 'completed', text: 'THE SUMMARY' });
        expect(attemptMocks.runSingleAttempt).toHaveBeenCalledOnce();
    });

    it('returns aborted for an already-aborted signal without attempting', async () => {
        const recorder = makeNotifyRecorder();
        installBrowserRuntimeStub();
        const controller = new AbortController();
        controller.abort();

        const outcome = await new RequestRunner().run(
            makeRequest({ signal: controller.signal, notify: recorder }),
        );

        expect(outcome).toEqual({ status: 'aborted' });
        expect(attemptMocks.runSingleAttempt).not.toHaveBeenCalled();
        expect(recorder.events).toEqual([{ type: 'transient', kind: 'run-aborted' }]);
    });

    it('returns blocked when the Easy context guard rejects the request', async () => {
        const recorder = makeNotifyRecorder();
        installBrowserRuntimeStub();
        attemptMocks.runSingleAttempt.mockResolvedValue({
            success: false,
            error: Object.assign(new Error('blocked'), { easyContextGuard: true }),
            aborted: false,
            shouldRetry: false,
            hardFailover: false,
        });

        const outcome = await new RequestRunner().run(makeRequest({ notify: recorder }));

        expect(outcome).toEqual({ status: 'blocked' });
        expect(attemptMocks.runSingleAttempt).toHaveBeenCalledOnce();
        expect(recorder.events).toEqual([]);
    });

    it('returns failed on a non-retryable error without the guard', async () => {
        const recorder = makeNotifyRecorder();
        installBrowserRuntimeStub();
        attemptMocks.runSingleAttempt.mockResolvedValue({
            success: false,
            error: new Error('bad request'),
            aborted: false,
            shouldRetry: false,
            hardFailover: false,
        });

        const outcome = await new RequestRunner().run(makeRequest({ notify: recorder }));

        expect(outcome).toEqual({ status: 'failed', attempts: 1 });
        expect(attemptMocks.runSingleAttempt).toHaveBeenCalledOnce();
        expect(recorder.events).toEqual([
            {
                type: 'transient',
                kind: 'run-failed',
                retriesExhausted: false,
                attempts: 1,
                status: null,
            },
        ]);
    });

    it('returns failed after exhausting retries for retryable errors', async () => {
        const recorder = makeNotifyRecorder();
        installBrowserRuntimeStub();
        attemptMocks.runSingleAttempt.mockResolvedValue({
            success: false,
            error: new Error('timeout'),
            aborted: false,
            shouldRetry: true,
            hardFailover: false,
        });

        const outcome = await new RequestRunner().run(makeRequest({ notify: recorder }));

        expect(outcome).toEqual({ status: 'failed', attempts: RETRY_CONFIG.maxRetries + 1 });
        expect(attemptMocks.runSingleAttempt).toHaveBeenCalledTimes(RETRY_CONFIG.maxRetries + 1);
        expect(recorder.events).toEqual([
            {
                type: 'transient',
                kind: 'run-failed',
                retriesExhausted: true,
                attempts: RETRY_CONFIG.maxRetries + 1,
                status: null,
            },
        ]);
    });
});
