import { getError } from 'helpful-errors';
import { createCache } from 'simple-in-memory-cache';
import { given, then, useThen, when } from 'test-fns';

import { genFaultInjectedCache } from '../.test/genFaultInjectedCache';
import { delMutexLock } from './delMutexLock';

/**
 * .what = integration tests for delMutexLock's compare-and-delete safety
 * .why = the vision's core safety property is "release only if the lock is still ours" — an
 *        unconditional delete could free a RIVAL's lock. these assert that directly against a
 *        real conditional-write cache, since the withSimpleMutex-level flow cannot reproduce the
 *        expired-then-reacquired race deterministically.
 */
describe('delMutexLock (compare-and-delete safety)', () => {
  given('[case1] a key that a rival now owns (our version is stale)', () => {
    when('[t0] we release on our stale version', () => {
      const outcome = useThen(
        'it is a safe no-op — the rival lock survives',
        async () => {
          const cache = createCache<string>();
          const key = 'release-safety';

          // we take the key; capture our version
          await cache.set(key, 'ours', { condition: { version: null } });
          const versionOurs = await cache.version(key);

          // a rival takes over (compare-and-set on our version → fresh version)
          await cache.set(key, 'rivals', {
            condition: { version: versionOurs ?? null },
          });

          // our release, on our now-stale version, must NOT delete the rival's lock
          await delMutexLock({ key, version: versionOurs ?? '' }, { cache });

          return { survivor: await cache.get(key) };
        },
      );

      then("the rival's value is untouched (not freed by our release)", () => {
        expect(outcome.survivor).toEqual('rivals');
      });
    });
  });

  given('[case2] a key we still own', () => {
    when('[t0] we release on our current version', () => {
      const outcome = useThen(
        'it deletes the key (frees our own lock)',
        async () => {
          const cache = createCache<string>();
          const key = 'release-ours';

          await cache.set(key, 'ours', { condition: { version: null } });
          const versionOurs = await cache.version(key);

          await delMutexLock({ key, version: versionOurs ?? '' }, { cache });

          return { after: await cache.get(key) };
        },
      );

      then('the key is gone (our lock was freed)', () => {
        expect(outcome.after).toBeUndefined();
      });
    });
  });

  given(
    '[case3] the backend faults with a non-condition error on delete',
    () => {
      when('[t0] we release and the cache set throws a real fault', () => {
        const outcome = useThen(
          'the fault propagates — never hidden (rule.forbid.failhide)',
          async () => {
            const real = createCache<string>();
            // a cache whose compare-and-delete (set with value=undefined) throws a genuine
            // backend fault, NOT a SimpleCacheConditionError — the unexpected path
            const cache = genFaultInjectedCache({
              real,
              faults: {
                set: (key, value, options) => {
                  if (value === undefined)
                    throw new Error('backend down on delete');
                  return real.set(key, value, options);
                },
              },
            });

            const error = await getError(
              delMutexLock({ key: 'boom', version: 'v1' }, { cache }),
            );
            return { error };
          },
        );

        then('the unexpected backend fault reaches the caller', () => {
          expect(outcome.error).toBeInstanceOf(Error);
          expect(outcome.error?.message).toContain('backend down on delete');
        });
      });
    },
  );
});
