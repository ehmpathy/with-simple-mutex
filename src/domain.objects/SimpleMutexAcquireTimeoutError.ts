import { ConstraintError } from 'helpful-errors';

import type { MutexKey } from './MutexKey';

/**
 * .what = the error thrown when a lock cannot be taken within the acquire timeout
 * .why = a caller that cannot get the lock in its allotted window needs a typed,
 *        catchable signal — distinct from an error thrown by the critical section
 *        itself — so it can back off, fail fast, or escalate deliberately
 * .note = extends ConstraintError (caller-domain, exit 2): the remedy is the caller's to
 *         apply — raise acquire.timeout, lower contention, or (the run-once idiom) catch it
 *         as a deliberate skip. it is not a system malfunction; the lock behaved correctly.
 *         every error this library throws is a ConstraintError or a MalfunctionError.
 */
export class SimpleMutexAcquireTimeoutError extends ConstraintError<{
  /**
   * the lock key, in both facets: `given` is the caller's original key (grep-able in their
   * logs), `used` is the backend-safe form the cache was keyed on
   */
  key: MutexKey;

  /**
   * how long we waited (milliseconds) before we gave up
   */
  waitedMse: number;
}> {}
