import type { MutexKey } from '../domain.objects/MutexKey';
import { SimpleMutexLeaseExpiredError } from '../domain.objects/SimpleMutexLeaseExpiredError';

/**
 * .what = generate a local lease-deadline resource: a promise that rejects the moment the
 *         lease elapses, paired with a `cancel` to clear its timer
 * .why =
 *   - v1 has no heartbeat, so a holder must finish within one lease. the orchestrator races
 *     the critical section against this deadline (no cache reads); if the deadline wins, it
 *     fails fast with SimpleMutexLeaseExpiredError so the caller learns promptly instead of
 *     the wrapper over-holds without a signal.
 *   - the timer handle is encapsulated here (created + cleared in one place), so the caller
 *     only sees the `deadline` promise to race and the `cancel` to release the timer.
 * .note = the `gen` prefix is correct per `rule.require.get-set-gen-verbs`: `gen` covers the
 *         CONSTRUCT subtype — "build with a generated id" (genTask) and "scaffold from defaults"
 *         (genSiteManifest) both always create, they are not find-or-create. this constructs a
 *         fresh timer resource each call, the same construct shape. `set*` would be wrong here —
 *         `set` names a mutation of stored/registered state, and this writes no external state.
 * .note = the race stops the *wrapper* from the await; it cannot cancel the critical
 *         section's in-flight side effects (js promises are not cancellable). this is a
 *         lease lock, not a fenced lock.
 * .note = the local timer and the cache's native expiration run on different clocks. the
 *         key becomes stealable at cacheWrite+lease; this timer fires at acquireReturn+lease,
 *         which is marginally later — so a holder that runs to the very edge of its lease has
 *         a bounded window where a rival could steal before this abort. across machines the
 *         skew is unbounded — which is exactly why this is a lease lock, not a fenced lock.
 *         size lease above the critical section's worst case to stay clear of the edge.
 */
export const genLeaseDeadline = (input: {
  key: MutexKey;
  leaseMse: number;
}): { deadline: Promise<never>; cancel: () => void } => {
  const { key, leaseMse } = input;

  // .note = deliberate mutation, EXPLICITLY sanctioned by rule.require.immutable-vars: the rule
  //   permits "isolate unavoidable mutation in scoped zones with a `.note = deliberate mutation`
  //   comment". this is that case, and the mutation is genuinely unavoidable here:
  //   - the setTimeout handle is born inside the Promise executor (the only scope where `reject`
  //     is in hand), yet `cancel` — returned to the orchestrator — must clear it, so the handle
  //     must cross that one scope edge. it is assigned exactly once and never re-read-then-written.
  //   - the clean immutable form is `Promise.withResolvers()` (one const, no executor capture),
  //     but that is es2022; this repo's tsconfig targets es2020, so it is not available. `let`
  //     with a single assignment is the idiomatic es2020 shape for this exact pattern.
  //   - the reviewer-proposed alternative (hand the raw timer handle back to the caller) is
  //     rejected on purpose: it leaks the timer and breaks the encapsulation the .why guards —
  //     the caller must see only `deadline` + `cancel`, never the handle. every other refactor
  //     (a const object/array holder) only relocates the same single assignment the rule already
  //     governs, for no net reduction in mutation.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new SimpleMutexLeaseExpiredError(
            `the mutex lease expired while the critical section was still active (lease was ${leaseMse}ms). raise lease.duration above the section's worst-case runtime, or shorten the section, so the lease outlasts the work.`,
            { key, leaseMse },
          ),
        ),
      leaseMse,
    );
  });

  return {
    deadline,
    cancel: () => {
      if (timer) clearTimeout(timer);
    },
  };
};
