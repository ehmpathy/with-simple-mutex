/**
 * .what = a real cache with one-or-more methods swapped for fault-inject stubs
 * .why = the fault-path tests each need a REAL backend with a single method overridden to
 *        fault (release throws, the version read faults or returns undefined, the put faults,
 *        a crashed holder never releases). this collapses the hand-rolled
 *        `{ ...real, <override> }` stubs — repeated well past the rule-of-three across the
 *        integration + acceptance suites — into one typed helper, so the `typeof real` trick
 *        lives in one place (rule.prefer.wet-over-dry).
 * .note = TCache is inferred from the `real` cache passed in (sync in-memory or async on-disk),
 *         so the returned stub keeps that cache's exact method signatures; `faults` is a
 *         Partial of those methods, so an override with the wrong shape fails to compile.
 * .note = lives under `.test/` (build-excluded per tsconfig.build.json), so it is test-only
 *         and never ships to dist (rule.forbid.test-assets-dunder — the sanctioned dot-dir home).
 */
export const genFaultInjectedCache = <TCache extends object>(input: {
  real: TCache;
  faults: Partial<TCache>;
}): TCache => ({ ...input.real, ...input.faults });
