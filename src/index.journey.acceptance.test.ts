import { ConstraintError, getError, MalfunctionError } from 'helpful-errors';
import { sleep } from 'iso-time';
import { createCache as createInMemoryCache } from 'simple-in-memory-cache';
import { createCache as createOnDiskCache } from 'simple-on-disk-cache';
import { given, then, useThen, when } from 'test-fns';

import {
  SimpleMutexAcquireTimeoutError,
  SimpleMutexLeaseExpiredError,
  withSimpleMutex,
} from '@src/index';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { genFaultInjectedCache } from './.test/genFaultInjectedCache';

/**
 * .what = the day-in-the-life journey for withSimpleMutex, against the public entry
 * .why = proves the headline pitch end-to-end: callers that share a key take turns, and the
 *        only change needed to widen the isolation tier (process → machine) is the cache passed
 *        in — the wrapped call is identical
 * .note = this file covers the per-process (in-memory) and per-machine (on-disk-local) tiers, which
 *   run hermetically (no credentials). the global (s3) tier — the third headline tier — is proven
 *   LIVE against real aws in a peer file, index.s3.journey.acceptance.test.ts, so all three tiers
 *   have real acceptance coverage (rule.require.acceptance-journey-coverage). the split is only a
 *   credential boundary: the two tiers here need none, so they stay in the hermetic suite; the s3
 *   tier needs unlocked aws creds, so it lives in its own file the test runner gates on cred unlock.
 *   the mutex code is identical across all three — withSimpleMutex is cache-agnostic, so the ONLY
 *   change per tier is the cache passed in.
 */
describe('withSimpleMutex — day-in-the-life journey', () => {
  // the one function a developer wraps; the same body across every tier
  const doWork = async (input: { phone: string }): Promise<string> => {
    await sleep({ milliseconds: 40 });
    return `served.${input.phone}`;
  };

  given('[case1] per-process tier — an in-memory cache', () => {
    when('[t0] two callers share a key', () => {
      const outcome = useThen(
        'they serialize, and both are served',
        async () => {
          const cache = createInMemoryCache<string>();

          // .note = deliberate mutation (the SANCTIONED escape hatch in rule.require.immutable-vars:
          //   "isolate unavoidable mutation in scoped zones with a .note = deliberate mutation
          //   comment"). these are concurrency-probe counters — a live max-holders gauge is the one
          //   measurement genuinely built on in-place increment; an immutable rebuild each tick
          //   would not observe the overlap. scope is this one closure.
          let active = 0;
          let maxActive = 0;

          const genProxyPhone = withSimpleMutex(
            async (input: { phone: string }) => {
              active += 1;
              maxActive = Math.max(maxActive, active);
              const served = await doWork(input);
              active -= 1;
              return served;
            },
            {
              key: (input) => `proxy-phone.${input.phone}`,
              cache,
              acquire: { interval: { milliseconds: 10 } },
            },
          );

          const results = await Promise.all([
            genProxyPhone({ phone: '+14632270513' }),
            genProxyPhone({ phone: '+14632270513' }),
          ]);

          return { results, maxActive };
        },
      );

      then('at most one holder ran at a time (serialized)', () => {
        expect(outcome.maxActive).toEqual(1);
      });

      then('both callers were served', () => {
        expect(outcome.results).toEqual([
          'served.+14632270513',
          'served.+14632270513',
        ]);
      });

      then('the success pass-through output matches the snapshot', () => {
        // the wrapper is a transparent pass-through: its success output IS the
        // caller's logic result, unchanged. snapshot it so any accidental wrap or
        // shape drift on the happy path is caught in a PR diff.
        expect(outcome.results).toMatchSnapshot();
      });
    });
  });

  given('[case2] per-machine tier — the same call, an on-disk cache', () => {
    when('[t0] two callers share a key', () => {
      const outcome = useThen(
        'they serialize, and both are served',
        async () => {
          // the only change from case1: the cache. the wrapped call is identical.
          const cache = createOnDiskCache({
            directory: {
              local: {
                path: mkdtempSync(join(tmpdir(), 'with-simple-mutex-journey-')),
              },
            },
          });

          // .note = deliberate mutation (the SANCTIONED escape hatch in rule.require.immutable-vars:
          //   "isolate unavoidable mutation in scoped zones with a .note = deliberate mutation
          //   comment"). these are concurrency-probe counters — a live max-holders gauge is the one
          //   measurement genuinely built on in-place increment; an immutable rebuild each tick
          //   would not observe the overlap. scope is this one closure.
          let active = 0;
          let maxActive = 0;

          const genProxyPhone = withSimpleMutex(
            async (input: { phone: string }) => {
              active += 1;
              maxActive = Math.max(maxActive, active);
              const served = await doWork(input);
              active -= 1;
              return served;
            },
            {
              key: (input) => `proxy-phone.${input.phone}`,
              cache,
              acquire: { interval: { milliseconds: 20 } },
            },
          );

          const results = await Promise.all([
            genProxyPhone({ phone: '+14632270513' }),
            genProxyPhone({ phone: '+14632270513' }),
          ]);

          return { results, maxActive };
        },
      );

      then('at most one holder ran at a time (serialized)', () => {
        expect(outcome.maxActive).toEqual(1);
      });

      then('both callers were served', () => {
        expect(outcome.results).toEqual([
          'served.+14632270513',
          'served.+14632270513',
        ]);
      });

      then(
        'the on-disk success pass-through output matches the snapshot',
        () => {
          // same pass-through contract as case1, now over the per-machine tier — snap it
          // too so a tier-specific output drift is caught in a PR diff.
          expect(outcome.results).toMatchSnapshot();
        },
      );
    });
  });

  given('[case3] different keys do not block each other', () => {
    when('[t0] two callers hold distinct keys', () => {
      const outcome = useThen('they run in parallel', async () => {
        const cache = createInMemoryCache<string>();

        // .note = deliberate mutation: concurrency-probe counters, bumped inside
        //   the guarded logic to record how many holders ran at once.
        let active = 0;
        let maxActive = 0;

        const genProxyPhone = withSimpleMutex(
          async (input: { phone: string }) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            const served = await doWork(input);
            active -= 1;
            return served;
          },
          {
            key: (input) => `proxy-phone.${input.phone}`,
            cache,
            acquire: { interval: { milliseconds: 10 } },
          },
        );

        await Promise.all([
          genProxyPhone({ phone: '+14632270513' }),
          genProxyPhone({ phone: '+18885551234' }),
        ]);

        return { maxActive };
      });

      then('both holders ran concurrently (distinct keys never block)', () => {
        expect(outcome.maxActive).toEqual(2);
      });

      then('the concurrency outcome shape is pinned', () => {
        expect(outcome).toMatchSnapshot();
      });
    });
  });

  given('[case4] a contended key with a bounded acquire timeout', () => {
    when('[t0] a rival cannot take the held key in its window', () => {
      const outcome = useThen(
        'the rival fails with the mutex-owned acquire-timeout error',
        async () => {
          const cache = createInMemoryCache<string>();

          const guarded = withSimpleMutex(
            async (input: { hold: number }) => {
              await sleep({ milliseconds: input.hold });
              return 'done';
            },
            {
              // the flagship key carries special chars (`+`, `.`) the on-disk backend rejects,
              // so the mutex sanitizes it internally — this case proves the caller still sees
              // their ORIGINAL key in the error metadata (grep-able), not the sanitized form
              key: () => 'proxy-phone.+14632270513',
              cache,
              acquire: {
                timeout: { milliseconds: 40 },
                interval: { milliseconds: 10 },
              },
            },
          );

          // the holder takes the key and occupies it past the rival's window
          const holder = guarded({ hold: 200 });
          await sleep({ milliseconds: 15 }); // let the holder win acquisition first

          // the rival races for the same key, then gives up at its timeout
          const rivalError = await getError(guarded({ hold: 0 }));
          await holder; // settle the holder so the case leaves no work in flight

          // fail loud on the wrong error, which also narrows the type for the
          // owned-shape reads below (no as-cast; per rule.forbid.as-cast)
          if (!(rivalError instanceof SimpleMutexAcquireTimeoutError))
            throw (
              rivalError ??
              new Error(
                'expected the contended rival to fail with SimpleMutexAcquireTimeoutError, but no error was thrown — the acquire timeout did not fire',
              )
            );

          // snapshot the OWNED contract surface: identity, the user-faced message, and the
          // metadata schema. two volatile values are masked so they cannot flake the snapshot:
          // metadata is redacted (carries the volatile key hash), and the waited-duration baked
          // into the message text is masked to `waited <mse>ms` (it drifts 40↔41 on scheduler jitter).
          return {
            shape: {
              caught: true,
              name: rivalError.constructor.name,
              message: rivalError
                .redact(['metadata'])
                .message.replace(/waited \d+ms/, 'waited <mse>ms'),
              metadataKeys: Object.keys(rivalError.metadata ?? {}).sort(),
            },
            // the metadata key facets, read for the by-value assertions below (redacted out of
            // the snapshot so the volatile hash + waited-duration cannot flake it)
            keyGivenInMetadata: rivalError.metadata?.key?.given,
            keyUsedInMetadata: rivalError.metadata?.key?.used,
          };
        },
      );

      then('it is the mutex-owned acquire-timeout error', () => {
        expect(outcome.shape.caught).toEqual(true);
      });

      then(
        'the error metadata carries the CALLER given key (grep-able) + the safe used key',
        () => {
          // the caller can find the key they passed in their logs
          expect(outcome.keyGivenInMetadata).toEqual(
            'proxy-phone.+14632270513',
          );
          // the sanitized backend key is present too, and is a DIFFERENT, safe form
          expect(outcome.keyUsedInMetadata).not.toEqual(
            'proxy-phone.+14632270513',
          );
          expect(String(outcome.keyUsedInMetadata)).toMatch(/^mutex\./);
        },
      );

      then('its owned contract shape is stable', () => {
        expect(outcome.shape).toMatchSnapshot();
      });
    });
  });

  given('[case5] a critical section that outruns its lease', () => {
    when('[t0] the lease elapses before the logic finishes', () => {
      const outcome = useThen(
        'the holder fails fast with the mutex-owned lease-expired error',
        async () => {
          const cache = createInMemoryCache<string>();

          const guarded = withSimpleMutex(
            async (input: { n: number }) => {
              await sleep({ milliseconds: 200 });
              return input.n;
            },
            {
              key: () => 'short-lease',
              cache,
              lease: { duration: { milliseconds: 30 } },
            },
          );

          const error = await getError(guarded({ n: 1 }));

          // fail loud on the wrong error, which also narrows the type for the
          // owned-shape reads below (no as-cast; per rule.forbid.as-cast)
          if (!(error instanceof SimpleMutexLeaseExpiredError))
            throw (
              error ??
              new Error(
                'expected the over-long critical section to fail with SimpleMutexLeaseExpiredError, but no error was thrown — the lease deadline did not fire',
              )
            );

          // snapshot the OWNED contract surface: identity, the user-faced message
          // (metadata redacted so no volatile value flakes the snapshot), and the
          // metadata schema.
          return {
            shape: {
              caught: true,
              name: error.constructor.name,
              message: error.redact(['metadata']).message,
              metadataKeys: Object.keys(error.metadata ?? {}).sort(),
            },
          };
        },
      );

      then('it is the mutex-owned lease-expired error', () => {
        expect(outcome.shape.caught).toEqual(true);
      });

      then('its owned contract shape is stable', () => {
        expect(outcome.shape).toMatchSnapshot();
      });
    });
  });

  given(
    '[case6] the critical section fails and the lock release also faults',
    () => {
      when('[t0] both faults occur, neither may be hidden', () => {
        const outcome = useThen(
          'a combined MalfunctionError surfaces both faults to the caller',
          async () => {
            // a real in-memory cache, with a fault injected into the release path only:
            // the compare-and-delete is `set(key, undefined, { condition })` — force it to
            // throw a real backend fault, so both the logic error and the release error occur.
            const real = createInMemoryCache<string>();
            const cache = genFaultInjectedCache({
              real,
              faults: {
                set: (key, value, options) => {
                  if (value === undefined) throw new Error('release boom');
                  return real.set(key, value, options);
                },
              },
            });

            const guarded = withSimpleMutex(
              async () => {
                throw new Error('logic boom');
              },
              {
                key: () => 'both-fault',
                cache,
                acquire: { interval: { milliseconds: 10 } },
              },
            );

            const error = await getError(guarded({}));

            // fail loud on the wrong error, which also narrows the type for the
            // owned-shape reads below (no as-cast; per rule.forbid.as-cast)
            if (!(error instanceof MalfunctionError))
              throw (
                error ??
                new Error(
                  'expected the double-fault to surface a combined MalfunctionError, but no error was thrown',
                )
              );

            // snapshot the OWNED contract surface: identity, the user-faced message
            // (metadata redacted so the volatile key hash cannot flake the snapshot), and
            // the metadata schema that carries both faults.
            return {
              shape: {
                caught: true,
                name: error.constructor.name,
                message: error.redact(['metadata']).message,
                metadataKeys: Object.keys(error.metadata ?? {}).sort(),
              },
              bothSurfaced:
                error.message.includes('logic boom') &&
                error.message.includes('release boom'),
            };
          },
        );

        then('it is the combined mutex fault', () => {
          expect(outcome.shape.caught).toEqual(true);
        });

        then(
          'both the primary and release faults are surfaced (never hidden)',
          () => {
            expect(outcome.bothSurfaced).toEqual(true);
          },
        );

        then('its owned contract shape is stable', () => {
          expect(outcome.shape).toMatchSnapshot();
        });
      });
    },
  );

  given(
    '[case7] the critical section throws but the lock release succeeds',
    () => {
      when('[t0] logic fails on a clean-release path', () => {
        const outcome = useThen(
          "logic's own error propagates unchanged (not masked by the lock)",
          async () => {
            const cache = createInMemoryCache<string>();

            const guarded = withSimpleMutex(
              async () => {
                throw new Error('logic boom');
              },
              {
                key: () => 'logic-fault-clean-release',
                cache,
                acquire: { interval: { milliseconds: 10 } },
              },
            );

            const error = await getError(guarded({}));

            // prove the lock is freed for the next holder BEHAVIORALLY, at the public
            // boundary: a second holder on the SAME key must acquire and complete. this is
            // the real proof of "the next holder can proceed" — it does not reach into the
            // cache with an internal key name (which would couple the test to asSafeMutexKey's
            // private hash form and, if mistyped, pass vacuously against a key that never
            // existed). a short acquire timeout means a still-held lock would throw here.
            const nextHolder = withSimpleMutex(async () => 'next-holder-ran', {
              key: () => 'logic-fault-clean-release',
              cache,
              acquire: {
                interval: { milliseconds: 10 },
                timeout: { seconds: 2 },
              },
            });
            const nextResult = await nextHolder({});

            return {
              message: error?.message ?? null,
              name: error?.name ?? null,
              nextHolderRan: nextResult === 'next-holder-ran',
              // capture the pass-through contract shape so a future regression that
              // accidentally WRAPS this transparent error (or changes its name/message)
              // is caught by the snapshot, per rule.require.contract-snapshot-exhaustiveness.
              shape: {
                name: error?.name ?? null,
                message: error?.message ?? null,
              },
            };
          },
        );

        then("logic's own error reaches the caller unchanged", () => {
          expect(outcome.name).toEqual('Error');
          expect(outcome.message).toEqual('logic boom');
        });

        then('the lock was released so the next holder can proceed', () => {
          expect(outcome.nextHolderRan).toEqual(true);
        });

        then('its transparent pass-through shape is stable', () => {
          expect(outcome.shape).toMatchSnapshot();
        });
      });
    },
  );

  given(
    '[case8] the critical section succeeds but the lock release faults',
    () => {
      when(
        '[t0] the work is done yet the release throws a backend fault',
        () => {
          const outcome = useThen(
            'the caller learns the work succeeded AND sees the release fault',
            async () => {
              // a real in-memory cache with a fault injected into the release path only
              const real = createInMemoryCache<string>();
              const cache = genFaultInjectedCache({
                real,
                faults: {
                  set: (key, value, options) => {
                    if (value === undefined) throw new Error('release boom');
                    return real.set(key, value, options);
                  },
                },
              });

              const guarded = withSimpleMutex(async () => 'the-work-result', {
                key: () => 'clean-work-bad-release',
                cache,
                acquire: { interval: { milliseconds: 10 } },
              });

              const error = await getError(guarded({}));

              // fail loud on the wrong error, which also narrows the type (no as-cast)
              if (!(error instanceof MalfunctionError))
                throw (
                  error ??
                  new Error(
                    'expected a success-with-release-fault to surface a wrapped MalfunctionError, but no error was thrown',
                  )
                );

              return {
                shape: {
                  caught: true,
                  name: error.constructor.name,
                  message: error.redact(['metadata']).message,
                  metadataKeys: Object.keys(error.metadata ?? {}).sort(),
                },
                statesWorkSucceeded: error.message.includes('succeeded'),
                carriesReleaseFault: error.message.includes('release boom'),
              };
            },
          );

          then('the fault states the work already succeeded', () => {
            expect(outcome.statesWorkSucceeded).toEqual(true);
          });

          then(
            'the release fault itself is surfaced too (never hidden)',
            () => {
              expect(outcome.carriesReleaseFault).toEqual(true);
            },
          );

          then('its owned contract shape is stable', () => {
            expect(outcome.shape).toMatchSnapshot();
          });
        },
      );
    },
  );

  given('[case9] a lease longer than the platform timer can hold', () => {
    when('[t0] the caller configures an out-of-bounds lease', () => {
      const outcome = useThen(
        'the wrapped call fails fast with a caller-fix ConstraintError',
        async () => {
          const cache = createInMemoryCache<string>();

          // a lease of 30 days is past the platform timer max (~24.8 days): a js
          // timer armed on such a delay silently misfires at ~1ms, which for a lease
          // would breach mutual exclusion. the wrapper must reject this up front, so
          // the misconfiguration is a loud caller-fix error, not a silent hazard.
          const guarded = withSimpleMutex(async () => 'never-reached', {
            key: () => 'over-long-lease',
            cache,
            lease: { duration: { days: 30 } },
          });

          const error = await getError(guarded({}));

          // fail loud on the wrong error, which also narrows the type for the
          // owned-shape reads below (no as-cast; per rule.forbid.as-cast)
          if (!(error instanceof ConstraintError))
            throw (
              error ??
              new Error(
                'expected the out-of-bounds lease to fail with a ConstraintError, but no error was thrown — the timer-bounds guard did not fire',
              )
            );

          // snapshot the OWNED contract surface: identity, the user-faced message
          // (metadata redacted so the volatile ms values cannot flake the snapshot),
          // and the metadata schema.
          return {
            shape: {
              caught: true,
              name: error.constructor.name,
              message: error.redact(['metadata']).message,
              metadataKeys: Object.keys(error.metadata ?? {}).sort(),
            },
            // read for the by-value assertions below (redacted out of the snapshot)
            namesTheField: error.message.includes('lease.duration'),
            namesTheFix: error.message.includes('split the work'),
          };
        },
      );

      then('it is a caller-fix ConstraintError', () => {
        expect(outcome.shape.caught).toEqual(true);
      });

      then('the error names the at-fault field and how to fix it', () => {
        expect(outcome.namesTheField).toEqual(true);
        expect(outcome.namesTheFix).toEqual(true);
      });

      then('its owned contract shape is stable', () => {
        expect(outcome.shape).toMatchSnapshot();
      });
    });
  });

  given(
    '[case9b] an acquire interval longer than the platform timer can hold',
    () => {
      when(
        '[t0] the caller configures an out-of-bounds acquire interval',
        () => {
          const outcome = useThen(
            'the wrapped call fails fast with a caller-fix ConstraintError',
            async () => {
              const cache = createInMemoryCache<string>();

              // the SYMMETRIC guard to case9: acquire.interval also arms a setTimeout (the
              // poll sleep), so an interval of 30 days is past the platform timer max
              // (~24.8 days) and would silently misfire at ~1ms. the wrapper must reject
              // it up front through the SAME assertMseWithinTimerBounds guard, so the
              // acquire-side misconfiguration is proven loud at the public boundary too.
              const guarded = withSimpleMutex(async () => 'never-reached', {
                key: () => 'over-long-interval',
                cache,
                acquire: { interval: { days: 30 } },
              });

              const error = await getError(guarded({}));

              // fail loud on the wrong error, which also narrows the type for the
              // owned-shape reads below (no as-cast; per rule.forbid.as-cast)
              if (!(error instanceof ConstraintError))
                throw (
                  error ??
                  new Error(
                    'expected the out-of-bounds acquire.interval to fail with a ConstraintError, but no error was thrown — the timer-bounds guard did not fire',
                  )
                );

              // snapshot the OWNED contract surface: identity, the user-faced message
              // (metadata redacted so the volatile ms values cannot flake the snapshot),
              // and the metadata schema.
              return {
                shape: {
                  caught: true,
                  name: error.constructor.name,
                  message: error.redact(['metadata']).message,
                  metadataKeys: Object.keys(error.metadata ?? {}).sort(),
                },
                // read for the by-value assertions below (redacted out of the snapshot)
                namesTheField: error.message.includes('acquire.interval'),
                namesTheMax: error.message.includes('platform timer max'),
              };
            },
          );

          then('it is a caller-fix ConstraintError', () => {
            expect(outcome.shape.caught).toEqual(true);
          });

          then(
            'the error names the at-fault field and the platform timer max',
            () => {
              expect(outcome.namesTheField).toEqual(true);
              expect(outcome.namesTheMax).toEqual(true);
            },
          );

          then('its owned contract shape is stable', () => {
            expect(outcome.shape).toMatchSnapshot();
          });
        },
      );
    },
  );

  given(
    '[case9c] a single backend call runs longer than acquire.timeout (the documented v1 limit)',
    () => {
      when(
        '[t0] the first put-if-absent settles well past acquire.timeout',
        () => {
          const outcome = useThen(
            'the call still completes — acquire.timeout does NOT bound a single hung backend call',
            async () => {
              const real = createInMemoryCache<string>();

              // fault-inject a SLOW put-if-absent: the single cache.set takes 250ms, far
              // longer than the 50ms acquire.timeout. this pins the readme "# notes" caveat
              // behaviorally (not just in prose): acquire.timeout bounds the wait BETWEEN
              // poll attempts, but a single backend call is awaited directly, so a slow /
              // hung call is NOT bounded by it. a finite delay (not a leaked promise that
              // never settles) so the test leaves no work in flight.
              const cache = genFaultInjectedCache({
                real,
                faults: {
                  set: async (
                    cacheKey: string,
                    cacheValue: string | undefined,
                    cacheOptions,
                  ) => {
                    await sleep({ milliseconds: 250 });
                    return real.set(cacheKey, cacheValue, cacheOptions);
                  },
                },
              });

              const guarded = withSimpleMutex(async () => 'served', {
                key: () => 'slow-backend',
                cache,
                // 50ms acquire.timeout is 5x shorter than the 250ms backend call: if the
                // timeout bounded the call, the FIRST attempt would reject before it settles.
                acquire: {
                  timeout: { milliseconds: 50 },
                  interval: { milliseconds: 10 },
                },
              });

              // it resolves with the logic result — the first (slow) put-if-absent WON, so
              // the acquire loop never reached its between-poll timeout branch. had
              // acquire.timeout bounded the single set, this would have thrown instead.
              const result = await guarded({});

              return { result, boundedByTimeout: false };
            },
          );

          then(
            'the guarded call completes (the slow single call was NOT cut off at acquire.timeout)',
            () => {
              expect(outcome.result).toEqual('served');
            },
          );

          then('the outcome shape is pinned', () => {
            expect(outcome).toMatchSnapshot();
          });
        },
      );
    },
  );

  given('[case9d] a non-positive lease duration', () => {
    when('[t0] the caller configures a zero-ms lease', () => {
      const outcome = useThen(
        'the wrapped call fails fast with a caller-fix ConstraintError',
        async () => {
          const cache = createInMemoryCache<string>();

          // the LOWER-bound twin of case9/case9b: js setTimeout clamps a non-positive
          // delay up to ~1ms, so a zero (or negative) lease would silently arm a ~1ms
          // lease-deadline timer and defeat mutual exclusion. the SAME
          // assertMseWithinTimerBounds guard must reject it up front, so the caller sees a
          // loud caller-fix error rather than a lock that quietly does not hold. proven at
          // the public boundary so the non-positive side has a snapshot too.
          const guarded = withSimpleMutex(async () => 'never-reached', {
            key: () => 'zero-lease',
            cache,
            lease: { duration: { milliseconds: 0 } },
          });

          const error = await getError(guarded({}));

          // fail loud on the wrong error, which also narrows the type for the
          // owned-shape reads below (no as-cast; per rule.forbid.as-cast)
          if (!(error instanceof ConstraintError))
            throw (
              error ??
              new Error(
                'expected the non-positive lease to fail with a ConstraintError, but no error was thrown — the timer-bounds guard did not fire',
              )
            );

          // snapshot the OWNED contract surface: identity, the user-faced message
          // (metadata redacted so the volatile ms values cannot flake the snapshot),
          // and the metadata schema.
          return {
            shape: {
              caught: true,
              name: error.constructor.name,
              message: error.redact(['metadata']).message,
              metadataKeys: Object.keys(error.metadata ?? {}).sort(),
            },
            // read for the by-value assertions below (redacted out of the snapshot)
            namesTheField: error.message.includes('lease.duration'),
            namesPositive: error.message.includes('positive'),
          };
        },
      );

      then('it is a caller-fix ConstraintError', () => {
        expect(outcome.shape.caught).toEqual(true);
      });

      then('the error names the at-fault field and the positivity rule', () => {
        expect(outcome.namesTheField).toEqual(true);
        expect(outcome.namesPositive).toEqual(true);
      });

      then('its owned contract shape is stable', () => {
        expect(outcome.shape).toMatchSnapshot();
      });
    });
  });

  given(
    '[case10] a guarded call re-enters its own key from inside its critical section',
    () => {
      when(
        '[t0] the inner acquire runs while the outer still holds the key',
        () => {
          const outcome = useThen(
            'the inner call self-blocks and times out — the lock is not reentrant',
            async () => {
              const cache = createInMemoryCache<string>();

              // the SAME wrapped fn, on the SAME key, invoked from inside its own
              // critical section. a keyed (not owner-aware) lock cannot tell a
              // re-entrant caller apart from a rival, so it self-blocks. this pins the
              // readme's "not reentrant" caveat at the PUBLIC boundary — a real
              // self-deadlock hazard a caller must know about.
              let innerRan = false;
              const inner = withSimpleMutex(
                async () => {
                  innerRan = true;
                  return 'inner';
                },
                {
                  key: () => 'reentrant',
                  cache,
                  acquire: {
                    interval: { milliseconds: 10 },
                    timeout: { milliseconds: 100 },
                  },
                },
              );
              const outer = withSimpleMutex(
                // re-enter the same key from within the held critical section
                async () => getError(inner({})),
                { key: () => 'reentrant', cache },
              );

              const innerError = await outer({});

              // fail loud on the wrong error, which also narrows the type (no as-cast)
              if (!(innerError instanceof SimpleMutexAcquireTimeoutError))
                throw (
                  innerError ??
                  new Error(
                    'expected the re-entrant inner call to fail with SimpleMutexAcquireTimeoutError, but no error was thrown — the lock self-granted',
                  )
                );

              return {
                shape: {
                  caught: true,
                  name: innerError.constructor.name,
                  // mask the volatile waited-ms so the snapshot pins only the contract
                  message: innerError
                    .redact(['metadata'])
                    .message.replace(/waited \d+ms/, 'waited <mse>ms'),
                  metadataKeys: Object.keys(innerError.metadata ?? {}).sort(),
                },
                innerRan,
              };
            },
          );

          then(
            'the inner call fails with the mutex-owned acquire-timeout error',
            () => {
              expect(outcome.shape.caught).toEqual(true);
            },
          );

          then(
            'the inner call did NOT self-grant (its logic never ran)',
            () => {
              expect(outcome.innerRan).toEqual(false);
            },
          );

          then('its owned contract shape is stable', () => {
            expect(outcome.shape).toMatchSnapshot();
          });
        },
      );
    },
  );

  given(
    '[case11] a holder crashes mid-work and never releases — native expiration reclaims the key',
    () => {
      when('[t0] the crashed lease is live, then it lapses', () => {
        const outcome = useThen(
          'a rival is blocked while the lease is live, then reclaims the natively-expired key',
          async () => {
            const real = createInMemoryCache<string>();
            // model a CRASH: the release (a `set` with value=undefined) is suppressed,
            // so the acquire's lock — written with `expiration: lease` — is left behind
            // exactly as a died process would leave it. every other op stays real, so
            // native expiration is real. this pins cluster B's native-expiry-reclaims
            // decision (the whole reason v1 has no heartbeat) at the public boundary.
            const cache = genFaultInjectedCache({
              real,
              faults: {
                set: (key, value, options) => {
                  if (value === undefined) return; // the crashed holder never released
                  return real.set(key, value, options);
                },
              },
            });

            // the crashed holder: acquires with a SHORT lease and returns, but the
            // suppressed release leaves the key until the cache natively expires it.
            const crashed = withSimpleMutex(async () => 'crashed-done', {
              key: () => 'crash-recover',
              cache,
              lease: { duration: { milliseconds: 150 } },
            });
            await crashed({});

            // a rival with a short acquire timeout, WHILE the lease is still live → blocked
            const rivalEarly = withSimpleMutex(async () => 'rival-ran', {
              key: () => 'crash-recover',
              cache,
              acquire: {
                interval: { milliseconds: 10 },
                timeout: { milliseconds: 50 },
              },
            });
            const blockedError = await getError(rivalEarly({}));

            // wait past the lease so native expiration evicts the abandoned lock
            await sleep({ milliseconds: 200 });

            // a later rival now reclaims the natively-expired key
            const rivalLate = withSimpleMutex(async () => 'rival-ran', {
              key: () => 'crash-recover',
              cache,
              acquire: {
                interval: { milliseconds: 10 },
                timeout: { seconds: 2 },
              },
            });
            const reclaimed = await rivalLate({});

            return {
              blockedWhileLive:
                blockedError instanceof SimpleMutexAcquireTimeoutError,
              reclaimedAfterExpiry: reclaimed === 'rival-ran',
            };
          },
        );

        then('the rival was blocked while the crashed lease was live', () => {
          expect(outcome.blockedWhileLive).toEqual(true);
        });

        then(
          'after the lease lapsed, native expiration let the next caller reclaim the key',
          () => {
            expect(outcome.reclaimedAfterExpiry).toEqual(true);
          },
        );

        then('its outcome shape is stable', () => {
          expect(outcome).toMatchSnapshot();
        });
      });
    },
  );

  given(
    '[case12] the lease expires mid-work — a lease lock, not a fenced lock',
    () => {
      when('[t0] the lease deadline fires while logic is still active', () => {
        const outcome = useThen(
          'the wrapper fails fast, yet the abandoned logic still runs to completion (unfenced)',
          async () => {
            const cache = createInMemoryCache<string>();

            // logic outruns its lease and lands a side-effect AFTER the lease fires.
            // Promise.race makes the WRAPPER fail fast on lease-expiry, but it cannot
            // cancel the in-flight logic — a js promise is not cancellable. so the
            // side-effect still lands. this proves, concretely, the readme's honest
            // "not a fenced lock" caveat (vision cluster B caveat 2): contention is
            // made safe and rare, NOT impossible under an arbitrary pause.
            let sideEffectLanded = false;
            const guarded = withSimpleMutex(
              async () => {
                await sleep({ milliseconds: 120 });
                sideEffectLanded = true; // lands after the 30ms lease already fired
                return 'done';
              },
              {
                key: () => 'unfenced',
                cache,
                lease: { duration: { milliseconds: 30 } },
              },
            );

            const error = await getError(guarded({}));

            // fail loud on the wrong error, which also narrows the type (no as-cast)
            if (!(error instanceof SimpleMutexLeaseExpiredError))
              throw (
                error ??
                new Error(
                  'expected the over-long section to fail with SimpleMutexLeaseExpiredError, but no error was thrown — the lease deadline did not fire',
                )
              );

            // the wrapper rejected BEFORE the logic set its side-effect
            const wrapperFailedFast = !sideEffectLanded;

            // wait for the abandoned logic to finish its own timeline
            await sleep({ milliseconds: 150 });

            return {
              shape: {
                caught: true,
                name: error.constructor.name,
                message: error.redact(['metadata']).message,
                metadataKeys: Object.keys(error.metadata ?? {}).sort(),
              },
              wrapperFailedFast,
              abandonedLogicStillRan: sideEffectLanded,
            };
          },
        );

        then('the wrapper failed fast at the lease deadline', () => {
          expect(outcome.wrapperFailedFast).toEqual(true);
        });

        then(
          'the abandoned logic still ran to completion (proof it is not fenced)',
          () => {
            expect(outcome.abandonedLogicStillRan).toEqual(true);
          },
        );

        then('its owned lease-expired shape is stable', () => {
          expect(outcome.shape).toMatchSnapshot();
        });
      });
    },
  );

  given('[case13] many callers race for the same key at once', () => {
    when('[t0] ten concurrent acquirers contend', () => {
      const outcome = useThen(
        'exactly one holds the critical section at a time, and all ten are served',
        async () => {
          const cache = createInMemoryCache<string>();

          // .note = deliberate mutation (the SANCTIONED escape hatch in
          //   rule.require.immutable-vars): a live max-holders gauge is the one
          //   measurement genuinely built on in-place increment — an immutable
          //   rebuild each tick would not observe the overlap. scope is this closure.
          // this promotes the "atomic acquire → exactly one winner" pitch past the
          // 2-caller proxy: ten simultaneous acquirers, and the gauge must never
          // exceed one.
          let active = 0;
          let maxActive = 0;
          const guarded = withSimpleMutex(
            async (input: { n: number }) => {
              active += 1;
              maxActive = Math.max(maxActive, active);
              await sleep({ milliseconds: 10 });
              active -= 1;
              return input.n;
            },
            {
              key: () => 'many-racers',
              cache,
              acquire: { interval: { milliseconds: 5 } },
            },
          );

          // fire ten at once on the SAME key
          const results = await Promise.all(
            Array.from({ length: 10 }, (_unused, n) => guarded({ n })),
          );

          return {
            maxActive,
            servedCount: results.length,
            allServed: results.slice().sort((a, b) => a - b),
          };
        },
      );

      then(
        'exactly one holder ran at a time (atomic acquire — one winner)',
        () => {
          expect(outcome.maxActive).toEqual(1);
        },
      );

      then('every one of the ten callers was served', () => {
        expect(outcome.servedCount).toEqual(10);
        expect(outcome.allServed).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      });

      then('the at-scale serialization outcome shape is pinned', () => {
        expect(outcome).toMatchSnapshot();
      });
    });
  });

  given(
    '[case14] two independent cache instances hold the same key at the same tier',
    () => {
      when('[t0] each holder has its own cache, same key', () => {
        const outcome = useThen(
          'the two holders run concurrently — a distinct instance is no shared lock',
          async () => {
            // the flip side of the headline pitch: isolation is a property of the cache
            // INSTANCE, not the key. two independent in-memory caches simulate two
            // unconnected processes/machines — the same key does NOT serialize across
            // them, so a caller who constructs a fresh cache per call silently gets no
            // lock (the footgun documented in readme "reuse one cache instance").
            const cacheA = createInMemoryCache<string>();
            const cacheB = createInMemoryCache<string>();

            // .note = deliberate mutation (the SANCTIONED escape hatch in
            //   rule.require.immutable-vars): a live max-holders gauge observes overlap.
            let active = 0;
            let maxActive = 0;
            const logic = async (input: { holder: string }) => {
              active += 1;
              maxActive = Math.max(maxActive, active);
              await sleep({ milliseconds: 40 });
              active -= 1;
              return input.holder;
            };
            const options = {
              key: () => 'shared-key-distinct-instances',
              acquire: { interval: { milliseconds: 5 } },
            };
            const guardedA = withSimpleMutex(logic, {
              ...options,
              cache: cacheA,
            });
            const guardedB = withSimpleMutex(logic, {
              ...options,
              cache: cacheB,
            });

            await Promise.all([
              guardedA({ holder: 'a' }),
              guardedB({ holder: 'b' }),
            ]);

            return { maxActive };
          },
        );

        then(
          'both holders ran at once (a distinct cache instance grants no protection)',
          () => {
            expect(outcome.maxActive).toEqual(2);
          },
        );

        then('the no-shared-lock outcome shape is pinned', () => {
          expect(outcome).toMatchSnapshot();
        });
      });
    },
  );

  given(
    '[case15] the "run exactly once" usecase — a try-once acquire that skips a held key (acquire.timeout = 0)',
    () => {
      when('[t0] a rival tries the key try-once while it is held', () => {
        const outcome = useThen(
          'the try-once attempt skips at once with SimpleMutexAcquireTimeoutError — it neither runs nor waits',
          async () => {
            const cache = createInMemoryCache<string>();

            // the vision's #2 headline usecase — "run exactly once" across a fleet: a
            // second worker should SKIP its run when another already holds the key, rather
            // than wait for it. the idiom is acquire.timeout = 0 (try-once): attempt exactly
            // ONE put-if-absent and, when the key is held, throw at once with no poll wait.
            // proven deterministically by a try-once attempt issued from INSIDE a live
            // holder's critical section (the same in-hold shape as case10), so the key is
            // definitely held — no sleeps, no barrier. this pins the discoverable idiom for
            // the dedup pattern the readme now documents.
            let tryOnceRan = false;
            const tryOnce = withSimpleMutex(
              async () => {
                tryOnceRan = true;
                return 'try-once-ran';
              },
              {
                key: () => 'run-once',
                cache,
                acquire: { timeout: { milliseconds: 0 } },
              },
            );
            const holder = withSimpleMutex(
              // while the key is held, a rival worker attempts the same key try-once
              async () => getError(tryOnce({})),
              { key: () => 'run-once', cache },
            );

            const tryOnceError = await holder({});

            // fail loud on the wrong error, which also narrows the type (no as-cast)
            if (!(tryOnceError instanceof SimpleMutexAcquireTimeoutError))
              throw (
                tryOnceError ??
                new Error(
                  'expected the try-once (timeout:0) acquire to skip with SimpleMutexAcquireTimeoutError while the key was held, but no error was thrown',
                )
              );

            return {
              tryOnceRan,
              shape: {
                caught: true,
                name: tryOnceError.constructor.name,
                // mask the volatile waited-ms so the snapshot pins only the contract
                message: tryOnceError
                  .redact(['metadata'])
                  .message.replace(/waited \d+ms/, 'waited <mse>ms'),
                metadataKeys: Object.keys(tryOnceError.metadata ?? {}).sort(),
              },
            };
          },
        );

        then(
          'the try-once caller skipped — its critical section never ran',
          () => {
            expect(outcome.tryOnceRan).toEqual(false);
          },
        );

        then('the skip is a mutex-owned SimpleMutexAcquireTimeoutError', () => {
          expect(outcome.shape.caught).toEqual(true);
        });

        then('its owned contract shape is stable', () => {
          expect(outcome.shape).toMatchSnapshot();
        });
      });
    },
  );

  given(
    '[case16] the cache backend faults on the acquire put-if-absent — the fault surfaces through the boundary',
    () => {
      // the readme documents MalfunctionError as one promise that spans acquire, release, or both.
      // the release half already has acceptance proof (case6/case8, fault-injected here); this adds
      // the acquire half at the SAME layer, so the documented promise is covered symmetrically
      // (rule.require.contract-snapshot-exhaustiveness — do not prove one half only one layer down).
      when('[t0] the atomic put-if-absent throws a non-condition error', () => {
        const outcome = useThen(
          'the acquire fault surfaces through the public boundary (never hidden)',
          async () => {
            // a real in-memory cache with a fault injected into the ACQUIRE write only: the
            // put-if-absent `set` (value !== undefined) throws a real backend fault; the release
            // `set` (value === undefined) stays real, so the acquire-write fault is isolated.
            const real = createInMemoryCache<string>();
            const cache = genFaultInjectedCache({
              real,
              faults: {
                set: (key, value, options) => {
                  if (value !== undefined) throw new Error('acquire boom');
                  return real.set(key, value, options);
                },
              },
            });

            const guarded = withSimpleMutex(async () => 'the-work-result', {
              key: () => 'acquire-fault',
              cache,
              acquire: { interval: { milliseconds: 10 } },
            });

            const error = await getError(guarded({}));

            // fail loud on the wrong error, which also narrows the type (no as-cast)
            if (!(error instanceof MalfunctionError))
              throw (
                error ??
                new Error(
                  'expected an acquire put-if-absent fault to surface a MalfunctionError, but no error was thrown',
                )
              );

            return {
              shape: {
                caught: true,
                name: error.constructor.name,
                message: error.redact(['metadata']).message,
                metadataKeys: Object.keys(error.metadata ?? {}).sort(),
              },
              namesAcquirePhase: error.message.includes('acquired the lock'),
            };
          },
        );

        then(
          'the acquire fault surfaced as the mutex-owned MalfunctionError',
          () => {
            expect(outcome.shape.caught).toEqual(true);
          },
        );

        then(
          'the message names the acquire phase (never a bare backend error)',
          () => {
            expect(outcome.namesAcquirePhase).toEqual(true);
          },
        );

        then('its owned contract shape is stable', () => {
          expect(outcome.shape).toMatchSnapshot();
        });
      });
    },
  );

  given(
    '[case17] the cache backend faults on the acquire version read — the fault surfaces through the boundary',
    () => {
      // the second acquire-path fault: the put-if-absent wins, then the follow-up version read
      // faults. proven at the acceptance layer too, so both acquire-fault phases match the
      // release-fault treatment (case6/case8) end-to-end.
      when('[t0] the version read throws after a won put-if-absent', () => {
        const outcome = useThen(
          'the version-read fault surfaces through the public boundary (never hidden)',
          async () => {
            // a real in-memory cache; the acquire write is left real (it wins the key) and only
            // the version read is forced to fault, which isolates the second acquire-path fault.
            const real = createInMemoryCache<string>();
            const cache = genFaultInjectedCache({
              real,
              faults: {
                version: () => {
                  throw new Error('version boom');
                },
              },
            });

            const guarded = withSimpleMutex(async () => 'the-work-result', {
              key: () => 'version-fault',
              cache,
              acquire: { interval: { milliseconds: 10 } },
            });

            const error = await getError(guarded({}));

            if (!(error instanceof MalfunctionError))
              throw (
                error ??
                new Error(
                  'expected an acquire version-read fault to surface a MalfunctionError, but no error was thrown',
                )
              );

            return {
              shape: {
                caught: true,
                name: error.constructor.name,
                message: error.redact(['metadata']).message,
                metadataKeys: Object.keys(error.metadata ?? {}).sort(),
              },
              namesVersionReadPhase: error.message.includes(
                'read the lock version',
              ),
            };
          },
        );

        then(
          'the version-read fault surfaced as the mutex-owned MalfunctionError',
          () => {
            expect(outcome.shape.caught).toEqual(true);
          },
        );

        then(
          'the message names the version-read phase (never a bare backend error)',
          () => {
            expect(outcome.namesVersionReadPhase).toEqual(true);
          },
        );

        then('its owned contract shape is stable', () => {
          expect(outcome.shape).toMatchSnapshot();
        });
      });
    },
  );
});
