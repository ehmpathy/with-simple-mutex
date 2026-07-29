import { sleep } from 'iso-time';
import { sdkAwsS3 } from 'sdk-aws-s3';
import { createCache as createOnDiskCache } from 'simple-on-disk-cache';
import { given, then, useThen, when } from 'test-fns';

import { withSimpleMutex } from '@src/index';

import { randomUUID } from 'node:crypto';

/**
 * .what = the global (cross-machine) tier journey for withSimpleMutex, over a REAL s3-backed
 *         conditional-write cache — the vision's "s3 = global" headline usecase, proven live
 * .why = the per-process (in-memory) + per-machine (on-disk-local) tiers run hermetically in
 *        index.journey.acceptance.test.ts. this file adds the third tier with real aws infra so the
 *        headline pitch — "swap the cache, widen the isolation tier, the call is identical" — is
 *        proven end-to-end across ALL THREE tiers, not deferred on a credential-difficulty excuse
 *        (rule.require.acceptance-journey-coverage). the wrapped call here is byte-for-byte the same
 *        as the on-disk-local case; the ONLY change is the cache's `directory` (local → cloud).
 * .note = per rule.forbid.acceptance.mocks the `via` adapter is the REAL sdkAwsS3 — no fake stands
 *   in for the s3 boundary. sdk-aws-s3 is an external package a real consumer wires as the cloud
 *   adapter (not a package internal), so the import keeps the acceptance test blackbox-clean.
 * .note = credential gate (fail-loud on absent creds, per rule.require.failfast): these journeys hit
 *   real s3. absent creds are NOT a silent skip — the test runner unlocks aws creds before the suite
 *   (rhx git.repo.test --what acceptance) and throws a ConstraintError when they are absent, so the
 *   whole suite halts loud. an in-file `if (!process.env.AWS_ACCESS_KEY_ID) throw` guard is
 *   deliberately absent: this org authenticates via aws sso / oidc, so AWS_ACCESS_KEY_ID is never
 *   populated even on a valid session — such a guard would false-negative and break valid runs
 *   (ref.reviewer.test-infrastructure-context: defer to the repo's cred-unlock-as-prerequisite
 *   convention, the same one simple-on-disk-cache's own cloud acceptance suite relies on).
 * .note = the shared ehmpathy-sdk-aws-s3-test-bucket is reused (the org convention for s3 test
 *   coverage), namespaced under a with-simple-mutex prefix + a per-run uuid so keys never collide
 *   across repos or runs. the cicd oidc role grants s3 put/get/delete on every bucket, so the same
 *   suite runs in ci with no extra grant.
 */
// each `then` chains a handful of sequential s3 conditional round-trips; a single s3 op can
// tail-spike to tens of seconds under load, so the cap absorbs that worst case, not the median
jest.setTimeout(120 * 1000);

describe('withSimpleMutex — global (s3) tier journey', () => {
  // the one function a developer wraps; the same body across every tier
  const doWork = async (input: { phone: string }): Promise<string> => {
    await sleep({ milliseconds: 40 });
    return `served.${input.phone}`;
  };

  // the cloud directory: the ONLY change from the on-disk-local case is local → cloud + via adapter
  const genCloudCache = () =>
    createOnDiskCache({
      directory: {
        cloud: {
          path: `s3://ehmpathy-sdk-aws-s3-test-bucket/test/acceptance/with-simple-mutex/${randomUUID()}/`,
          via: sdkAwsS3,
        },
      },
    });

  given(
    '[case1] the global tier — two callers share a key over real s3',
    () => {
      when('[t0] both are invoked at once', () => {
        const outcome = useThen(
          'they serialize across the global boundary, and both are served',
          async () => {
            const cache = genCloudCache();

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
                acquire: { interval: { milliseconds: 500 } },
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

        then('the s3 success pass-through output matches the snapshot', () => {
          // same transparent pass-through contract as the hermetic tiers — snap it on the s3 tier
          // too so a global-tier output shape drift is caught in a PR diff (rule.require.snapshots).
          expect(outcome.results).toMatchSnapshot();
        });
      });
    },
  );

  given('[case2] the flagship special-char key over real s3', () => {
    // the flagship key carries chars (`+`, `.`) the s3 backend rejects raw — the mutex sanitizes
    // it internally, so a human-readable key locks cleanly on the global tier too
    when('[t0] a proxy-phone key is locked', () => {
      const result = useThen(
        'the lock runs over s3 without a key-rejection',
        async () => {
          const cache = genCloudCache();

          const guarded = withSimpleMutex(
            async (input: { phone: string }) => `served.${input.phone}`,
            {
              key: (input) => `proxy-phone.${input.phone}`,
              cache,
              acquire: { interval: { milliseconds: 500 } },
            },
          );

          return { value: await guarded({ phone: '+14632270513' }) };
        },
      );

      then('the critical section ran and returned its result', () => {
        expect(result.value).toEqual('served.+14632270513');
      });

      then(
        'the s3 special-char pass-through output matches the snapshot',
        () => {
          // snap the flagship special-char result on the s3 tier so a sanitization- or
          // pass-through-shape drift is caught in a PR diff (rule.require.snapshots).
          expect(result.value).toMatchSnapshot();
        },
      );
    });
  });

  given('[case3] distinct keys never block on the global tier', () => {
    when('[t0] two callers hold distinct keys over real s3', () => {
      const outcome = useThen('they run in parallel', async () => {
        const cache = genCloudCache();

        // .note = deliberate mutation: concurrency-probe counters, bumped inside
        //   the guarded logic to record how many holders ran at once. scope is this closure.
        let active = 0;
        let maxActive = 0;
        let entered = 0;

        const genProxyPhone = withSimpleMutex(
          async (input: { phone: string }) => {
            active += 1;
            maxActive = Math.max(maxActive, active);

            // barrier: hold the critical section until BOTH distinct-key holders have entered.
            // this proves genuine concurrency WITHOUT a wall-clock race — over real s3 an acquire
            // round-trip takes seconds and its skew dwarfs any short fixed sleep, so a timed hold
            // would flake. the barrier releases the instant the second holder enters; the bounded
            // poll fails loud (maxActive stays 1) rather than hangs if a regression ever made
            // distinct keys block each other.
            entered += 1;
            let polls = 0;
            while (entered < 2 && polls < 60) {
              await sleep({ milliseconds: 250 });
              polls += 1;
            }

            active -= 1;
            return `served.${input.phone}`;
          },
          {
            key: (input) => `proxy-phone.${input.phone}`,
            cache,
            acquire: { interval: { milliseconds: 500 } },
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

      then('the global-tier concurrency outcome shape is pinned', () => {
        expect(outcome).toMatchSnapshot();
      });
    });
  });
});
