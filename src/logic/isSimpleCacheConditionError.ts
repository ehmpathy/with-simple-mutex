import { SimpleCacheConditionError } from 'with-simple-cache';

/**
 * .removal = the name-fallback branch is a stopgap, not a permanent measure. it exists ONLY
 *   because each backend redefines its own SimpleCacheConditionError class (to dodge the
 *   with-simple-cache ↔ on-disk runtime cycle). the branch is safe to delete the day every backend
 *   throws with-simple-cache's canonical class directly — e.g. once with-simple-cache exposes the
 *   error via a zero-dependency sub-path the backends can import without the cycle. until that
 *   upstream fix lands, the fallback stays; it is not silent debt — this note is its expiry condition.
 * .what = a backend-agnostic type guard: true when a thrown value is a cache
 *         precondition failure (SimpleCacheConditionError) from ANY conditional-write
 *         backend — in-memory, on-disk, s3-cloud, or a caller's own implementation
 * .why =
 *   - the mutex is cache-agnostic: it must not import from any one backend, or it couples
 *     the primitive to that backend and breaks the "swap the cache to swap the tier"
 *     contract (directional-deps + the vision's backend-agnostic intent). with-simple-cache
 *     is the generic CONTRACT package (already a direct dep + the type source), not a backend.
 *   - primary check: `instanceof` the canonical class from with-simple-cache — this survives
 *     minification, because it tests the class identity, not a string name.
 *   - fallback check: each backend redefines its OWN SimpleCacheConditionError class
 *     (with-simple-cache depends on the on-disk backend at runtime, so a single shared class
 *     would form a dependency cycle), so `instanceof` the canonical class misses a copy thrown
 *     by a backend. all copies extend `ConstraintError` and share the class name, so the name
 *     is a stable cross-package marker for those copies. the on-disk cloud adapter reconciles a
 *     raw s3 precondition failure into its own SimpleCacheConditionError before it reaches here,
 *     so this pair covers every shipped tier.
 * .note = accepted limitation, under a specific bundler shape: if a minifier BOTH duplicates
 *   with-simple-cache into two copies (so `instanceof` the canonical class misses the other
 *   copy) AND mangles class names (so `constructor.name` is no longer 'SimpleCacheConditionError'),
 *   both branches miss and a genuine lost-race is misclassified. the degradation is FAIL-LOUD, not
 *   silent: the acquire path then throws a MalfunctionError (a contention that should have polled
 *   instead hard-fails) — never a silent mutual-exclusion breach. mitigation: package managers
 *   dedupe with-simple-cache to a SINGLE copy by default (pnpm/npm collapse a compatible range),
 *   so `instanceof` holds and the fallback is never reached. the case4 unit test documents this
 *   degraded path honestly rather than force the name back to correct.
 */
export const isSimpleCacheConditionError = (error: unknown): boolean =>
  error instanceof SimpleCacheConditionError ||
  (error instanceof Error &&
    error.constructor.name === 'SimpleCacheConditionError');
