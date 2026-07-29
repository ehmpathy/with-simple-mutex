import { given, then, when } from 'test-fns';

import { asSafeMutexKey } from './asSafeMutexKey';

describe('asSafeMutexKey', () => {
  given('a key with special characters the on-disk backend rejects', () => {
    const key = 'proxy-phone.+14632270513';

    when('[t0] cast into a safe key', () => {
      const safe = asSafeMutexKey({ key });

      then('it contains only backend-safe characters', () => {
        expect(safe).toMatch(/^[a-zA-Z0-9._-]+$/);
      });

      then('it keeps a readable, sanitized prefix', () => {
        expect(safe).toContain('mutex.proxy-phone.-14632270513');
      });

      then('it appends a hash of the original for collision-safety', () => {
        expect(safe).toMatch(/\.[0-9a-f]{16}$/);
      });
    });
  });

  given('two distinct keys that sanitize to the same readable string', () => {
    // sanitization is lossy: both `+` and `-` map to `-`
    const keyA = 'a+b';
    const keyB = 'a-b';

    when('[t0] both are cast', () => {
      const safeA = asSafeMutexKey({ key: keyA });
      const safeB = asSafeMutexKey({ key: keyB });

      then('they do not collide (distinct hashes)', () => {
        expect(safeA).not.toEqual(safeB);
      });
    });
  });

  given('the same key cast twice', () => {
    const key = 'migration';

    when('[t0] cast repeatedly', () => {
      const first = asSafeMutexKey({ key });
      const second = asSafeMutexKey({ key });

      then('it is deterministic (same input → same safe key)', () => {
        expect(first).toEqual(second);
      });
    });
  });

  given('a very long key', () => {
    const key = 'x'.repeat(500);

    when('[t0] cast into a safe key', () => {
      const safe = asSafeMutexKey({ key });

      then('the readable prefix is length-bounded', () => {
        // 'mutex.' + 64-char prefix + '.' + 16-char hash
        expect(safe.length).toBeLessThanOrEqual('mutex.'.length + 64 + 1 + 16);
      });
    });
  });
});
