import { MalfunctionError } from 'helpful-errors';

import type { MutexKey } from '../domain.objects/MutexKey';
import { asError } from './asError';

/**
 * .what = build the MalfunctionError for a lock release that faulted, optionally combined with a
 *         primary error from the critical section — neither fault is ever hidden (rule.forbid.failhide)
 * .why = the success-path (only the release faulted) and the catch-path (the critical section failed
 *        AND the release faulted) were two structurally-parallel blocks that had already drifted once
 *        (see the earlier cause-coercion fix). one parameterized transformer removes the duplication
 *        and the chance they diverge again; `primary: null` selects the success-path message, a
 *        `{ error }` bag selects the combined-path message.
 * .note = `primary` is `null` (not an omitted optional) for the success path, per
 *         rule.forbid.undefined-inputs — the caller must consciously state "there is no primary".
 */
export const asReleaseFault = (input: {
  key: MutexKey;
  releaseError: unknown;
  primary: { error: unknown } | null;
  // returns Error (the honest supertype): each branch constructs a MalfunctionError with a
  // branch-specific metadata generic, so a single MalfunctionError<...> annotation cannot cover
  // both; callers throw it and tests assert `instanceof MalfunctionError` at runtime.
}): Error => {
  const { key, releaseError, primary } = input;

  // errors carry the whole `{ given, used }` key: `given` so a caller can grep logs for the key
  // they passed, `used` for backend debug (rule.require.errors-name-the-fix).

  // combined path: the critical section failed AND the release faulted. the section's error is the
  // PRIMARY one the caller must act on, so it is the `cause`; both fault messages stay legible.
  if (primary)
    return new MalfunctionError(
      'withSimpleMutex: the critical section failed and the lock release also failed. investigate the primary error (the cause) first; the lock is not leaked — it lapses on its own via the lease, so retry only if the primary error is retryable.',
      {
        key,
        cause: asError(primary.error),
        primaryError: asError(primary.error).message,
        releaseError: asError(releaseError).message,
      },
    );

  // success path: the critical section succeeded, only the release faulted. the message carries the
  // load-critical signal (the work is done; a retry only re-clears the lock, which also lapses on
  // its own via the lease), and the release fault is the `cause` — surfaced, never hidden.
  return new MalfunctionError(
    'withSimpleMutex: the critical section succeeded but the lock release failed — the work is done; a retry only re-clears the lock, which also lapses on its own via the lease.',
    {
      key,
      cause: asError(releaseError),
      releaseError: asError(releaseError).message,
    },
  );
};
