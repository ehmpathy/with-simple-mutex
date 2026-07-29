import { ConstraintError } from 'helpful-errors';

import type { MutexKey } from './MutexKey';

/**
 * .what = the error thrown when the lease lapses while the critical section is still active
 * .why = the holder stalled past its lease, so a rival could now enter. rather than
 *        let unprotected work run to completion silently, withSimpleMutex fails fast:
 *        it stops the await on the critical section and throws this typed signal.
 * .note = this is a lease lock, not a fenced lock — the throw stops the *wrapper* from
 *         the await, but it cannot cancel the critical section's in-flight side effects
 *         (js promises are not cancellable). size lease above the section's worst case.
 * .note = extends ConstraintError (caller-domain, exit 2): the remedy is the caller's to
 *         apply — raise lease.duration above the section's worst-case runtime, or shorten
 *         the section. the lock behaved correctly (it stole a stalled key and failed the
 *         stalled holder loud), so this is a caller constraint, not a system malfunction.
 *         every error this library throws is a ConstraintError or a MalfunctionError.
 */
export class SimpleMutexLeaseExpiredError extends ConstraintError<{
  /**
   * the lock key, in both facets: `given` is the caller's original key (grep-able in their
   * logs), `used` is the backend-safe form the cache was keyed on
   */
  key: MutexKey;

  /**
   * the lease lifetime (milliseconds) that elapsed
   */
  leaseMse: number;
}> {}
