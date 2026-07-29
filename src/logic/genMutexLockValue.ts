import { now } from 'iso-time';

import { randomUUID } from 'node:crypto';
import type { SimpleMutexLock } from '../domain.objects/SimpleMutexLock';

/**
 * .what = mint a fresh lock value for one acquisition — a unique token + the acquire instant
 * .why = the persisted value is a DEBUG/observability record, not the ownership proof. ownership on
 *        release is delegated entirely to the cache's own opaque version/etag: delMutexLock
 *        compare-and-deletes gated on the `version` captured at acquire (delMutexLock.ts), never on
 *        `.token`. the token just labels WHO holds a key for a human who inspects a stuck lock, and
 *        lockedAt dates WHEN — the same account SimpleMutexLock.ts gives: the field serves the 3am
 *        debug, not the acquire/release logic.
 * .note = randomUUID() is DELIBERATE non-determinism (rule.forbid.behavior-hazards: when
 *         non-determinism is required it must be explicit). the token is a unique holder label, so a
 *         fresh value per acquire is the point. it is internal state, never part of the public
 *         contract; tests assert the SHAPE (a uuid token, an iso stamp) and that two mints differ,
 *         not the exact token value, so snapshots stay stable.
 */
export const genMutexLockValue = (): SimpleMutexLock => ({
  token: randomUUID(),
  lockedAt: now(),
});
