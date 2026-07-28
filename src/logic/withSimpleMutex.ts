import type { IsoDuration } from 'iso-time';
import type { SimpleCache, WithCacheConditionals } from 'with-simple-cache';

import { asError } from './asError';
import { asMutexTimeBudget } from './asMutexTimeBudget';
import { asReleaseFault } from './asReleaseFault';
import { asSafeMutexKey } from './asSafeMutexKey';
import { delMutexLock } from './delMutexLock';
import { genLeaseDeadline } from './genLeaseDeadline';
import { genMutexLock } from './genMutexLock';
import { genMutexLockValue } from './genMutexLockValue';

/**
 * .what = run a critical section while a distributed lock over a key is held, so
 *         concurrent holders serialize instead of collide
 * .why =
 *   - serializes access to a shared resource across processes and machines (the
 *     motivating case: stop two integration test suites from a shared-external-
 *     account collision)
 *   - correctness rests on the cache's atomic conditional write, so exactly one
 *     holder wins the key — no settle-then-verify, no timing assumptions
 *   - the isolation scope is inherited from the cache backend: in-memory locks a
 *     process, on-disk locks a machine, s3 locks globally
 * .note = this is a lease lock, not a fenced lock. it is atomic on acquire (one
 *         winner), but it hands out no monotonic fencing token, so under a process
 *         pause longer than the lease a stolen-then-resumed holder cannot be fended
 *         off at a downstream store. it makes contention safe and rare, not
 *         impossible under arbitrary pauses. size lease above the critical section's
 *         worst-case duration.
 * .note = the `(logic, options)` signature is the sanctioned shape for a `with*` HOF
 *         wrapper — `rule.require.input-context-pattern` / `rule.require.get-set-gen-verbs`
 *         explicitly EXEMPT `with*` wrappers (withLogTrail, withRetry, withSimpleCache) from
 *         the leaf `(input, context)` contract. it is the RETURNED function that is the leaf,
 *         and it takes `(input)`. this shape is also the authoritative readme contract.
 */
export const withSimpleMutex = <TInput, TOutput>(
  logic: (input: TInput) => Promise<TOutput>,
  options: {
    /**
     * getter for the lock key from the input; same key → serialized
     */
    key: (input: TInput) => string;

    /**
     * any cache that advertises conditional writes (WithCacheConditionals); the
     * cache backend also fixes the lock's isolation scope (process/machine/global)
     */
    cache: WithCacheConditionals<SimpleCache<string>>;

    /**
     * lease lifetime; a lock older than this is treated as stale and takeable.
     * default { minutes: 30 }. size it above the critical section's worst case
     */
    lease?: { duration?: IsoDuration };

    /**
     * acquire budget: how long to keep the acquire retries going (timeout) and how
     * often to retry between attempts (interval), before a
     * SimpleMutexAcquireTimeoutError is thrown.
     * defaults: timeout = none (wait until the key frees), interval = { seconds: 1 }
     */
    acquire?: { timeout?: IsoDuration; interval?: IsoDuration };
  },
): ((input: TInput) => Promise<TOutput>) => {
  return async (input: TInput): Promise<TOutput> => {
    const { cache } = options;

    // the lock key has two facets: `given` is the caller's original key (what they recognize +
    // grep logs for), `used` is the backend-safe form the mutex actually keys the cache on. every
    // error carries the whole `{ given, used }` so a caller finds their own key AND the safe form.
    const given = options.key(input);
    const key = { given, used: asSafeMutexKey({ key: given }) };

    // derive the lease + acquire budgets (defaults: 30m lease, 1s poll, wait-forever)
    const { leaseDuration, leaseMse, intervalMse, timeoutMse } =
      asMutexTimeBudget({
        lease: options.lease ?? null,
        acquire: options.acquire ?? null,
      });

    // mint a unique lock value so a holder can prove the lease is ours
    const value = JSON.stringify(genMutexLockValue());

    // acquire the key atomically (poll until free or timeout), capture our version
    const { version } = await genMutexLock(
      { key, value, leaseDuration, intervalMse, timeoutMse },
      { cache },
    );

    // one release attempt, faults captured (null if clean), so both exit paths share one shape.
    // delMutexLock already allowlists the one EXPECTED miss (a rival owns the key) as a safe no-op,
    // so any error captured here is an UNEXPECTED backend/IO fault — never hidden (rule.forbid.failhide).
    const attemptRelease = (): Promise<Error | null> =>
      delMutexLock({ key: key.used, version }, { cache }).then(
        () => null,
        (error: unknown) => asError(error),
      );

    // race the critical section against the local lease deadline. cancel the deadline the
    // instant the race settles (via `.finally`, before any further await) so the timer can
    // never fire once the release step begins — this closes the window where a late rejection
    // could linger past the critical section (rule.forbid.behavior-hazards).
    //
    // .note = no explicit handler is attached to the abandoned branch: Promise.race registers a
    //   rejection reaction on EVERY input promise (ecma-262 Promise.race → PerformPromiseThen on
    //   each), so if the deadline wins and the work rejects LATER, that late rejection is
    //   consumed by the reaction race already attached — it is handled, never an unhandled
    //   rejection, and never silently absorbed by any catch of ours. js promises are not
    //   cancellable, so the work still runs on after a deadline win (lease lock, not fenced lock).
    //
    // .note = the work is invoked as `Promise.resolve().then(() => logic(input))`, NOT as a bare
    //   `logic(input)` element. a caller may hand us a non-async `logic` that THROWS synchronously
    //   (e.g. a top guard clause). a bare `logic(input)` would throw at array-construction time,
    //   BEFORE Promise.race exists — so `.finally` (cancel the deadline) and `.catch` (release the
    //   lock) would never attach, the deadline timer would leak, and the lock would sit held until
    //   native expiration. the `.then` normalizes a synchronous throw into a rejection that enters
    //   the same chain, so every exit path releases the lock (rule.forbid.failhide).
    const lease = genLeaseDeadline({ key, leaseMse });
    const work = Promise.resolve().then(() => logic(input));

    const result = await Promise.race([work, lease.deadline])
      .finally(() => lease.cancel())
      .catch(async (workError) => {
        // the critical section (or the lease deadline) failed — that error is the PRIMARY one the
        // caller must act on. still release the lock; if the release ALSO faults, NEITHER error may
        // be hidden (rule.forbid.failhide), so asReleaseFault raises a combined fault carrying the
        // primary as its `cause`. a clean release re-raises the primary alone (common path unchanged).
        const releaseError = await attemptRelease();
        if (releaseError)
          throw asReleaseFault({
            key,
            releaseError,
            primary: { error: workError },
          });
        throw workError;
      });

    // success path: the critical section COMPLETED. release the lock; if the release faults with an
    // UNEXPECTED backend error, surface it — never hidden (rule.forbid.failhide) — but WRAPPED via
    // asReleaseFault so the message states the work already succeeded and a retry only re-clears the
    // lock. correctness stays safe regardless: the key also lapses on its own via native expiration.
    const releaseError = await attemptRelease();
    if (releaseError)
      throw asReleaseFault({ key, releaseError, primary: null });
    return result;
  };
};
