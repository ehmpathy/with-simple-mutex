import { MalfunctionError } from 'helpful-errors';
import {
  getDuration,
  type IsoDuration,
  now,
  sleep,
  toMilliseconds,
} from 'iso-time';
import type { SimpleCache, WithCacheConditionals } from 'with-simple-cache';

import type { MutexKey } from '../domain.objects/MutexKey';
import { SimpleMutexAcquireTimeoutError } from '../domain.objects/SimpleMutexAcquireTimeoutError';
import { asAcquireFault } from './asAcquireFault';
import { getOneMutexPollWaitMse } from './getOneMutexPollWaitMse';
import { isSimpleCacheConditionError } from './isSimpleCacheConditionError';

/**
 * .what = acquire the lock for a key via atomic put-if-absent, poll until free or timeout
 * .why =
 *   - exactly one holder wins the key atomically: set with condition.version=null is
 *     "write only if absent", so concurrent acquirers cannot both win.
 *   - a lost race is expected control flow, not an error — the cache throws
 *     SimpleCacheConditionError on a precondition miss, which we catch and treat as
 *     "held by someone else"; we then poll on an interval until the acquire window ends.
 *   - staleness is handled by the cache's native expiration (v1 has no manual steal):
 *     an expired lock reads as absent, so put-if-absent naturally reclaims it.
 * .note = returns the version token captured right after our won write, so release
 *         can compare-and-delete only if the lock is still ours.
 * .note = `key` has two facets — `key.used` is the backend-safe key the cache is keyed on;
 *         `key.given` is the caller's ORIGINAL key. errors carry the whole `{ given, used }` so a
 *         caller can grep logs for the key they passed AND see the safe form
 *         (rule.require.errors-name-the-fix + rule.forbid.friction-hazards).
 * .note = this acquire loop is NOT built on iso-time's `waitFor(extractor, { interval, timeout })`,
 *         though its poll-until-non-undefined-or-timeout shape looks similar. three needs make the
 *         bespoke loop correct here: (1) a mutex-owned SimpleMutexAcquireTimeoutError on timeout, not
 *         a generic WaitForTimedOutError; (2) deliberate poll jitter (below) so an s3-tier herd does
 *         not wake in lockstep; (3) an exact-timeout clamp on the final sleep so the loop gives up AT
 *         the declared deadline, not a full interval past it. a blind `waitFor` swap would regress the
 *         typed error and the exact clamp, so the loop stays explicit (rule.require.read-package-docs-before-use).
 */
export const genMutexLock = async (
  input: {
    key: MutexKey;
    value: string;
    leaseDuration: IsoDuration;
    intervalMse: number;
    timeoutMse: number | null;
  },
  context: { cache: WithCacheConditionals<SimpleCache<string>> },
): Promise<{ version: string }> => {
  const { key, value, leaseDuration, intervalMse, timeoutMse } = input;
  const { cache } = context;

  // note when we began, to enforce the acquire timeout. read the clock via iso-time `now()`
  // (rule.require.iso-time / rule.forbid.any-time — no raw Date.now() in domain logic), and
  // measure elapsed via `getDuration` over the range so the acquire math stays in the glossary.
  const startedAt = now();

  // retry until we win the key or exhaust the acquire window
  while (true) {
    // attempt an atomic put-if-absent for this holder
    const won = await tryPutIfAbsent({ key, value, leaseDuration }, { cache });

    // if we won, capture our version token and hand it back for release. a raw fault from the
    // backend's version read is UNEXPECTED here — readVersion shapes it via asAcquireFault so the
    // caller sees an actionable "faulted on acquire" signal, not a bare "ECONNRESET"
    // (rule.forbid.friction-hazards + failloud). the miss-case (undefined) is the distinct
    // lease-too-short guard below.
    if (won) {
      const version = await readVersion({ key }, { cache });
      if (version === undefined)
        throw new MalfunctionError(
          'withSimpleMutex: won the mutex key but its lease already lapsed before we could read its version — the lease is too short for this environment. raise lease.duration above the critical section worst-case runtime, or shorten the section.',
          { key },
        );
      return { version };
    }

    // give up if we have exceeded the acquire timeout
    const waitedMse = toMilliseconds(
      getDuration({ of: { range: { since: startedAt, until: now() } } }),
    );
    if (timeoutMse !== null && waitedMse >= timeoutMse)
      throw new SimpleMutexAcquireTimeoutError(
        `could not acquire the mutex lock within the acquire timeout (waited ${waitedMse}ms). the key is held by another caller; to wait longer raise acquire.timeout (or unset it to wait until the key frees), or lower contention on this key.`,
        { key, waitedMse },
      );

    // wait a poll interval, then retry. the wait is jittered into [50%, 100%) of the interval AND
    // clamped to the time left in the acquire budget — the pure math lives in getOneMutexPollWaitMse
    // (jitter avoids a lockstep herd on the s3 tier; the clamp gives up AT the deadline, not a full
    // interval past it). Math.random() is supplied here so the transformer stays deterministic.
    const waitMse = getOneMutexPollWaitMse({
      intervalMse,
      timeoutMse,
      waitedMse,
      jitterFactor: 0.5 + Math.random() * 0.5,
    });
    await sleep({ milliseconds: waitMse });
  }
};

/**
 * .what = try one atomic put-if-absent; true if we won the key, false if it was held
 * .why = isolates the "lost race is expected" catch so the acquire loop reads as narrative
 */
const tryPutIfAbsent = async (
  input: {
    key: MutexKey;
    value: string;
    leaseDuration: IsoDuration;
  },
  context: { cache: WithCacheConditionals<SimpleCache<string>> },
): Promise<boolean> => {
  const { key, value, leaseDuration } = input;
  const { cache } = context;

  // write only if the key is absent, with the lease as the native expiration
  try {
    await cache.set(key.used, value, {
      expiration: leaseDuration,
      condition: { version: null },
    });
    return true;
  } catch (error) {
    // a precondition miss means someone else holds the key — expected, not a failure
    if (isSimpleCacheConditionError(error)) return false;

    // any other error is a REAL backend fault — never hidden (rule.forbid.failhide), and shaped by
    // asAcquireFault so the caller sees an actionable "faulted on acquire" signal rather than a bare
    // backend error with no clue it happened inside the lock (rule.forbid.friction-hazards).
    throw asAcquireFault({ key, phase: 'put-if-absent', cause: error });
  }
};

/**
 * .what = read the current version token for a key, and shape any raw backend fault via asAcquireFault
 * .why = the version read sits on the acquire path; an UNEXPECTED backend error here (network, io)
 *        must reach the caller LOUD and actionable — with the key and the fact that it occurred on
 *        acquire — not as a bare "ECONNRESET" (rule.forbid.friction-hazards + failloud). the async
 *        try/catch handles both a sync throw and an async rejection, since `version` may be sync
 *        (in-memory) or async (on-disk): a sync throw from the call is caught here, and an awaited
 *        rejection is caught the same way.
 * .note = every fault here is UNEXPECTED (unlike tryPutIfAbsent, which must first allowlist the
 *         EXPECTED condition-miss), so the catch shapes ALL of them through asAcquireFault — the same
 *         named transformer the put-if-absent path uses, so the two acquire faults share one idiom
 *         (the acquire twin of asReleaseFault).
 */
const readVersion = async (
  input: { key: MutexKey },
  context: { cache: WithCacheConditionals<SimpleCache<string>> },
): Promise<string | undefined> => {
  try {
    return await context.cache.version(input.key.used);
  } catch (error) {
    throw asAcquireFault({
      key: input.key,
      phase: 'version-read',
      cause: error,
    });
  }
};
