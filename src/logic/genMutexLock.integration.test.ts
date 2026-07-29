import { getError, MalfunctionError } from 'helpful-errors';
import { createCache } from 'simple-in-memory-cache';
import { given, then, useThen, when } from 'test-fns';

import { genFaultInjectedCache } from '../.test/genFaultInjectedCache';
import { SimpleMutexAcquireTimeoutError } from '../domain.objects/SimpleMutexAcquireTimeoutError';
import { genMutexLock } from './genMutexLock';

/**
 * .what = integration test for genMutexLock's acquire-path safety guards
 * .why = two acquire-path failure modes must each fail loud with mutex context, not leak a raw
 *        state to the caller:
 *   - lease-too-short: after an atomic put-if-absent wins, acquire reads the version token so
 *     release can compare-and-delete. if the lease lapses in that instant, the version read comes
 *     back undefined — a real failure mode that must throw a typed MalfunctionError, not
 *     return an unusable empty version.
 *   - backend-fault: an UNEXPECTED throw from the cache on the put or the version read must be
 *     wrapped in a MalfunctionError that names the key and the fact it happened on acquire, so the
 *     caller never sees a bare "ECONNRESET" with no clue it occurred inside the lock.
 *   both are asserted here, since the withSimpleMutex-level flow cannot reproduce them deterministically.
 */
describe('genMutexLock (acquire-path safety)', () => {
  given(
    '[case1] the version read returns undefined right after a won write',
    () => {
      when('[t0] we acquire the key', () => {
        const outcome = useThen(
          'it fails fast with a typed MalfunctionError',
          async () => {
            const real = createCache<string>();

            // fault-inject on a REAL cache: put-if-absent still succeeds, but the
            // version read comes back undefined — the exact race the guard defends
            // against (the lease lapses between the won write and the version read).
            const cache = genFaultInjectedCache({
              real,
              faults: { version: () => undefined },
            });

            const error = await getError(
              genMutexLock(
                {
                  key: { given: 'lease-too-short', used: 'lease-too-short' },
                  value: 'ours',
                  leaseDuration: { minutes: 30 },
                  intervalMse: 10,
                  timeoutMse: 1000,
                },
                { cache },
              ),
            );

            // capture the durable message contract (metadata redacted so the volatile
            // key does not leak into the snapshot). we narrow instanceof here, inside the
            // callback, where `error` is the real value (not a deferred proxy).
            const isTyped = error instanceof MalfunctionError;
            const messageRedacted = isTyped
              ? error.redact(['metadata']).message
              : (error?.message ?? null);

            return { error, isTyped, messageRedacted };
          },
        );

        then('the error is a MalfunctionError', () => {
          expect(outcome.isTyped).toEqual(true);
        });

        then('its message names the lease-too-short cause', () => {
          expect(outcome.error?.message).toContain('lease is too short');
        });

        then('the lease-too-short message matches the snapshot', () => {
          expect(outcome.messageRedacted).toMatchSnapshot();
        });
      });
    },
  );

  given('[case2] the cache backend throws while we put-if-absent', () => {
    when('[t0] we acquire the key', () => {
      const outcome = useThen(
        'it fails loud with a MalfunctionError that names the acquire context',
        async () => {
          const real = createCache<string>();

          // fault-inject a raw backend throw on the put (network/io style), the
          // exact UNEXPECTED fault that must reach the caller wrapped, not bare.
          const cache = genFaultInjectedCache({
            real,
            faults: {
              set: () => {
                throw new Error('read ECONNRESET');
              },
            },
          });

          const error = await getError(
            genMutexLock(
              {
                key: {
                  given: 'backend-faults-on-put',
                  used: 'backend-faults-on-put',
                },
                value: 'ours',
                leaseDuration: { minutes: 30 },
                intervalMse: 10,
                timeoutMse: 1000,
              },
              { cache },
            ),
          );

          const isTyped = error instanceof MalfunctionError;
          const messageRedacted = isTyped
            ? error.redact(['metadata']).message
            : (error?.message ?? null);

          return { error, isTyped, messageRedacted };
        },
      );

      then('the error is a MalfunctionError', () => {
        expect(outcome.isTyped).toEqual(true);
      });

      then('its message names the acquire fault', () => {
        expect(outcome.error?.message).toContain(
          'faulted while it acquired the lock',
        );
      });

      then('the acquire-fault message matches the snapshot', () => {
        expect(outcome.messageRedacted).toMatchSnapshot();
      });
    });
  });

  given('[case3] the cache backend throws while we read the version', () => {
    when('[t0] we acquire the key', () => {
      const outcome = useThen(
        'it fails loud with a MalfunctionError that names the version read',
        async () => {
          const real = createCache<string>();

          // fault-inject a raw backend throw on the version read: the put-if-absent
          // wins, but the follow-up version read faults with a raw io error.
          const cache = genFaultInjectedCache({
            real,
            faults: {
              version: () => {
                throw new Error('socket hang up');
              },
            },
          });

          const error = await getError(
            genMutexLock(
              {
                key: {
                  given: 'backend-faults-on-version',
                  used: 'backend-faults-on-version',
                },
                value: 'ours',
                leaseDuration: { minutes: 30 },
                intervalMse: 10,
                timeoutMse: 1000,
              },
              { cache },
            ),
          );

          const isTyped = error instanceof MalfunctionError;
          const messageRedacted = isTyped
            ? error.redact(['metadata']).message
            : (error?.message ?? null);

          return { error, isTyped, messageRedacted };
        },
      );

      then('the error is a MalfunctionError', () => {
        expect(outcome.isTyped).toEqual(true);
      });

      then('its message names the version-read fault', () => {
        expect(outcome.error?.message).toContain(
          'faulted while it read the lock version on acquire',
        );
      });

      then('the version-read-fault message matches the snapshot', () => {
        expect(outcome.messageRedacted).toMatchSnapshot();
      });
    });
  });

  given('[case4] the key stays held and the acquire timeout elapses', () => {
    // a short timeout paired with a LONGER poll interval — the realistic misconfiguration where a
    // caller sets only `acquire.timeout` and inherits the default 1s interval. proves two things:
    //   - the timeout is a TRUE upper bound: the loop clamps its sleep to the budget LEFT, so it
    //     gives up at ~timeout, not a full interval past it (rule.forbid.surprises).
    //   - the SimpleMutexAcquireTimeoutError names the fix (rule.require.errors-name-the-fix).
    when('[t0] we acquire a key another holder already owns', () => {
      const outcome = useThen(
        'it gives up at the declared timeout with a mutex-owned error that names the fix',
        async () => {
          const cache = createCache<string>();

          // a rival already holds the key, so every put-if-absent this call makes will miss
          await cache.set('held', 'rival', {
            expiration: { minutes: 30 },
            condition: { version: null },
          });

          const startedAtMse = Date.now();
          const error = await getError(
            genMutexLock(
              {
                key: { given: 'held', used: 'held' },
                value: 'ours',
                leaseDuration: { minutes: 30 },
                intervalMse: 1000, // a full second — far longer than the 50ms timeout below
                timeoutMse: 50, // the true upper bound the loop must honor
              },
              { cache },
            ),
          );
          const elapsedMse = Date.now() - startedAtMse;

          const isTyped = error instanceof SimpleMutexAcquireTimeoutError;
          // redact metadata AND mask the volatile waited-ms baked into the message string
          // (it drifts 50 vs 51 across runs on scheduler jitter), so the snapshot pins the
          // stable message contract without a clock-driven flake.
          const messageRedacted = (
            isTyped
              ? error.redact(['metadata']).message
              : (error?.message ?? null)
          )?.replace(/waited \d+ms/, 'waited <mse>ms');

          return { error, isTyped, messageRedacted, elapsedMse };
        },
      );

      then('the error is a SimpleMutexAcquireTimeoutError', () => {
        expect(outcome.isTyped).toEqual(true);
      });

      then(
        'it gave up near the timeout, not a full interval past it (true upper bound)',
        () => {
          // the 1s interval would push a naive loop to ~1000ms; the clamp caps it near the 50ms
          // budget. allow generous headroom for scheduler jitter but well under the 1s interval.
          expect(outcome.elapsedMse).toBeLessThan(500);
        },
      );

      then('its message names the fix (raise acquire.timeout)', () => {
        expect(outcome.error?.message).toContain('acquire.timeout');
      });

      then('the acquire-timeout message matches the snapshot', () => {
        expect(outcome.messageRedacted).toMatchSnapshot();
      });
    });
  });
});
