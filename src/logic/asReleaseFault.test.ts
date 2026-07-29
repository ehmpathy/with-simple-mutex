import { MalfunctionError } from 'helpful-errors';

import { asReleaseFault } from './asReleaseFault';

/**
 * .what = unit tests for asReleaseFault (pure fault-composer for a release that failed)
 * .why = both message variants must surface every fault with a stable shape; these assert the
 *        combined-path and success-path directly at the unit grain (neither fault hidden)
 */
describe('asReleaseFault', () => {
  describe('combined path (the critical section ALSO failed)', () => {
    const fault = asReleaseFault({
      key: { given: 'k', used: 'mutex.k' },
      releaseError: new Error('release boom'),
      primary: { error: new Error('logic boom') },
    });

    test('is a MalfunctionError that names BOTH faults', () => {
      expect(fault).toBeInstanceOf(MalfunctionError);
      expect(fault.message).toContain('logic boom');
      expect(fault.message).toContain('release boom');
    });

    test('carries the PRIMARY (logic) error as its cause', () => {
      expect((fault.cause as Error).message).toEqual('logic boom');
    });

    test('carries the whole { given, used } key in metadata', () => {
      expect((fault as MalfunctionError).metadata?.key).toEqual({
        given: 'k',
        used: 'mutex.k',
      });
    });
  });

  describe('success path (only the release faulted)', () => {
    const fault = asReleaseFault({
      key: { given: 'k', used: 'mutex.k' },
      releaseError: new Error('release boom'),
      primary: null,
    });

    test('states the work succeeded and names the release fault', () => {
      expect(fault).toBeInstanceOf(MalfunctionError);
      expect(fault.message).toContain('succeeded');
      expect(fault.message).toContain('release boom');
    });

    test('carries the release error as its cause', () => {
      expect((fault.cause as Error).message).toEqual('release boom');
    });
  });

  describe('non-Error throws (coerced via asError)', () => {
    test('coerces a non-Error primary and release into stable messages', () => {
      const fault = asReleaseFault({
        key: { given: 'k', used: 'mutex.k' },
        releaseError: 'release string',
        primary: { error: 'logic string' },
      });
      expect(fault.message).toContain('logic string');
      expect(fault.message).toContain('release string');
      expect(fault.cause).toBeInstanceOf(Error);
    });
  });
});
