import { getError, MalfunctionError } from 'helpful-errors';
import { sleep } from 'iso-time';
import { createCache } from 'simple-in-memory-cache';
import { given, then, useThen, when } from 'test-fns';

import { genFaultInjectedCache } from '../.test/genFaultInjectedCache';
import { SimpleMutexAcquireTimeoutError } from '../domain.objects/SimpleMutexAcquireTimeoutError';
import { SimpleMutexLeaseExpiredError } from '../domain.objects/SimpleMutexLeaseExpiredError';
import { withSimpleMutex } from './withSimpleMutex';

/**
 * .what = integration tests for withSimpleMutex over an in-memory cache (per-process tier)
 * .why = the in-memory backend is a real conditional-write cache, so these exercise the
 *        mutex's true acquire/hold/release path without mocks
 */
describe('withSimpleMutex (in-memory / per-process)', () => {
  given('[case1] two concurrent calls on the same key', () => {
    when('[t0] both are invoked at once', () => {
      const outcome = useThen('they serialize (never overlap)', async () => {
        const cache = createCache<string>();

        // track how many holders run the critical section at once
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
            acquire: { interval: { milliseconds: 10 } },
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

      then('both calls completed and returned their own result', () => {
        expect(outcome.results.sort()).toEqual([1, 2]);
      });
    });
  });

  given('[case2] two concurrent calls on different keys', () => {
    when('[t0] both are invoked at once', () => {
      const outcome = useThen('they run in parallel', async () => {
        const cache = createCache<string>();

        // .note = deliberate mutation (the SANCTIONED escape hatch in rule.require.immutable-vars:
        //   "isolate unavoidable mutation in scoped zones with a .note = deliberate mutation
        //   comment"). these are concurrency-probe counters — a live max-holders gauge is the one
        //   measurement genuinely built on in-place increment; an immutable rebuild each tick would
        //   not observe the overlap. scope is this one closure.
        let active = 0;
        let observed = 0;

        const guarded = withSimpleMutex(
          async (input: { key: string }) => {
            active += 1;
            observed = Math.max(observed, active);
            await sleep({ milliseconds: 50 });
            active -= 1;
          },
          {
            key: (input) => input.key,
            cache,
            acquire: { interval: { milliseconds: 10 } },
          },
        );

        await Promise.all([guarded({ key: 'a' }), guarded({ key: 'b' })]);

        return { maxActive: observed };
      });

      then(
        'both holders ran concurrently (different keys do not block)',
        () => {
          expect(outcome.maxActive).toEqual(2);
        },
      );
    });
  });

  given(
    '[case3] a key already held, and a rival with a short acquire timeout',
    () => {
      when('[t0] the rival cannot acquire before its timeout', () => {
        const outcome = useThen(
          'it throws SimpleMutexAcquireTimeoutError',
          async () => {
            const cache = createCache<string>();

            const guarded = withSimpleMutex(
              async () => {
                await sleep({ milliseconds: 200 });
              },
              {
                key: () => 'contended',
                cache,
                lease: { duration: { seconds: 10 } },
                acquire: {
                  timeout: { milliseconds: 50 },
                  interval: { milliseconds: 10 },
                },
              },
            );

            // first holder takes and keeps the lock
            const held = guarded({});

            // rival races for the same key, but times out before the holder releases
            const rivalError = await getError(guarded({}));

            // let the holder finish so the test does not leak a dangling promise
            await held;

            return { error: rivalError };
          },
        );

        then('the error is the typed acquire-timeout', () => {
          expect(outcome.error).toBeInstanceOf(SimpleMutexAcquireTimeoutError);
        });
      });
    },
  );

  given('[case4] a critical section that outlives its lease', () => {
    when('[t0] the lease deadline fires before logic finishes', () => {
      const outcome = useThen(
        'it throws SimpleMutexLeaseExpiredError',
        async () => {
          const cache = createCache<string>();

          const guarded = withSimpleMutex(
            async () => {
              // runs far longer than the lease below
              await sleep({ milliseconds: 300 });
              return 'done';
            },
            {
              key: () => 'slow',
              cache,
              lease: { duration: { milliseconds: 50 } },
              acquire: { interval: { milliseconds: 10 } },
            },
          );

          return { error: await getError(guarded({})) };
        },
      );

      then('the error is the typed lease-expiry', () => {
        expect(outcome.error).toBeInstanceOf(SimpleMutexLeaseExpiredError);
      });
    });
  });

  given('[case5] a released lock and a later caller', () => {
    when('[t0] the first holder finishes, then a second acquires', () => {
      const second = useThen(
        'the second caller acquires and runs',
        async () => {
          const cache = createCache<string>();

          const guarded = withSimpleMutex(
            async (input: { id: number }) => {
              await sleep({ milliseconds: 20 });
              return input.id;
            },
            {
              key: () => 'sequential',
              cache,
              acquire: { interval: { milliseconds: 10 } },
            },
          );

          const first = await guarded({ id: 1 });
          const later = await guarded({ id: 2 });

          return { first, later };
        },
      );

      then('both ran and released cleanly in order', () => {
        expect(second.first).toEqual(1);
        expect(second.later).toEqual(2);
      });
    });
  });

  given('[case6] a critical section that throws', () => {
    when('[t0] logic throws', () => {
      const outcome = useThen(
        'the error propagates and the lock is released',
        async () => {
          const cache = createCache<string>();

          const guarded = withSimpleMutex(
            async (input: { boom: boolean }) => {
              if (input.boom) throw new Error('kaboom');
              return 'ok';
            },
            {
              key: () => 'boom-key',
              cache,
              acquire: { interval: { milliseconds: 10 } },
            },
          );

          const thrown = await getError(guarded({ boom: true }));

          // the lock must have been released — a later caller can still acquire
          const after = await guarded({ boom: false });

          return { thrown, after };
        },
      );

      then('the original error surfaced (not masked as a lock failure)', () => {
        expect(outcome.thrown.message).toContain('kaboom');
      });

      then('the lock was released, so a later caller runs', () => {
        expect(outcome.after).toEqual('ok');
      });
    });
  });

  given(
    '[case7] logic succeeds but the release fails with a real error',
    () => {
      when('[t0] the compare-and-delete throws a non-condition error', () => {
        const outcome = useThen(
          'the unexpected release fault propagates to the caller (never hidden)',
          async () => {
            // a real in-memory cache, with a fault injected into the release path only:
            // the compare-and-delete is `set(key, undefined, { condition })` — force it to
            // throw a real (non-condition) error, as a network/backend fault would.
            const real = createCache<string>();
            const cache = genFaultInjectedCache({
              real,
              faults: {
                set: (key, value, options) => {
                  if (value === undefined) throw new Error('release boom');
                  return real.set(key, value, options);
                },
              },
            });

            const guarded = withSimpleMutex(async () => 'result', {
              key: () => 'release-fault',
              cache,
              acquire: { interval: { milliseconds: 10 } },
            });

            // an UNEXPECTED release fault on the success path is not swallowed — it is
            // surfaced WRAPPED (rule.forbid.failhide + rule.forbid.friction-hazards): the
            // wrapper states the work succeeded and carries the release fault. the one expected
            // miss (a rival owns the key) is already absorbed inside delMutexLock, so only a
            // genuine backend fault ever reaches the caller this way.
            const error = await getError(guarded({}));

            // snapshot the wrapped fault's durable contract shape (metadata redacted so the
            // volatile key hash cannot flake the snap), narrowed here inside the callback.
            const isWrapped = error instanceof MalfunctionError;
            const shape = isWrapped
              ? {
                  caught: true,
                  name: error.constructor.name,
                  message: error.redact(['metadata']).message,
                  metadataKeys: Object.keys(error.metadata ?? {}).sort(),
                }
              : { caught: false, name: error?.name ?? null };

            return { error, shape };
          },
        );

        then(
          'the work-succeeded signal and the release fault both surface',
          () => {
            // the wrapper message states the work succeeded; the release fault is in metadata
            expect(outcome.error?.message).toContain('succeeded');
            expect(outcome.error?.message).toContain('release boom');
          },
        );

        then('the wrapped fault contract shape is stable', () => {
          expect(outcome.shape).toMatchSnapshot();
        });
      });
    },
  );

  given('[case8] logic throws and the release also fails', () => {
    when(
      '[t0] neither the primary error nor the release fault may be hidden',
      () => {
        const outcome = useThen(
          'a combined fault surfaces BOTH errors to the caller',
          async () => {
            // a real in-memory cache; the release compare-and-delete faults, same as case7
            const real = createCache<string>();
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

            // snapshot the combined fault's durable contract shape: identity, the
            // user-faced message (metadata redacted so the volatile key hash cannot
            // flake the snapshot), and the metadata schema — narrowed here, inside the
            // callback, where `error` is the real value (not a deferred proxy).
            const isCombined = error instanceof MalfunctionError;
            const shape = isCombined
              ? {
                  caught: true,
                  name: error.constructor.name,
                  message: error.redact(['metadata']).message,
                  metadataKeys: Object.keys(error.metadata ?? {}).sort(),
                }
              : { caught: false, name: error?.name ?? null };

            return { error, shape };
          },
        );

        then(
          'the primary logic error is preserved (its cause), not masked',
          () => {
            expect(outcome.error?.message).toContain('logic boom');
          },
        );

        then('the release fault is surfaced too (never hidden)', () => {
          expect(outcome.error?.message).toContain('release boom');
        });

        then('the combined fault contract shape is stable', () => {
          expect(outcome.shape).toMatchSnapshot();
        });
      },
    );
  });

  given(
    '[case9] a holder crashes mid-work (never releases) — native expiration reclaims the key',
    () => {
      when('[t0] the crashed holder still holds, then its lease lapses', () => {
        const outcome = useThen(
          'a rival is blocked while the lease is live, then reclaims the natively-expired key',
          async () => {
            // simulate a CRASH: a holder acquires the key, but its release never lands — a
            // died process runs no release. we model that with a cache whose compare-and-delete
            // (a `set` with value=undefined) is a no-op, so the acquire's lock — written with
            // `expiration: lease` — is left in the cache exactly as it would be post-crash.
            // every other op uses the real in-memory cache, so native expiration is real.
            const real = createCache<string>();
            const cache = genFaultInjectedCache({
              real,
              faults: {
                set: (key, value, options) => {
                  if (value === undefined) return; // the crashed holder never released
                  return real.set(key, value, options);
                },
              },
            });

            // the crashed holder: acquires with a SHORT lease and "returns", but because the
            // release is suppressed, the key persists until the cache natively expires it.
            const crashedHolder = withSimpleMutex(async () => 'crashed', {
              key: () => 'crash-recovery',
              cache,
              lease: { duration: { milliseconds: 150 } },
              acquire: { interval: { milliseconds: 10 } },
            });
            await crashedHolder({});

            // a rival on the SAME key with a short acquire timeout. while the crashed holder's
            // lease is still live the key is present, so the rival's put-if-absent keeps failing
            // and it times out — proof that the crashed lock still holds others off.
            const impatientRival = withSimpleMutex(async () => 'reclaimed', {
              key: () => 'crash-recovery',
              cache,
              acquire: {
                timeout: { milliseconds: 50 },
                interval: { milliseconds: 10 },
              },
            });
            const blockedError = await getError(impatientRival({}));

            // wait past the crashed holder's lease so the cache natively evicts the stale key
            await sleep({ milliseconds: 250 });

            // now a caller reclaims the now-absent key via plain put-if-absent — no manual
            // steal, no cleanup: native expiration did the reclaim, exactly the v1 design.
            const reclaimed = await impatientRival({});

            return { blockedError, reclaimed };
          },
        );

        then('the rival was blocked while the crashed lease was live', () => {
          expect(outcome.blockedError).toBeInstanceOf(
            SimpleMutexAcquireTimeoutError,
          );
        });

        then(
          'after the lease lapsed, native expiration let the next caller reclaim the key',
          () => {
            expect(outcome.reclaimed).toEqual('reclaimed');
          },
        );
      });
    },
  );

  given(
    '[case10] logic throws SYNCHRONOUSLY (a non-async guard clause) — the lock still releases',
    () => {
      when('[t0] a rival tries the same key right after the sync throw', () => {
        const outcome = useThen(
          'the caller gets the sync error, and the key is freed at once (not held until the lease)',
          async () => {
            const cache = createCache<string>();

            // a caller may hand us a NON-async logic that throws before it returns a promise.
            // the wrapper normalizes that synchronous throw into a rejection, so the release
            // chain still fires. `as unknown as` casts the sync-throw shape to the async
            // signature the type demands — the whole point is to exercise the non-async caller.
            const guarded = withSimpleMutex(
              (() => {
                throw new Error('sync boom');
              }) as unknown as () => Promise<string>,
              {
                key: () => 'sync-throw',
                cache,
                // a LONG lease: if release did not fire, the key would stay held ~30m and the
                // rival below would time out. a fast rival success proves proactive release.
                lease: { duration: { minutes: 30 } },
                acquire: { interval: { milliseconds: 10 } },
              },
            );
            const syncError = await getError(guarded({}));

            // a rival on the SAME key with a short acquire timeout. it can only win if the
            // sync-throw path already released the key — the 30m lease has not lapsed.
            const rival = withSimpleMutex(async () => 'rival-ran', {
              key: () => 'sync-throw',
              cache,
              acquire: {
                timeout: { milliseconds: 200 },
                interval: { milliseconds: 10 },
              },
            });
            const rivalResult = await rival({});

            return { syncError, rivalResult };
          },
        );

        then(
          'the caller receives the synchronous error, not a lease timeout',
          () => {
            expect(outcome.syncError).toBeInstanceOf(Error);
            expect(outcome.syncError?.message).toContain('sync boom');
          },
        );

        then('the rival acquired at once — proof the lock was released', () => {
          expect(outcome.rivalResult).toEqual('rival-ran');
        });
      });
    },
  );

  given(
    '[case11] a guarded call re-enters its OWN key from inside its critical section (reentrancy)',
    () => {
      // the readme documents the lock as NOT reentrant: it is keyed, not owner-aware, so a call that
      // takes the same key from inside its own held section does not recognize itself — it waits like
      // any rival. this pins that documented contract so a future acquire-loop change cannot silently
      // make the lock self-grant (a correctness change) or deadlock differently, with no test to catch it.
      when(
        '[t0] the inner acquire runs while the outer still holds the key',
        () => {
          const outcome = useThen(
            'the inner call self-blocks and times out — it does NOT self-grant',
            async () => {
              const cache = createCache<string>();

              // the inner guarded call takes the SAME key, with a short bounded acquire timeout so the
              // self-block surfaces as a prompt typed error rather than a hang
              const inner = withSimpleMutex(async () => 'inner-ran', {
                key: () => 'reentrant',
                cache,
                acquire: {
                  timeout: { milliseconds: 100 },
                  interval: { milliseconds: 10 },
                },
              });

              // the outer call holds the key, then — still inside its own critical section — invokes
              // the inner call on the same key. if the lock were reentrant, inner would run; since it
              // is not, inner cannot acquire the key the outer still holds, so it times out.
              const outer = withSimpleMutex(
                async () => {
                  const innerError = await getError(inner({}));
                  return { innerError };
                },
                {
                  key: () => 'reentrant',
                  cache,
                  lease: { duration: { minutes: 30 } },
                  acquire: { interval: { milliseconds: 10 } },
                },
              );

              return await outer({});
            },
          );

          then(
            'the inner call failed with the mutex-owned acquire-timeout error',
            () => {
              expect(outcome.innerError).toBeInstanceOf(
                SimpleMutexAcquireTimeoutError,
              );
            },
          );

          then(
            'the inner call did NOT self-grant (never ran its logic)',
            () => {
              // had the lock been reentrant, innerError would be null and inner would have returned
              // 'inner-ran'. the typed timeout is the proof the same-key re-entry was denied.
              expect(outcome.innerError).not.toBeNull();
            },
          );
        },
      );
    },
  );

  given(
    '[case12] the cache backend faults on the acquire put-if-absent write',
    () => {
      // the release-fault variants (case7/case8) are proven through the public withSimpleMutex
      // boundary, but the acquire-fault variants had proof only at the genMutexLock layer below.
      // withSimpleMutex does zero transform on what genMutexLock throws, so an acquire fault is a
      // genuine caller-faced variant of THIS contract — pinned here for parity with the release
      // faults (rule.require.contract-snapshot-exhaustiveness).
      when('[t0] the atomic put-if-absent throws a non-condition error', () => {
        const outcome = useThen(
          'the acquire fault surfaces through the public boundary (never hidden)',
          async () => {
            // a real in-memory cache, with a fault injected into the ACQUIRE path only: the
            // put-if-absent is `set(key, value, { condition: { version: null } })` with a real
            // value — force it to throw a real (non-condition) error, as a backend fault would.
            // the release path (`set` with value=undefined) is left real, so this isolates the
            // acquire-write fault.
            const real = createCache<string>();
            const cache = genFaultInjectedCache({
              real,
              faults: {
                set: (key, value, options) => {
                  if (value !== undefined) throw new Error('acquire boom');
                  return real.set(key, value, options);
                },
              },
            });

            const guarded = withSimpleMutex(async () => 'result', {
              key: () => 'acquire-fault',
              cache,
              acquire: { interval: { milliseconds: 10 } },
            });

            const error = await getError(guarded({}));

            // snapshot the acquire fault's durable contract shape (metadata redacted so the
            // volatile key hash cannot flake the snap), narrowed here inside the callback.
            const isWrapped = error instanceof MalfunctionError;
            const shape = isWrapped
              ? {
                  caught: true,
                  name: error.constructor.name,
                  message: error.redact(['metadata']).message,
                  metadataKeys: Object.keys(error.metadata ?? {}).sort(),
                }
              : { caught: false, name: error?.name ?? null };

            return { error, shape };
          },
        );

        then('the acquire fault surfaced as a MalfunctionError', () => {
          expect(outcome.error).toBeInstanceOf(MalfunctionError);
        });

        then('the message names the acquire phase and the fix', () => {
          expect(outcome.error?.message).toContain('acquired the lock');
          expect(outcome.error?.message).toContain('a retry is safe');
        });

        then('the acquire-fault contract shape is stable', () => {
          expect(outcome.shape).toMatchSnapshot();
        });
      });
    },
  );

  given('[case13] the cache backend faults on the acquire version read', () => {
    // the second acquire-path fault: the put-if-absent wins, then the follow-up version read
    // faults. it surfaces through the public boundary with a distinct phase message (the retry
    // story differs — a won write may sit just behind it), so pin it too.
    when('[t0] the version read throws after a won put-if-absent', () => {
      const outcome = useThen(
        'the version-read fault surfaces through the public boundary (never hidden)',
        async () => {
          // a real in-memory cache; the acquire WRITE is left real (it wins the key), and only
          // the version read is forced to fault — isolating the second acquire-path fault.
          const real = createCache<string>();
          const cache = genFaultInjectedCache({
            real,
            faults: {
              version: () => {
                throw new Error('version boom');
              },
            },
          });

          const guarded = withSimpleMutex(async () => 'result', {
            key: () => 'version-fault',
            cache,
            acquire: { interval: { milliseconds: 10 } },
          });

          const error = await getError(guarded({}));

          const isWrapped = error instanceof MalfunctionError;
          const shape = isWrapped
            ? {
                caught: true,
                name: error.constructor.name,
                message: error.redact(['metadata']).message,
                metadataKeys: Object.keys(error.metadata ?? {}).sort(),
              }
            : { caught: false, name: error?.name ?? null };

          return { error, shape };
        },
      );

      then('the version-read fault surfaced as a MalfunctionError', () => {
        expect(outcome.error).toBeInstanceOf(MalfunctionError);
      });

      then('the message names the version-read phase and the fix', () => {
        expect(outcome.error?.message).toContain('read the lock version');
        expect(outcome.error?.message).toContain('lease lapses and frees it');
      });

      then('the version-read-fault contract shape is stable', () => {
        expect(outcome.shape).toMatchSnapshot();
      });
    });
  });
});
