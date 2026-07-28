import { asError } from './asError';

/**
 * .what = unit tests for asError (pure unknown → Error transformer)
 * .why = every fault path leans on one stable Error shape; a data-driven caselist proves the
 *        cast for each kind of thrown value (rule.prefer.data-driven)
 */
describe('asError', () => {
  const original = new Error('boom');

  const cases = [
    {
      description: 'preserves an Error as the same reference',
      given: original as unknown,
      expect: { same: true, message: 'boom' },
    },
    {
      description:
        'wraps a string into an Error with the string as its message',
      given: 'plain string throw' as unknown,
      expect: { same: false, message: 'plain string throw' },
    },
    {
      description: 'wraps undefined into an Error',
      given: undefined as unknown,
      expect: { same: false, message: 'undefined' },
    },
    {
      description: 'wraps a plain object into an Error via String()',
      given: { code: 500 } as unknown,
      expect: { same: false, message: '[object Object]' },
    },
  ];

  cases.map((thisCase) =>
    test(thisCase.description, () => {
      const output = asError(thisCase.given);
      expect(output).toBeInstanceOf(Error);
      expect(output.message).toEqual(thisCase.expect.message);
      if (thisCase.expect.same) expect(output).toBe(original);
    }),
  );
});
