import type { SimpleCache, WithCacheConditionals } from 'with-simple-cache';

import { isSimpleCacheConditionError } from './isSimpleCacheConditionError';

/**
 * .what = release the lock — compare-and-delete on our version, only if it is still ours
 * .why =
 *   - an unconditional delete could remove a rival's lock: if our lease lapsed and a
 *     rival then acquired the key, deleting it would free their hold, not ours.
 *   - so we delete only when the stored version still matches the one we captured at
 *     acquire. a version mismatch (SimpleCacheConditionError) means the key is no longer
 *     ours — safe to ignore, since none of it is ours left to release.
 * .note = `key` here is a bare `string` — the backend-safe `used` key alone — NOT the two-facet
 *   `{ given, used }` its siblings (genMutexLock, genLeaseDeadline) carry. that is deliberate: this
 *   is a pure cache operation that only ever touches the backend, so it needs only the key the cache
 *   is keyed on; it never composes a caller-visible error, so it has no use for `given`. the
 *   orchestrator owns the `{ given, used }` map and passes `key.used` here (withSimpleMutex.ts); any
 *   release fault this raises is re-wrapped one level up by asReleaseFault, which re-attaches the
 *   full `{ given, used }`. so the narrower shape is the most-common-denominator input, not a gap.
 */
export const delMutexLock = async (
  input: {
    key: string;
    version: string;
  },
  context: { cache: WithCacheConditionals<SimpleCache<string>> },
): Promise<void> => {
  const { key, version } = input;
  const { cache } = context;

  // compare-and-delete: invalidate the key gated on our version
  try {
    await cache.set(key, undefined, { condition: { version } });
  } catch (error) {
    // the lock is no longer ours (expired then reacquired) — expected, safe to ignore
    if (isSimpleCacheConditionError(error)) return;

    // any other error is a real failure — do not hide it
    throw error;
  }
};
