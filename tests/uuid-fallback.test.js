import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUuid } from '../src/foundation/message-identity.js';

describe('createUuid', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('falls back to getRandomValues when randomUUID is missing (insecure context)', () => {
        const original = globalThis.crypto.randomUUID;
        // @ts-ignore - simulate plain-HTTP browsers where randomUUID is absent
        globalThis.crypto.randomUUID = undefined;
        try {
            const a = createUuid();
            const b = createUuid();
            expect(a).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            );
            expect(a).not.toBe(b);
        } finally {
            globalThis.crypto.randomUUID = original;
        }
    });
});
