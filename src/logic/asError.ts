/**
 * .what = cast an unknown thrown value into an Error, preserved as-is if it already is one
 * .why = a catch clause receives `unknown`, and a caller may throw a non-Error (a string, an
 *        object). every fault path that keeps a `cause` chain or reports a `.message` needs one
 *        stable Error shape. this idiom recurred across the mutex logic past the rule-of-three
 *        threshold (rule.prefer.wet-over-dry), so it is one pure transformer with one unit test
 *        rather than a scattered inline ternary that can drift between call sites.
 */
export const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));
