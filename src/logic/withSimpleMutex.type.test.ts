import { createCache } from 'simple-in-memory-cache';
import { given, then, when } from 'test-fns';
import type { SimpleCache } from 'with-simple-cache';

import { withSimpleMutex } from './withSimpleMutex';

/**
 * .what = compile-time pit-of-success test — a NON-conditional cache must not satisfy withSimpleMutex
 * .why = the vision's headline safety property is "a lock without atomic writes is not a lock": a
 *        plain SimpleCache (no `version`/`condition`) must be REJECTED by the type system, not
 *        silently accepted. the `@ts-expect-error` below fails the types gate if that rejection ever
 *        regresses (an UNUSED @ts-expect-error is itself a tsc error), so this is a real
 *        compile-time assertion, not a runtime one.
 */

// a plain, non-conditional cache: it satisfies SimpleCache but NOT WithCacheConditionals.
// `declare const` emits NO runtime code, so this value never exists at runtime.
declare const plainCache: SimpleCache<string>;

// the compile-time assertion lives inside a function that is NEVER invoked: tsc still checks its
// body (so the @ts-expect-error is enforced by the types gate), while jest never executes it (so
// the declare-only `plainCache` is never dereferenced at runtime).
const _assertPlainCacheRejected = (): void => {
  // @ts-expect-error — a plain SimpleCache lacks the conditional-write capability, so it must not
  // be assignable to the `cache` option (WithCacheConditionals<SimpleCache<string>>). if this line
  // ever stops to error, the pit-of-success type contract has regressed and the types gate fails.
  withSimpleMutex(async () => 'x', { key: () => 'k', cache: plainCache });
};
void _assertPlainCacheRejected; // reference it so it is not an unused-symbol lint error

describe('withSimpleMutex — compile-time cache contract', () => {
  given('[case1] the pit-of-success type contract on the cache option', () => {
    when('[t0] a conditional-write cache is passed', () => {
      then('it is accepted and yields a guarded function', () => {
        // the positive half: a real conditional cache (in-memory) IS accepted. the negative
        // half — a plain cache is rejected — is proven by the @ts-expect-error above, which the
        // types gate enforces at compile time.
        const guarded = withSimpleMutex(async () => 'x', {
          key: () => 'k',
          cache: createCache<string>(),
        });
        expect(typeof guarded).toEqual('function');
      });
    });
  });
});
