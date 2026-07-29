import { createHash } from 'node:crypto';

/**
 * .what = casts a caller's lock key into a key that is safe for any cache backend
 * .why =
 *   - the on-disk backend rejects keys with special characters: the key becomes a
 *     file/object name, so only [a-zA-Z0-9._-] are valid. yet callers want to write
 *     human-readable keys like `proxy-phone.+14632270513` (the `+` alone would throw).
 *   - so we cast the caller's key into a safe form the mutex owns. we keep a readable,
 *     sanitized prefix for 3am observability, then add a hash of the *original* key so
 *     that two distinct keys which sanitize to the same string never collide
 *     (sanitization is lossy: `a+b` and `a-b` both sanitize to `a-b`).
 */
export const asSafeMutexKey = (input: { key: string }): string => {
  // hash the original for collision-safety (sanitization is lossy)
  const hash = createHash('sha256')
    .update(input.key)
    .digest('hex')
    .slice(0, 16);

  // build a readable, sanitized, length-bounded prefix
  const readable = input.key.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64);

  // combine into a namespaced, backend-safe key
  return `mutex.${readable}.${hash}`;
};
