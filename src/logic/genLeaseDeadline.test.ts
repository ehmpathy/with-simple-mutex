import { sleep } from 'iso-time';
import { given, then, useThen, when } from 'test-fns';

import { SimpleMutexLeaseExpiredError } from '../domain.objects/SimpleMutexLeaseExpiredError';
import { genLeaseDeadline } from './genLeaseDeadline';

/**
 * .what = unit coverage for the pure lease-deadline resource
 * .why = genLeaseDeadline is the fail-fast half of the v1 lease (no heartbeat); prove the
 *        deadline rejects with the mutex-owned error after the lease elapses, that its cancel
 *        stops the timer, and that the rejection carries the diagnostic metadata schema.
 */
describe('genLeaseDeadline', () => {
  given('[case1] a short lease deadline', () => {
    when('[t0] the lease elapses before cancel', () => {
      const outcome = useThen('the deadline rejects', async () => {
        const lease = genLeaseDeadline({
          key: { given: 'short', used: 'mutex.short.hash' },
          leaseMse: 20,
        });

        // await the rejection, then read the owned shape inside the callback so the
        // assertions below compare plain values (useThen returns a deferred proxy, so
        // instanceof must be resolved here, not on the proxy)
        const error = await lease.deadline.catch(
          (deadlineError: unknown) => deadlineError,
        );

        // fail loud on the wrong error, which also narrows the type for the reads below
        if (!(error instanceof SimpleMutexLeaseExpiredError))
          throw (
            error ??
            new Error(
              'expected the deadline to reject with SimpleMutexLeaseExpiredError, but it did not',
            )
          );

        return {
          name: error.constructor.name,
          message: error.message,
          metadata: error.metadata,
        };
      });

      then('it rejects with the mutex-owned lease-expired error', () => {
        expect(outcome.name).toEqual('SimpleMutexLeaseExpiredError');
      });

      then(
        'its message names the fix (rule.require.errors-name-the-fix)',
        () => {
          // the error must not just report the symptom — it must tell the caller what to do:
          // raise lease.duration or shorten the section so the lease outlasts the work
          expect(outcome.message).toContain('lease.duration');
          expect(outcome.message).toContain('shorten the section');
        },
      );

      then(
        'the error carries the whole { given, used } key + leaseMse metadata',
        () => {
          // proves the caller's own key (key.given) is present so they can grep logs for it,
          // alongside the sanitized backend form (key.used)
          expect(outcome.metadata).toEqual({
            key: { given: 'short', used: 'mutex.short.hash' },
            leaseMse: 20,
          });
        },
      );
    });
  });

  given('[case2] a lease deadline that gets cancelled', () => {
    when('[t0] cancel fires before the lease elapses', () => {
      const outcome = useThen('the deadline never rejects', async () => {
        const lease = genLeaseDeadline({
          key: { given: 'cancelled', used: 'mutex.cancelled.hash' },
          leaseMse: 20,
        });
        lease.cancel();

        // if cancel cleared the timer, the deadline never settles, so a marker sleep
        // that outlasts the original lease wins the race intact
        const marker = await Promise.race([
          lease.deadline,
          sleep({ milliseconds: 60 }).then(() => 'survived' as const),
        ]);
        return { marker };
      });

      then('the marker wins because the deadline was cancelled', () => {
        expect(outcome.marker).toEqual('survived');
      });
    });
  });
});
