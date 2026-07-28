import { ConstraintError } from 'helpful-errors';
import { type IsoDuration, toMilliseconds } from 'iso-time';

/**
 * .what = the largest delay a js timer accepts. node/browser store a `setTimeout` delay in a signed
 *         32-bit int, so any delay above 2^31-1 ms (~24.8 days) — or at/below 0 — is NOT honored:
 *         it is coerced to ~1ms and the timer fires almost immediately.
 * .why = the lease deadline (genLeaseDeadline) and the acquire poll (sleep on intervalMse) both arm a
 *        `setTimeout`. a lease above this max would fire its deadline at ~1ms, the wrapper would
 *        release the still-held lock, and the critical section would run on UNPROTECTED for the rest
 *        of its real duration — a silent mutual-exclusion breach for exactly the long-lease usecase
 *        the vision headlines ("one cron, one migration, one leader"). so we fail fast at the boundary
 *        instead (rule.require.failfast / rule.prefer.prevent-over-correct) rather than let the timer
 *        misfire silently. we do NOT clamp: a silent cap would shorten the lease below what the caller
 *        asked for and cause the same premature-expiry it is meant to prevent.
 * .note = exported so the unit test asserts the boundary against the SAME constant, not a duplicated
 *        literal that could drift from this source of truth.
 */
export const MSE_TIMER_MAX = 2_147_483_647;

/**
 * .what = assert a derived duration-ms is a positive value the platform timer can honor, else throw a
 *         ConstraintError that names the field, the max, and the fix
 * .why = both the lease deadline and the acquire poll arm a js `setTimeout`, which silently misfires
 *        outside (0, MSE_TIMER_MAX]. a caller misconfiguration is theirs to fix, so ConstraintError
 *        (caller-must-fix, exit 2) is the right class, and it names the fix per rule.require.errors-name-the-fix.
 */
const assertMseWithinTimerBounds = (input: {
  field: string;
  mse: number;
}): void => {
  const { field, mse } = input;

  // a non-positive delay fires a js timer at ~1ms, so it is never a valid lease/poll budget
  if (mse <= 0)
    throw new ConstraintError(
      `withSimpleMutex: ${field} must be a positive duration; got ${mse}ms. set ${field} above zero (for the lease, above the critical section's worst-case runtime).`,
      { field, mse },
    );

  // a delay above the 32-bit timer max is coerced to ~1ms, so the lease/poll would misfire at once
  if (mse > MSE_TIMER_MAX)
    throw new ConstraintError(
      `withSimpleMutex: ${field} of ${mse}ms exceeds the platform timer max of ${MSE_TIMER_MAX}ms (~24.8 days), beyond which a js timer silently misfires at ~1ms. set a shorter ${field}, or split the work so the critical section fits within it.`,
      { field, mse, maxMse: MSE_TIMER_MAX },
    );
};

/**
 * .what = derive the concrete lease + acquire time budget (in ms) from the caller's optional durations
 * .why = centralizes the defaults and the IsoDuration→ms boundary casts into one pure transformer,
 *        so the orchestrator reads as narrative and the defaults get a direct unit test rather than
 *        a value reached only transitively through the integration suite (coverage-by-grain).
 * .note = the 30-minute lease default is the AUTHORITATIVE readme contract — readme.md states
 *   `default { minutes: 30 }` on its lease field in three places (the quickstart snippet, the api
 *   signature, and the field table). the older `{ minutes: 5 }` from the pre-readme handoff proposal
 *   was retired; `{ minutes: 5 }` now appears in the readme only as an IsoDuration *shape example*,
 *   not as this default. the vision's field table agrees (30m). acquire defaults: interval = 1s,
 *   timeout = none (null → wait until the key frees).
 * .note = lease + interval are bounds-checked against MSE_TIMER_MAX: both arm a js `setTimeout`,
 *   which misfires silently outside (0, max]. this is the fail-fast boundary for the long-lease
 *   safety breach described on MSE_TIMER_MAX. timeout is NOT bounds-checked here — it is only
 *   compared numerically in the acquire loop (never armed as a timer), so the max does not bite it;
 *   a very long "wait" timeout is a legitimate ask.
 */
export const asMutexTimeBudget = (input: {
  lease: { duration?: IsoDuration } | null;
  acquire: { timeout?: IsoDuration; interval?: IsoDuration } | null;
}): {
  leaseDuration: IsoDuration;
  leaseMse: number;
  intervalMse: number;
  timeoutMse: number | null;
} => {
  const leaseDuration = input.lease?.duration ?? { minutes: 30 };
  const leaseMse = toMilliseconds(leaseDuration);
  const intervalMse = toMilliseconds(input.acquire?.interval ?? { seconds: 1 });

  // fail fast on a lease/poll the platform timer cannot honor (silent-misfire guard)
  assertMseWithinTimerBounds({ field: 'lease.duration', mse: leaseMse });
  assertMseWithinTimerBounds({ field: 'acquire.interval', mse: intervalMse });

  return {
    leaseDuration,
    leaseMse,
    intervalMse,
    timeoutMse: input.acquire?.timeout
      ? toMilliseconds(input.acquire.timeout)
      : null,
  };
};
