import { MalfunctionError } from 'helpful-errors';

import type { MutexKey } from '../domain.objects/MutexKey';
import { asError } from './asError';

/**
 * .what = build the MalfunctionError for an UNEXPECTED cache-backend fault on the acquire path —
 *         either the put-if-absent write or the follow-up version read — that names where it
 *         faulted and the fix, with the raw error carried as `cause` (rule.forbid.failhide + failloud)
 * .why = the acquire path had two structurally-parallel fault throws (the put-if-absent in
 *        tryPutIfAbsent, the version read in readVersion) that had drifted into two idioms — a bare
 *        `new MalfunctionError` vs `MalfunctionError.wrap`. this is the exact asymmetry the release
 *        path already solved with the named pure transformer `asReleaseFault`; this is its acquire
 *        twin, so both paths shape faults through one named transformer instead of two ad-hoc idioms.
 * .note = messages name the fix per rule.require.errors-name-the-fix, and differ by phase because the
 *         safe-retry story differs: a failed put-if-absent did NOT take the lock (retry is plainly
 *         safe), while a failed version read may sit just after a won write (a retry re-acquires, or
 *         the lease lapses and frees it) — so the two hints must not be collapsed into one.
 */
export const asAcquireFault = (input: {
  key: MutexKey;
  phase: 'put-if-absent' | 'version-read';
  cause: unknown;
  // returns Error (the honest supertype): each branch constructs a MalfunctionError with the same
  // metadata generic; callers throw it and tests assert `instanceof MalfunctionError` at runtime.
}): Error => {
  const { key, phase, cause } = input;

  // the put-if-absent write faulted: the lock was NOT taken, so a retry is unambiguously safe
  if (phase === 'put-if-absent')
    return new MalfunctionError(
      'withSimpleMutex: the cache backend faulted while it acquired the lock. check the cache backend health and connectivity, then retry; the lock was not taken, so a retry is safe.',
      { key, cause: asError(cause) },
    );

  // the version read faulted: it sits just after a won write, so the retry story is the two-outcome
  // form (a retry re-acquires the key, or the lease lapses on its own and frees it)
  return new MalfunctionError(
    'withSimpleMutex: the cache backend faulted while it read the lock version on acquire. check the cache backend health and connectivity, then retry; a retry re-acquires the key, or the lease lapses and frees it.',
    { key, cause: asError(cause) },
  );
};
