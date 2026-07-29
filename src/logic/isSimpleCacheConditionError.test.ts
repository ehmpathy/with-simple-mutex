import { given, then, when } from 'test-fns';
import { SimpleCacheConditionError } from 'with-simple-cache';

import { isSimpleCacheConditionError } from './isSimpleCacheConditionError';

/**
 * .what = unit test for the backend-agnostic precondition-failure guard
 * .why = the guard has two branches — instanceof the canonical class, and a name fallback for
 *        a backend's OWN copy of the class — plus the negative path. all three are pure, so a
 *        unit test verifies the guard without a cache.
 */

// a stand-in for a backend's OWN SimpleCacheConditionError copy: a distinct class whose
// constructor.name matches, so it exercises the name-fallback branch (not the instanceof one).
const asBackendConditionErrorCopy = (message: string): Error => {
  class BackendConditionErrorCopy extends Error {}
  Object.defineProperty(BackendConditionErrorCopy, 'name', {
    value: 'SimpleCacheConditionError',
  });
  return new BackendConditionErrorCopy(message);
};

describe('isSimpleCacheConditionError', () => {
  given(
    '[case1] the canonical SimpleCacheConditionError from with-simple-cache',
    () => {
      when('[t0] the guard inspects it', () => {
        then('it is true (matched by instanceof, the primary branch)', () => {
          const error = new SimpleCacheConditionError('a rival owns the key', {
            key: 'shared',
            condition: { version: null },
            found: 'held',
          });
          expect(isSimpleCacheConditionError(error)).toEqual(true);
        });
      });
    },
  );

  given(
    "[case2] a backend's own copy of the class (same name, different identity)",
    () => {
      when('[t0] the guard inspects it', () => {
        then('it is true (matched by the constructor-name fallback)', () => {
          const error = asBackendConditionErrorCopy('a rival owns the key');
          // sanity: it is genuinely NOT the canonical class, so only the fallback can match it
          expect(error instanceof SimpleCacheConditionError).toEqual(false);
          expect(isSimpleCacheConditionError(error)).toEqual(true);
        });
      });
    },
  );

  given(
    "[case4] a bundler-mangled duplicate copy (the fallback's real failure mode)",
    () => {
      when(
        '[t0] the guard inspects a copy whose class name a minifier mangled',
        () => {
          then(
            'it is false — the accepted, FAIL-LOUD limitation documented in the code .note',
            () => {
              // a real minifier mangles class names (e.g. to `t`), so BOTH the instanceof
              // (across duplicate copies) AND the constructor-name fallback miss. this
              // documents the ACTUAL degraded behavior — unlike case2, which forced the
              // name back to correct and so proved a case that never fails. the degradation
              // is fail-loud (the acquire path throws a MalfunctionError, never a silent
              // breach); package managers dedupe with-simple-cache to one copy by default,
              // so instanceof holds and this branch is never reached in practice.
              const mangledCopy = (() => {
                class MinifiedCopy extends Error {}
                Object.defineProperty(MinifiedCopy, 'name', { value: 't' }); // a mangler
                return new MinifiedCopy('a rival owns the key');
              })();
              // sanity: neither branch can match a mangled-name duplicate
              expect(mangledCopy instanceof SimpleCacheConditionError).toEqual(
                false,
              );
              expect(mangledCopy.constructor.name).not.toEqual(
                'SimpleCacheConditionError',
              );
              expect(isSimpleCacheConditionError(mangledCopy)).toEqual(false);
            },
          );
        },
      );
    },
  );

  given('[case3] an unrelated error and non-error values', () => {
    when('[t0] the guard inspects a plain Error', () => {
      then('it is false (an unexpected fault is never absorbed)', () => {
        expect(
          isSimpleCacheConditionError(new Error('backend timeout')),
        ).toEqual(false);
      });
    });

    when('[t1] the guard inspects a non-error value', () => {
      then('it is false for a string, null, and undefined', () => {
        expect(
          isSimpleCacheConditionError('SimpleCacheConditionError'),
        ).toEqual(false);
        expect(isSimpleCacheConditionError(null)).toEqual(false);
        expect(isSimpleCacheConditionError(undefined)).toEqual(false);
      });
    });
  });
});
