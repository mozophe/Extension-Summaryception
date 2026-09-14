import { LOG_PREFIX, MODULE_NAME, defaultSettings } from './constants.js';
import { getExtensionSettings } from './context.js';

function getDebugSettings() {
    try {
        const extensionSettings = getExtensionSettings();
        return extensionSettings[MODULE_NAME] || defaultSettings;
    } catch (_e) {
        return defaultSettings;
    }
}

/**
 * Check whether debug logging is enabled.
 * @returns {boolean}
 */
export function isDebugEnabled() {
    return Boolean(getDebugSettings().debugMode);
}

/**
 * Check whether trace logging is enabled.
 * @returns {boolean}
 */
export function isTraceEnabled() {
    const s = getDebugSettings();
    return Boolean(s.debugMode && s.traceMode);
}

/**
 * Check whether full LLM input logging is enabled.
 * @returns {boolean}
 */
export function isPromptInputLogEnabled() {
    return Boolean(getDebugSettings().promptInputLogMode);
}

/**
 * Check whether full LLM output logging is enabled.
 * @returns {boolean}
 */
export function isPromptOutputLogEnabled() {
    return Boolean(getDebugSettings().promptOutputLogMode);
}

/**
 * Check whether any full LLM prompt/response logging is enabled.
 * @returns {boolean}
 */
export function isPromptLogEnabled() {
    return isPromptInputLogEnabled() || isPromptOutputLogEnabled();
}

/**
 * Emit a low-frequency informational log when debug logging is enabled.
 * @param {...unknown} args - Console arguments
 * @returns {void}
 */
export function info(...args) {
    if (isDebugEnabled()) {
        console.log(LOG_PREFIX, ...args);
    }
}

/**
 * Emit a diagnostic log when debug logging is enabled.
 * @param {...unknown} args - Console arguments
 * @returns {void}
 */
export function debug(...args) {
    if (isDebugEnabled()) {
        console.log(LOG_PREFIX, '[DEBUG]', ...args);
    }
}

/**
 * Emit a high-volume trace log when debug and trace logging are enabled.
 * @param {...unknown} args - Console arguments
 * @returns {void}
 */
export function trace(...args) {
    if (isTraceEnabled()) {
        const normalized = args.map((arg, idx) =>
            idx === 0 && typeof arg === 'string' ? arg.toUpperCase() : arg,
        );
        console.log(LOG_PREFIX, '[TRACE]', ...normalized);
    }
}

/**
 * Emit an always-visible warning.
 * @param {...unknown} args - Console arguments
 * @returns {void}
 */
export function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
}

/**
 * Emit an always-visible error.
 * @param {...unknown} args - Console arguments
 * @returns {void}
 */
export function error(...args) {
    console.error(LOG_PREFIX, ...args);
}

/**
 * Read an HTTP status from an error-like object.
 * @param {Error & { status?: number, statusCode?: number, response?: { status?: number } } | null} node
 * @returns {number | null}
 */
function statusOf(node) {
    return (
        (node && (node.status || node.statusCode || (node.response && node.response.status))) ||
        null
    );
}

/**
 * Read the caller-supplied retryable hint from an error-like object.
 * @param {Error & { retryable?: boolean | (() => boolean) } | null} node
 * @returns {boolean | null}
 */
function retryableOf(node) {
    if (!node) {
        return null;
    }
    if (typeof node.retryable === 'boolean') {
        return node.retryable;
    }
    if (typeof node.retryable === 'function') {
        return node.retryable();
    }
    return null;
}

/**
 * Coerce any thrown value into a plain object with the standard error fields.
 * Procedure: Read the top-level fields, then walk the `cause` chain resolving
 * the deepest informative message and the deepest status found at any level.
 * Cyclic chains stop at the first revisited error.
 * @param {unknown} err - A thrown value. It can be an Error, a plain object, a string, or null.
 * @returns {{ name: string, message: string, status: number|null, retryable: boolean|null }}
 */
export function serializeError(err) {
    const e =
        /** @type {Error & { status?: number, statusCode?: number, retryable?: boolean | (() => boolean), response?: { status?: number }, cause?: unknown }} */ (
            err
        );
    let message = e && e.message ? e.message : String(e);
    let status = statusOf(e);
    const seen = new Set();
    let cursor = /** @type {unknown} */ (e);
    while (cursor && typeof cursor === 'object' && !seen.has(cursor)) {
        seen.add(cursor);
        const node = /** @type {typeof e} */ (cursor);
        if (node.message) {
            message = node.message;
        }
        status = statusOf(node) || status;
        cursor = node.cause;
    }
    return {
        name: (e && e.name) || 'Error',
        message,
        status,
        retryable: retryableOf(e),
    };
}
