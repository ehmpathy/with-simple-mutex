import { MalfunctionError } from 'helpful-errors';

import { asAcquireFault } from './asAcquireFault';

/**
 * .what = unit tests for asAcquireFault (pure fault-composer for a failed acquire-path backend call)
 * .why = the two phases (put-if-absent, version-read) must each surface the raw fault with a stable
 *        shape and a message that names the fix, and the fix differs by phase — the acquire twin of
 *        asReleaseFault, so both paths shape faults through one named transformer (neither hidden)
 */
describe('asAcquireFault', () => {
  describe('put-if-absent phase (the write faulted, lock NOT taken)', () => {
    const fault = asAcquireFault({
      key: { given: 'k', used: 'mutex.k' },
      phase: 'put-if-absent',
      cause: new Error('socket hang up'),
    });

    test('is a MalfunctionError that names the acquire and states retry is safe', () => {
      expect(fault).toBeInstanceOf(MalfunctionError);
      expect(fault.message).toContain('faulted while it acquired the lock');
      expect(fault.message).toContain(
        'the lock was not taken, so a retry is safe',
      );
    });

    test('carries the raw error as its cause', () => {
      expect((fault.cause as Error).message).toEqual('socket hang up');
    });

    test('carries the whole { given, used } key in metadata', () => {
      expect((fault as MalfunctionError).metadata?.key).toEqual({
        given: 'k',
        used: 'mutex.k',
      });
    });
  });

  describe('version-read phase (the read faulted, just after a won write)', () => {
    const fault = asAcquireFault({
      key: { given: 'k', used: 'mutex.k' },
      phase: 'version-read',
      cause: new Error('socket hang up'),
    });

    test('is a MalfunctionError that names the version read and its two-outcome retry', () => {
      expect(fault).toBeInstanceOf(MalfunctionError);
      expect(fault.message).toContain(
        'faulted while it read the lock version on acquire',
      );
      expect(fault.message).toContain('a retry re-acquires the key');
    });

    test('carries the raw error as its cause', () => {
      expect((fault.cause as Error).message).toEqual('socket hang up');
    });
  });

  describe('non-Error throws (coerced via asError)', () => {
    test('coerces a non-Error cause into a stable Error cause', () => {
      const fault = asAcquireFault({
        key: { given: 'k', used: 'mutex.k' },
        phase: 'put-if-absent',
        cause: 'raw string boom',
      });
      expect(fault.cause).toBeInstanceOf(Error);
      expect((fault.cause as Error).message).toContain('raw string boom');
    });
  });
});
