/**
 * Structured result of one run level: summarizer request, batch commit,
 * promotion drain, or auto cycle. Producers fill the count fields they know.
 * The summarizer response `text` never travels above the request runner.
 * @typedef {object} SummarizationRunOutcome
 * @property {'completed' | 'aborted' | 'blocked' | 'failed' | 'idle'} status - Terminal run status; `idle` marks no eligible work.
 * @property {number} [attempts] - Promotions attempted by a drain.
 * @property {number} [completed] - Batches committed successfully.
 * @property {number} [failed] - Batches that failed.
 * @property {number} [totalBatches] - Batches planned for the run.
 */
export {};
