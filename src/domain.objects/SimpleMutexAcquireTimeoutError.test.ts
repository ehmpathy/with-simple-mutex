import { ConstraintError } from 'helpful-errors';
import { given, then, when } from 'test-fns';

import { SimpleMutexAcquireTimeoutError } from './SimpleMutexAcquireTimeoutError';

/**
 * .what = unit test for the acquire-timeout error's typed metadata contract
 * .why = the error is a user-faced contract surface (thrown when acquisition exceeds its window);
 *        an isolated unit test pins its metadata schema so a regression in the carried context is
 *        caught here, not only through an integration path.
 */
describe('SimpleMutexAcquireTimeoutError', () => {
  given('[case1] an acquire that exceeds its timeout window', () => {
    when('[t0] the error is constructed with its context', () => {
      then(
        'it carries the { given, used } key and waited-duration metadata',
        () => {
          const error = new SimpleMutexAcquireTimeoutError(
            'could not acquire the mutex lock within the acquire timeout',
            {
              key: { given: 'contended', used: 'mutex.contended' },
              waitedMse: 40,
            },
          );
          expect(error.metadata).toEqual({
            key: { given: 'contended', used: 'mutex.contended' },
            waitedMse: 40,
          });
        },
      );

      then('its name is the mutex-owned type, for a legible catch', () => {
        const error = new SimpleMutexAcquireTimeoutError('timed out', {
          key: { given: 'contended', used: 'mutex.contended' },
          waitedMse: 40,
        });
        expect(error.constructor.name).toEqual(
          'SimpleMutexAcquireTimeoutError',
        );
      });

      then('it is a ConstraintError (caller-domain, exit 2)', () => {
        // every error this library throws is a ConstraintError or a MalfunctionError;
        // an acquire timeout is caller-tunable, so it is the constraint half of that pair.
        const error = new SimpleMutexAcquireTimeoutError('timed out', {
          key: { given: 'contended', used: 'mutex.contended' },
          waitedMse: 40,
        });
        expect(error).toBeInstanceOf(ConstraintError);
        expect(error.code?.exit).toEqual(2);
      });
    });
  });
});
