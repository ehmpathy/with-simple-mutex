import { ConstraintError } from 'helpful-errors';
import { given, then, when } from 'test-fns';

import { SimpleMutexLeaseExpiredError } from './SimpleMutexLeaseExpiredError';

/**
 * .what = unit test for the lease-expired error's typed metadata contract
 * .why = the error is a user-faced contract surface (thrown when the lease lapses mid-work); an
 *        isolated unit test pins its metadata schema so a regression in the carried context is
 *        caught here, not only through an integration path.
 */
describe('SimpleMutexLeaseExpiredError', () => {
  given(
    '[case1] a lease that lapses while the critical section is active',
    () => {
      when('[t0] the error is constructed with its context', () => {
        then(
          'it carries the { given, used } key and lease-duration metadata',
          () => {
            const error = new SimpleMutexLeaseExpiredError(
              'the mutex lease expired while the critical section was still active',
              {
                key: { given: 'short-lease', used: 'mutex.short-lease' },
                leaseMse: 30,
              },
            );
            expect(error.metadata).toEqual({
              key: { given: 'short-lease', used: 'mutex.short-lease' },
              leaseMse: 30,
            });
          },
        );

        then('its name is the mutex-owned type, for a legible catch', () => {
          const error = new SimpleMutexLeaseExpiredError('lease expired', {
            key: { given: 'short-lease', used: 'mutex.short-lease' },
            leaseMse: 30,
          });
          expect(error.constructor.name).toEqual(
            'SimpleMutexLeaseExpiredError',
          );
        });

        then('it is a ConstraintError (caller-domain, exit 2)', () => {
          // every error this library throws is a ConstraintError or a MalfunctionError;
          // a lapsed lease is caller-tunable, so it is the constraint half of that pair.
          const error = new SimpleMutexLeaseExpiredError('lease expired', {
            key: { given: 'short-lease', used: 'mutex.short-lease' },
            leaseMse: 30,
          });
          expect(error).toBeInstanceOf(ConstraintError);
          expect(error.code?.exit).toEqual(2);
        });
      });
    },
  );
});
