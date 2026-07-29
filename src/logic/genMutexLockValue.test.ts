import { isIsoTimeStamp } from 'iso-time';

import { genMutexLockValue } from './genMutexLockValue';

/**
 * .what = unit tests for genMutexLockValue (mint a fresh lock value)
 * .why = the token's uniqueness per acquire is the lock's safety property; these assert the SHAPE
 *        and the per-mint uniqueness, never the exact non-deterministic token value
 */
describe('genMutexLockValue', () => {
  test('mints a uuid token and an iso-8601 lockedAt stamp', () => {
    const lock = genMutexLockValue();
    expect(lock.token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(isIsoTimeStamp(lock.lockedAt)).toBe(true);
  });

  test('mints a DISTINCT token on each call (safety: no two holders share a token)', () => {
    const first = genMutexLockValue();
    const second = genMutexLockValue();
    expect(first.token).not.toEqual(second.token);
  });
});
