import { given, then, when } from 'test-fns';

import { getOneMutexPollWaitMse } from './getOneMutexPollWaitMse';

/**
 * .what = unit test for the pure poll-wait derivation extracted from the acquire loop
 * .why = the exact-timeout clamp was a real bug once (the loop gave up a full interval PAST the
 *        deadline). here it gets a direct, deterministic assertion — jitterFactor is an input, so
 *        every case is exact — instead of only the wall-clock integration threshold in
 *        genMutexLock.integration.test.ts case4.
 */
describe('getOneMutexPollWaitMse', () => {
  given('[case1] no acquire timeout (null) — an unbounded wait', () => {
    when('[t0] the wait is derived with a full jitter factor', () => {
      then('it returns the fully-jittered interval, unclamped', () => {
        const waitMse = getOneMutexPollWaitMse({
          intervalMse: 1000,
          timeoutMse: null,
          waitedMse: 0,
          jitterFactor: 1,
        });
        expect(waitMse).toEqual(1000);
      });
    });

    when('[t1] the wait is derived with a half jitter factor', () => {
      then('it returns exactly half the interval', () => {
        const waitMse = getOneMutexPollWaitMse({
          intervalMse: 1000,
          timeoutMse: null,
          waitedMse: 0,
          jitterFactor: 0.5,
        });
        expect(waitMse).toEqual(500);
      });
    });
  });

  given('[case2] a timeout with ample budget left', () => {
    when('[t0] the jittered interval fits inside the budget left', () => {
      then('it returns the jittered interval (no clamp needed)', () => {
        const waitMse = getOneMutexPollWaitMse({
          intervalMse: 1000,
          timeoutMse: 5000,
          waitedMse: 1000,
          jitterFactor: 1,
        });
        expect(waitMse).toEqual(1000);
      });
    });
  });

  given('[case3] a timeout with less budget left than one interval', () => {
    when('[t0] the jittered interval would overrun the deadline', () => {
      then(
        'it clamps to the exact time left — gives up AT the deadline',
        () => {
          // waited 4800 of a 5000ms budget; only 200ms are left, but the interval is 1000ms
          const waitMse = getOneMutexPollWaitMse({
            intervalMse: 1000,
            timeoutMse: 5000,
            waitedMse: 4800,
            jitterFactor: 1,
          });
          expect(waitMse).toEqual(200);
        },
      );
    });
  });

  given('[case4] the budget is exactly spent', () => {
    when('[t0] no time is left in the acquire window', () => {
      then('it returns zero — no further wait', () => {
        const waitMse = getOneMutexPollWaitMse({
          intervalMse: 1000,
          timeoutMse: 5000,
          waitedMse: 5000,
          jitterFactor: 1,
        });
        expect(waitMse).toEqual(0);
      });
    });
  });
});
