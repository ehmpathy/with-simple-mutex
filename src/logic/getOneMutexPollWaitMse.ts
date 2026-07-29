/**
 * .what = derive the next poll-wait (mse) for the acquire loop — the jittered interval,
 *         clamped to the time LEFT in the acquire budget
 * .why =
 *   - keep the pure math OUT of the async acquire loop, so genMutexLock reads as narrative
 *     (attempt → return-if-won → give-up-if-expired → sleep(wait)) and this clamp earns a
 *     direct, deterministic unit test instead of a wall-clock integration assertion alone.
 *   - jitter: scale the interval by a factor in [0.5, 1) so many rivals that race for ONE key
 *     do not wake in lockstep — a herd that, on the s3-global tier, multiplies a real per-poll
 *     network cost by the count of losers. the factor is <= 1, so jitter never widens the wait.
 *   - clamp: cap the wait at the time LEFT in the acquire budget so the loop re-checks the
 *     deadline exactly at the declared timeout, not a full interval past it (rule.forbid.surprises).
 * .note = the jitter factor is an INPUT, not read from Math.random() here, so this stays a pure
 *         deterministic derivation: the caller passes `0.5 + Math.random() * 0.5`, and a unit test
 *         passes fixed factors to pin the exact clamp. no timer is armed and no state mutates.
 * .note = name: a deterministic derivation is a `get` compute-subtype per
 *         rule.require.get-set-gen-verbs (its own example casts `computeNextIndex` →
 *         `getOneCloneNextIndex`). it is NOT `compute*` — define.domain-operation-core-variants
 *         reserves that prefix for projects that also carry imagine* leaves, and this project is
 *         fully deterministic. it is not `as*` either, since this derives a value, not a shape.
 */
export const getOneMutexPollWaitMse = (input: {
  intervalMse: number;
  timeoutMse: number | null;
  waitedMse: number;
  jitterFactor: number;
}): number => {
  const { intervalMse, timeoutMse, waitedMse, jitterFactor } = input;

  // scale the interval by the supplied jitter factor (<= 1, so it never widens the wait)
  const jitteredIntervalMse = intervalMse * jitterFactor;

  // the time LEFT in the acquire budget; unbounded when no timeout is set
  const leftMse =
    timeoutMse === null ? jitteredIntervalMse : timeoutMse - waitedMse;

  // give up AT the deadline: never sleep past the time left in the budget
  return Math.min(jitteredIntervalMse, leftMse);
};
