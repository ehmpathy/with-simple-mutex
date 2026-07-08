# with-simple-mutex

![ci_on_commit](https://github.com/ehmpathy/with-simple-mutex/workflows/ci_on_commit/badge.svg)
![deploy_on_tag](https://github.com/ehmpathy/with-simple-mutex/workflows/deploy_on_tag/badge.svg)

a simple distributed mutex over any conditional-write cache — choose your isolation tier (process / machine / global) by choice of cache.

# .what

`withSimpleMutex` runs a critical section while a lock over a key is held, so concurrent holders serialize. it takes any cache that advertises `WithCacheConditionals` (from [with-simple-cache](https://github.com/ehmpathy/with-simple-cache)), so the isolation scope is inherited from the cache backend — in-memory = per-process, on-disk local = per-machine, on-disk cloud (e.g. s3) = global / cross-machine.

# .why

- serialize access to a shared resource across processes/machines (the driver case: stop two integration test suites from a shared-external-account collision).
- correctness comes from the cache's atomic conditional write — no settle-then-verify hack, no assumptions about time.
- one primitive, three isolation tiers, chosen by the caller.

# install

```sh
npm install with-simple-mutex
```

# quickstart — same call, three tiers

the only thing that changes is the cache.

```ts
import { withSimpleMutex } from 'with-simple-mutex';
import { createCache } from 'simple-on-disk-cache';
import { sdkAwsS3 } from 'sdk-aws-s3';

// global (cross-machine) — s3-backed
const cache = createCache({
  directory: { cloud: { path: 's3://my-bucket/locks', via: sdkAwsS3 } },
});

// wrap the critical section; `key` is derived from the input, so each
// distinct input gets its own lock
const genProxyPhone = withSimpleMutex(
  async (input: { phone: string }) => {
    // critical section — only one holder runs this per key at a time
    return doTheWork(input);
  },
  {
    key: (input) => `proxy-phone.${input.phone}`, // dynamic key from input
    cache,
    lease: { duration: { minutes: 30 } },
  },
);

// two calls with the same phone serialize; different phones run in parallel
const result = await genProxyPhone({ phone: '+14632270513' });
```

the `key` getter is the whole point of dynamic locks: return a constant for a single global lock, or derive from the input to scope the lock per-resource.

swap the cache → swap the isolation tier:

| cache                                  | isolation scope        |
| -------------------------------------- | ---------------------- |
| simple-in-memory-cache                 | per-process            |
| simple-on-disk-cache (local disk)      | per-machine            |
| simple-on-disk-cache (cloud disk, s3)  | global / cross-machine |

# the atomicity requirement

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

# .how — the lifecycle, mapped to conditional writes

- **acquire** → `set(key, lock, { condition: { version: null, exception: 'ignore' } })` (put-if-absent). to steal an expired lease, read the current `{ value, version }`, confirm it's stale, then `set(..., { condition: { version, exception: 'ignore' } })` (compare-and-set) so a rival can't be clobbered.
- **renew** (heartbeat) → `set(key, lock, { condition: { version: mine, exception: 'ignore' } })` — extend expiry only if still ours. if the renew finds the key is no longer ours (a rival stole the expired lease), we have lost the lock: **fail fast** and abort the critical section.
- **release** → conditional delete on our version — remove only if still ours.

# api

`withSimpleMutex` wraps your logic and returns a lock-guarded version of it. the `key` getter receives the same input as the logic, so the lock scope is a function of the input.

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

| field              | required | default          | description                                                        |
| ------------------ | -------- | ---------------- | ------------------------------------------------------------------ |
| `key`              | yes      | —                | getter for the lock key from input; same input → same lock → serialized |
| `cache`            | yes      | —                | any `WithCacheConditionals<SimpleCache<string>>`                   |
| `lease.duration`   | no       | `{ minutes: 30 }` | how long you hold the lock; a rival may steal the key once it expires |
| `acquire.timeout`  | no       | —                | max wait to acquire before `SimpleMutexAcquireTimeoutError`         |
| `acquire.interval` | no       | —                | poll interval between acquire attempts                             |

errors:

- `SimpleMutexAcquireTimeoutError` — could not acquire the lock within `acquire.timeout`.
- `SimpleMutexLeaseExpiredError` — the lease lapsed while the critical section was still active (the holder stalled past `lease` and a rival could have entered). `withSimpleMutex` **fails fast**: it stops the await on your logic and throws, rather than let unprotected work continue to completion.

# .note

- **it's a lease lock**: if a holder stalls past `lease`, another holder legitimately steals the key. the stalled holder does not run on unprotected — it **fails fast** with `SimpleMutexLeaseExpiredError` the moment it detects the lease is lost. use a `lease` comfortably above your critical section's worst case so this stays the exception, not the rule.
- **atomic on acquire**: with conditional writes there is exactly one winner, unlike a settle-then-verify approach — this is the upgrade over naive check-then-set.
- **not a fenced lock**: it does not hand out monotonic fencing tokens, so it does not defend a downstream store against a stalled-then-resumed holder. it makes contention safe and rare, not "impossible under arbitrary pauses."

# see also

- [with-simple-cache](https://github.com/ehmpathy/with-simple-cache) — the `WithCacheConditionals` contract
- [simple-on-disk-cache](https://github.com/ehmpathy/simple-on-disk-cache) — local disk (per-machine) + cloud disk (global) backends
- [sdk-aws-s3](https://github.com/ehmpathy/sdk-aws-s3) — the s3 cloud-disk driver for global locks
