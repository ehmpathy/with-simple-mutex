# with-simple-mutex

![ci_on_commit](https://github.com/ehmpathy/with-simple-mutex/workflows/ci_on_commit/badge.svg)
![deploy_on_tag](https://github.com/ehmpathy/with-simple-mutex/workflows/deploy_on_tag/badge.svg)

a simple distributed mutex over any conditional-write cache — choose your isolation tier by choice of cache.

# .what

`withSimpleMutex` holds a mutually exclusive lock over a key, so only one operation per key can be inflight at a time. callers that share a key wait their turn.

locks can be acquired against any simple cache that supports `WithCacheConditionals` (from [with-simple-cache](https://github.com/ehmpathy/with-simple-cache)), so the lock inherits its isolation scope from the cache you supply:

- in-memory → per-process
- on-disk local → per-machine
- on-disk cloud (e.g. s3) → global / cross-machine

# .why mutex locks

use a mutex when concurrent operations must not overlap:

- **prevent races** — serialize access to a shared resource that has no lock of its own.
- **run exactly once** — de-duplicate work across a fleet (one cron, one migration, one leader).
- **guard side effects** — enforce one holder where a db transaction can't reach (one email, one charge).

# .why with-simple-mutex

- **correct by construction** — atomic conditional write picks exactly one winner; no timing guesses.
- **pick your scope** — process, machine, or global, by the cache you supply.
- **one-line locks** — wrap a function; the key derives from its input.

# install

```sh
npm install --save with-simple-mutex
```

# quick start

`withSimpleMutex` wraps your logic and returns a lock-guarded version of it. the isolation scope is inherited from the cache — so the only piece that changes across tiers is the cache you pass in.

### per-process lock (in-memory cache)

to serialize access within a single process, use an in-memory cache

```ts
import { createCache } from 'simple-in-memory-cache';
import { withSimpleMutex } from 'with-simple-mutex';

const genProxyPhone = withSimpleMutex(
  async (input: { phone: string }) => {
    /* ... critical section — only one holder runs this per key ... */
    return doTheWork(input);
  },
  {
    key: (input) => `proxy-phone.${input.phone}`,
    cache: createCache(),
  },
);

const result = await genProxyPhone({ phone: '+14632270513' });
```

### per-machine lock (on-disk local cache)

to serialize access across processes on one machine, use an on-disk cache backed by a local disk

```ts
import { createCache } from 'simple-on-disk-cache';
import { withSimpleMutex } from 'with-simple-mutex';

const genProxyPhone = withSimpleMutex(
  async (input: { phone: string }) => {
    /* ... critical section ... */
    return doTheWork(input);
  },
  {
    key: (input) => `proxy-phone.${input.phone}`,
    cache: createCache({ directory: { local: { path: '/tmp/locks' } } }),
  },
);
```

### global lock (on-disk cloud cache, e.g. s3)

to serialize access across machines, use an on-disk cache backed by a cloud disk

```ts
import { createCache } from 'simple-on-disk-cache';
import { sdkAwsS3 } from 'sdk-aws-s3';
import { withSimpleMutex } from 'with-simple-mutex';

const genProxyPhone = withSimpleMutex(
  async (input: { phone: string }) => {
    /* ... critical section ... */
    return doTheWork(input);
  },
  {
    key: (input) => `proxy-phone.${input.phone}`,
    cache: createCache({
      directory: { cloud: { path: 's3://my-bucket/locks', via: sdkAwsS3 } },
    }),
  },
);
```

*note: the call is identical across all three tiers — swap the cache → swap the isolation scope*

| cache                                  | isolation scope        |
| -------------------------------------- | ---------------------- |
| simple-in-memory-cache                 | per-process            |
| simple-on-disk-cache (local disk)      | per-machine            |
| simple-on-disk-cache (cloud disk, s3)  | global / cross-machine |

# examples

### use a dynamic lock key from input

the `key` getter receives the same input as your logic, so the lock scope is a function of the input. two calls with the same key serialize; different keys run in parallel.

```ts
import { withSimpleMutex } from 'with-simple-mutex';

const genProxyPhone = withSimpleMutex(getProxyPhone, {
  key: (input) => `proxy-phone.${input.phone}`, // per-phone lock
  cache: createCache(),
});
```

### use a single global lock

return a constant from the `key` getter to serialize every call through one lock.

```ts
import { withSimpleMutex } from 'with-simple-mutex';

const runMigration = withSimpleMutex(migrate, {
  key: () => 'migration', // one lock for all callers
  cache: createCache({ directory: { cloud: { path: 's3://my-bucket/locks', via: sdkAwsS3 } } }),
});
```

### bound how long you wait to acquire

by default a caller waits for the lock. set `acquire.timeout` to give up after a bound and throw `SimpleMutexAcquireTimeoutError` instead.

```ts
import { withSimpleMutex } from 'with-simple-mutex';

const genProxyPhone = withSimpleMutex(getProxyPhone, {
  key: (input) => `proxy-phone.${input.phone}`,
  cache: createCache(),
  acquire: { timeout: { seconds: 30 }, interval: { seconds: 1 } },
});
```

### set the lease lifetime

the lease is how long you hold the lock. set `lease.duration` above your critical section's worst-case runtime so a rival does not steal the key mid-work.

```ts
import { withSimpleMutex } from 'with-simple-mutex';

const genProxyPhone = withSimpleMutex(getProxyPhone, {
  key: (input) => `proxy-phone.${input.phone}`,
  cache: createCache(),
  lease: { duration: { minutes: 30 } }, // default { minutes: 30 }
});
```

# features

### the atomicity requirement

> `withSimpleMutex` requires a cache that satisfies `WithCacheConditionals`. a plain `SimpleCache` will not compile — this is deliberate: a lock without atomic writes is not a lock.

the mutex builds on the cache's conditional write:

```ts
cache.set(key, value, {
  condition: {
    version: string | null,        // null = write only if absent; '<etag>' = write only if unchanged
    exception: 'throw' | 'ignore', // on a precondition miss: throw a typed error, or no-op
  },
});
```

### the lock lifecycle

each step maps to one conditional write, so the mutex trusts the cache, not the clock:

- **acquire** → `set(key, lock, { condition: { version: null, exception: 'ignore' } })` (put-if-absent). to steal an expired lease, read the current `{ value, version }`, confirm it's stale, then `set(..., { condition: { version, exception: 'ignore' } })` (compare-and-set) so a rival can't be clobbered.
- **renew** (heartbeat) → `set(key, lock, { condition: { version: mine, exception: 'ignore' } })` — extend expiry only if still ours. if the renew finds the key is no longer ours, we have lost the lock: **fail fast** and abort the critical section.
- **release** → conditional delete on our version — remove only if still ours.

# api

`withSimpleMutex` wraps your logic and returns a lock-guarded version of it.

```ts
withSimpleMutex<TInput, TOutput>(
  logic: (input: TInput) => Promise<TOutput>,
  options: {
    key: (input: TInput) => string;
    cache: WithCacheConditionals<SimpleCache<string>>;
    lease?: { duration?: IsoDuration };               // how long you hold the lock; default { minutes: 30 }
    acquire?: { timeout?: IsoDuration; interval?: IsoDuration };
  },
): (input: TInput) => Promise<TOutput>
```

`IsoDuration` is the duration shape from [iso-time](https://github.com/ehmpathy/iso-time) (e.g. `{ minutes: 5 }`).

| field              | required | default           | description                                                             |
| ------------------ | -------- | ----------------- | ----------------------------------------------------------------------- |
| `key`              | yes      | —                 | getter for the lock key from input; same input → same lock → serialized |
| `cache`            | yes      | —                 | any `WithCacheConditionals<SimpleCache<string>>`                        |
| `lease.duration`   | no       | `{ minutes: 30 }` | how long you hold the lock; a rival may steal the key once it expires   |
| `acquire.timeout`  | no       | —                 | max wait to acquire before `SimpleMutexAcquireTimeoutError`             |
| `acquire.interval` | no       | —                 | poll interval between acquire attempts                                  |

errors:

- `SimpleMutexAcquireTimeoutError` — could not acquire the lock within `acquire.timeout`.
- `SimpleMutexLeaseExpiredError` — the lease lapsed while the critical section was still active (the holder stalled past `lease` and a rival could have entered). `withSimpleMutex` **fails fast**: it stops the await on your logic and throws, rather than let unprotected work continue to completion.

# notes

- **it's a lease lock**: if a holder stalls past `lease`, another holder legitimately steals the key. the stalled holder does not run on unprotected — it **fails fast** with `SimpleMutexLeaseExpiredError` the moment it detects the lease is lost. use a `lease` comfortably above your critical section's worst case so this stays the exception, not the rule.
- **atomic on acquire**: with conditional writes there is exactly one winner, unlike a settle-then-verify approach — this is the upgrade over naive check-then-set.
- **not a fenced lock**: it does not hand out monotonic fencing tokens, so it does not defend a downstream store against a stalled-then-resumed holder. it makes contention safe and rare, not "impossible under arbitrary pauses."

# see also

- [with-simple-cache](https://github.com/ehmpathy/with-simple-cache) — the `WithCacheConditionals` contract
- [simple-on-disk-cache](https://github.com/ehmpathy/simple-on-disk-cache) — local disk (per-machine) + cloud disk (global) backends
- [sdk-aws-s3](https://github.com/ehmpathy/sdk-aws-s3) — the s3 cloud-disk driver for global locks
