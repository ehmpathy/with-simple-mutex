import type { IsoTimeStamp } from 'iso-time';

/**
 * .what = the value persisted under a locked key while a holder owns the lease
 * .why =
 *   - token uniquely identifies this holder, for human observability of who holds a key
 *   - lockedAt dates the lease, so an operator who inspects a stuck lock can see when
 *     it was taken (v1 leans on the cache's native expiration for staleness, not this
 *     field — it exists for the 3am debug, not for the acquire/release logic)
 */
export interface SimpleMutexLock {
  /**
   * a unique token minted per holder per acquisition
   */
  token: string;

  /**
   * the wall-clock instant the lease was taken (iso-8601 stamp)
   */
  lockedAt: IsoTimeStamp;
}
