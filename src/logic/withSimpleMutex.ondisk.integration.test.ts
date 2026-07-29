import { sleep } from 'iso-time';
import { createCache } from 'simple-on-disk-cache';
import { given, then, useThen, when } from 'test-fns';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSimpleMutex } from './withSimpleMutex';

/**
 * .what = integration tests for withSimpleMutex over an on-disk cache (per-machine tier)
 * .why = the on-disk backend is a real filesystem conditional-write cache, so these prove the
 *        mutex serializes across the per-machine boundary — and that a human-readable key with
 *        special characters (which the on-disk backend rejects raw) is cast safely by the mutex
 */
describe('withSimpleMutex (on-disk local / per-machine)', () => {
  const genTempDir = (): string =>
    mkdtempSync(join(tmpdir(), 'with-simple-mutex-'));

  given('[case1] two concurrent calls on the same key', () => {
    when('[t0] both are invoked at once', () => {
      const outcome = useThen('they serialize (never overlap)', async () => {
        const cache = createCache({
          directory: { local: { path: genTempDir() } },
        });

        // .note = deliberate mutation (the SANCTIONED escape hatch in rule.require.immutable-vars:
        //   "isolate unavoidable mutation in scoped zones with a .note = deliberate mutation
        //   comment"). these are concurrency-probe counters — a live max-holders gauge is the one
        //   measurement genuinely built on in-place increment; an immutable rebuild each tick would
        //   not observe the overlap. scope is this one closure.
        let active = 0;
        let maxActive = 0;

        const guarded = withSimpleMutex(
          async (input: { id: number }) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await sleep({ milliseconds: 50 });
            active -= 1;
            return input.id;
          },
          {
            key: () => 'shared',
            cache,
            acquire: { interval: { milliseconds: 20 } },
          },
        );

        const results = await Promise.all([
          guarded({ id: 1 }),
          guarded({ id: 2 }),
        ]);

        return { results, maxActive };
      });

      then('at most one holder ran at a time', () => {
        expect(outcome.maxActive).toEqual(1);
      });

      then('both calls completed', () => {
        expect(outcome.results.sort()).toEqual([1, 2]);
      });
    });
  });

  given('[case2] the flagship key with special characters', () => {
    // the on-disk backend rejects raw keys with `+` — the mutex must cast it safe
    when('[t0] a proxy-phone key is locked', () => {
      const result = useThen(
        'the lock runs without a key-rejection',
        async () => {
          const cache = createCache({
            directory: { local: { path: genTempDir() } },
          });

          const guarded = withSimpleMutex(
            async (input: { phone: string }) => `served.${input.phone}`,
            {
              key: (input) => `proxy-phone.${input.phone}`,
              cache,
              acquire: { interval: { milliseconds: 20 } },
            },
          );

          return { value: await guarded({ phone: '+14632270513' }) };
        },
      );

      then('the critical section ran and returned its result', () => {
        expect(result.value).toEqual('served.+14632270513');
      });
    });
  });

  given('[case3] a released lock and a later caller', () => {
    when('[t0] the first holder finishes, then a second acquires', () => {
      const outcome = useThen('both run in order', async () => {
        const cache = createCache({
          directory: { local: { path: genTempDir() } },
        });

        const guarded = withSimpleMutex(
          async (input: { id: number }) => {
            await sleep({ milliseconds: 20 });
            return input.id;
          },
          {
            key: () => 'sequential',
            cache,
            acquire: { interval: { milliseconds: 20 } },
          },
        );

        const first = await guarded({ id: 1 });
        const later = await guarded({ id: 2 });

        return { first, later };
      });

      then('both ran and released cleanly', () => {
        expect(outcome.first).toEqual(1);
        expect(outcome.later).toEqual(2);
      });
    });
  });
});
