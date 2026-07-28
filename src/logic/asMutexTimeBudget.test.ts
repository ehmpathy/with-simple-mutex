import { ConstraintError, getError } from 'helpful-errors';

import { asMutexTimeBudget, MSE_TIMER_MAX } from './asMutexTimeBudget';

// MSE_TIMER_MAX (2^31-1 ms, ~24.8 days) is imported from source, not re-declared, so the
// boundary assertions cannot drift from the value the guard actually enforces.

/**
 * .what = unit tests for asMutexTimeBudget (pure derivation of lease + acquire budgets in ms)
 * .why = the defaults are the authoritative readme contract; a data-driven caselist proves each
 *        default and each override at the unit grain (rule.prefer.data-driven). a second block
 *        proves the timer-bounds guard: a lease/interval a js timer cannot honor fails fast with a
 *        ConstraintError, rather than a setTimeout that misfires at ~1ms and silently frees the lock.
 */
describe('asMutexTimeBudget', () => {
  const cases = [
    {
      description:
        'applies all defaults when both are absent (30m lease, 1s poll, no timeout)',
      given: { lease: null, acquire: null },
      expect: {
        leaseDuration: { minutes: 30 },
        leaseMse: 30 * 60 * 1000,
        intervalMse: 1000,
        timeoutMse: null,
      },
    },
    {
      description: 'honors a caller lease duration',
      given: { lease: { duration: { seconds: 5 } }, acquire: null },
      expect: {
        leaseDuration: { seconds: 5 },
        leaseMse: 5000,
        intervalMse: 1000,
        timeoutMse: null,
      },
    },
    {
      description: 'honors a caller acquire timeout + interval',
      given: {
        lease: null,
        acquire: { timeout: { seconds: 30 }, interval: { milliseconds: 250 } },
      },
      expect: {
        leaseDuration: { minutes: 30 },
        leaseMse: 30 * 60 * 1000,
        intervalMse: 250,
        timeoutMse: 30000,
      },
    },
  ];

  cases.map((thisCase) =>
    test(thisCase.description, () => {
      expect(asMutexTimeBudget(thisCase.given)).toEqual(thisCase.expect);
    }),
  );

  describe('timer-bounds guard (lease/interval a js timer cannot honor)', () => {
    test('accepts a lease exactly at the timer max (boundary is inclusive)', () => {
      const budget = asMutexTimeBudget({
        lease: { duration: { milliseconds: MSE_TIMER_MAX } },
        acquire: null,
      });
      expect(budget.leaseMse).toEqual(MSE_TIMER_MAX);
    });

    test('rejects a lease one ms above the timer max, and states the fix', async () => {
      const error = await getError(() =>
        asMutexTimeBudget({
          lease: { duration: { milliseconds: MSE_TIMER_MAX + 1 } },
          acquire: null,
        }),
      );
      expect(error).toBeInstanceOf(ConstraintError);
      expect(error.message).toContain('lease.duration');
      expect(error.message).toContain('platform timer max');
      // the vision's headline long-lease case (30 days) is well past the max — the exact regression
      const longLease = await getError(() =>
        asMutexTimeBudget({ lease: { duration: { days: 30 } }, acquire: null }),
      );
      expect(longLease).toBeInstanceOf(ConstraintError);
    });

    test('rejects a zero or negative lease, and states the fix', async () => {
      const zero = await getError(() =>
        asMutexTimeBudget({
          lease: { duration: { milliseconds: 0 } },
          acquire: null,
        }),
      );
      expect(zero).toBeInstanceOf(ConstraintError);
      expect(zero.message).toContain('positive duration');
    });

    test('rejects an interval above the timer max (the acquire poll also arms a timer)', async () => {
      const error = await getError(() =>
        asMutexTimeBudget({
          lease: null,
          acquire: { interval: { milliseconds: MSE_TIMER_MAX + 1 } },
        }),
      );
      expect(error).toBeInstanceOf(ConstraintError);
      expect(error.message).toContain('acquire.interval');
    });

    test('rejects a zero or negative interval, and states the fix (symmetric with the lease guard)', async () => {
      // acquire.interval shares the same guard as lease.duration — both are armed as
      // setTimeout delays — so the zero/negative boundary must reject on BOTH fields,
      // not just the lease. this closes the boundary-coverage asymmetry.
      const zero = await getError(() =>
        asMutexTimeBudget({
          lease: null,
          acquire: { interval: { milliseconds: 0 } },
        }),
      );
      expect(zero).toBeInstanceOf(ConstraintError);
      expect(zero.message).toContain('acquire.interval');
      expect(zero.message).toContain('positive duration');

      const negative = await getError(() =>
        asMutexTimeBudget({
          lease: null,
          acquire: { interval: { milliseconds: -5 } },
        }),
      );
      expect(negative).toBeInstanceOf(ConstraintError);
      expect(negative.message).toContain('acquire.interval');
    });

    test('does NOT bounds-check timeout (compared numerically, never armed as a timer)', () => {
      // a very long "wait" timeout is a legitimate ask — it is compared, not passed to setTimeout
      const budget = asMutexTimeBudget({
        lease: null,
        acquire: { timeout: { milliseconds: MSE_TIMER_MAX + 1 } },
      });
      expect(budget.timeoutMse).toEqual(MSE_TIMER_MAX + 1);
    });
  });
});
