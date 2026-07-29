/**
 * .what = the lock key as two facets — the caller's ORIGINAL key and the backend-safe key
 * .why =
 *   - `given` is the exact key the caller's `key` getter returned, carried verbatim so a caller
 *     can grep their logs for the key they passed (rule.require.errors-name-the-fix).
 *   - `used` is the sanitized, backend-safe form the cache is actually keyed on (asSafeMutexKey),
 *     so a backend that rejects special characters never sees a raw caller key.
 * .why-shared = this shape is a shared value carried by BOTH error metadata (the two mutex-owned
 *   errors + the wrapped faults) AND internal acquire/release call signatures — 7 sites across 5
 *   files. it is named once here (the sanctioned "3+ reused shapes → named type" exception to
 *   rule.forbid.io-as-domain-objects) so a future facet (e.g. a namespace) or a typo cannot drift
 *   silently across structurally-typed copies. it lives in domain.objects/ alongside SimpleMutexLock
 *   because it is a shared value shape, not any one procedure's i/o.
 */
export interface MutexKey {
  /**
   * the caller's original key, verbatim (grep-able in error logs)
   */
  given: string;

  /**
   * the sanitized, backend-safe key the cache is keyed on
   */
  used: string;
}
