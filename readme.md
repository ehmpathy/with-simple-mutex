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

### run exactly once — skip if another holder already has the key

for the "one cron / one migration / one leader across a fleet" usecase, you often want to **skip** this run rather than wait when someone else already holds the lock. set `acquire.timeout` to `{ milliseconds: 0 }`: the wrapper attempts exactly one acquire and, if the key is held, throws `SimpleMutexAcquireTimeoutError` immediately — no poll wait. catch it and treat it as "someone else is already running; no work to do here."

```ts
import { withSimpleMutex, SimpleMutexAcquireTimeoutError } from 'with-simple-mutex';

const runNightlyRollup = withSimpleMutex(rollup, {
  key: () => 'nightly-rollup',
  cache: createCache({ directory: { cloud: { path: 's3://my-bucket/locks', via: sdkAwsS3 } } }),
  acquire: { timeout: { milliseconds: 0 } }, // try once, then skip if held
});

try {
  await runNightlyRollup({});
} catch (error) {
  if (error instanceof SimpleMutexAcquireTimeoutError) return; // another worker has it — skip
  throw error;
}
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

> **lease bounds**: `lease.duration` (and `acquire.interval`) must fall in `(0, ~24.8 days]` — the range a js timer can honor. a value outside it is rejected up front with a `ConstraintError` that names the fix, rather than a timer that silently misfires. for a critical section longer than ~24.8 days, split the work so each guarded run fits.

# features

### the atomicity requirement

> `withSimpleMutex` requires a cache that satisfies `WithCacheConditionals`. a plain `SimpleCache` will not compile — this is deliberate: a lock without atomic writes is not a lock.

the mutex builds on the cache's conditional write. the condition is a single field — the version precondition — and a precondition miss throws a typed `SimpleCacheConditionError`, which the mutex catches and treats as expected control flow (a lost race):

```ts
cache.set(key, value, {
  condition: {
    version: string | null, // null = write only if absent; '<token>' = write only if unchanged
  },
});
// on a precondition miss, set/get throw SimpleCacheConditionError
```

### the lock lifecycle (v1)

each step maps to one conditional write, so the mutex trusts the cache, not the clock:

- **acquire** → `set(key, lock, { expiration: lease, condition: { version: null } })` (put-if-absent). the lock is written with the lease as the cache's **native expiration**, so a crashed or stalled holder's key auto-evicts once the lease lapses; the next `acquire` then wins the now-absent key with the same put-if-absent. staleness needs no manual steal — the cache reclaims the key for us.
- **hold** → the critical section runs raced against a **local lease-deadline timer** (no cache reads). if the section outruns the lease, the wrapper **fails fast** with `SimpleMutexLeaseExpiredError` rather than let unprotected work run on.
- **release** → conditional delete on our version — remove the key only if it is still ours (a version mismatch — a rival already reclaimed it — is a safe no-op).

> **deferred to v2** — v1 has **no heartbeat/renew** (the lease is a single, up-front budget: size it above your critical section's worst case) and **no manual compare-and-set steal** (native cache expiration handles staleness instead). a renew-to-extend heartbeat and an explicit read-confirm-CAS steal are planned for a later version; v1 deliberately keeps the surface small.

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
| `acquire.timeout`  | no       | — (wait forever)  | max wait to acquire before `SimpleMutexAcquireTimeoutError`; unset waits until the key frees |
| `acquire.interval` | no       | `{ seconds: 1 }`  | poll interval between acquire attempts                                  |

errors:

every error the wrapper throws is one of two [`helpful-errors`](https://github.com/ehmpathy/helpful-errors) families — a `ConstraintError` (caller-domain, exit 2) or a `MalfunctionError` (system fault, exit 1) — surfaced, never swallowed, so a fault is always loud. the one exception: whatever **your own `logic` throws** propagates unchanged when the release path is clean (the lock is still released first).

`ConstraintError` (caller-domain — the remedy is yours to apply):

- `SimpleMutexAcquireTimeoutError` (a `ConstraintError`) — could not acquire the lock within `acquire.timeout`. raise `acquire.timeout`, lower contention on the key, or catch it as a deliberate skip (the run-once idiom).
- `SimpleMutexLeaseExpiredError` (a `ConstraintError`) — the lease lapsed while the critical section was still active (the holder stalled past `lease` and a rival could have entered). `withSimpleMutex` **fails fast**: it stops the await on your logic and throws, rather than let unprotected work continue to completion. raise `lease.duration` above the section's worst case, or shorten the section.
- a bare `ConstraintError` — a `lease.duration` or `acquire.interval` outside the js-timer range `(0, ~24.8 days]`, caught up front.

`MalfunctionError` (system fault — investigate the backend or environment):

- the cache backend faulted (on acquire, on release, or both); the message names where. on a release fault after your logic already succeeded, the fault states the work succeeded and a retry only re-clears the lock.
- the lease lapsed in the instant between the won key and its version read (the lease is too short for the environment); raise `lease.duration`. a just-written lease that vanishes at once is a near-impossible anomaly, so it surfaces as a `MalfunctionError` for a deliberate look, not a routine nudge.

# notes

- **it's a lease lock**: if a holder stalls past `lease`, another holder legitimately steals the key. the stalled holder does not run on unprotected — it **fails fast** with `SimpleMutexLeaseExpiredError` the moment it detects the lease is lost. use a `lease` comfortably above your critical section's worst case so this stays the exception, not the rule.
- **atomic on acquire**: with conditional writes there is exactly one winner, unlike a settle-then-verify approach — this is the upgrade over naive check-then-set.
- **not a fenced lock**: it does not hand out monotonic fencing tokens, so it does not defend a downstream store against a stalled-then-resumed holder. it makes contention safe and rare, not "impossible under arbitrary pauses."
- **not reentrant**: the lock is keyed, not owner-aware. a call that re-enters the same key from inside its own held critical section does not recognize itself — it waits like any other rival, so it polls until `acquire.timeout` (or, with the default no-timeout, waits until the outer holder releases — which, from inside itself, is never). do not take the same key twice in one call stack; give nested work a distinct key, or restructure so the section runs once.
- **lease bounds**: `lease.duration` and `acquire.interval` must be within `(0, ~24.8 days]` (the js-timer range). an out-of-range value fails fast with a `ConstraintError` that states the fix, so a misconfigured lease can never silently misfire and free the lock mid-work.
- **your key appears verbatim in error logs**: the key your `key` getter returns is carried, unchanged, in the metadata of every thrown error (`SimpleMutexAcquireTimeoutError`, `SimpleMutexLeaseExpiredError`, and the wrapped fault) — this is deliberate, so you can grep your logs for the exact key you passed. the trade-off: if your key embeds sensitive data (e.g. the flagship `proxy-phone.+14632270513` embeds a phone number), that value lands in your error logs. if that is a concern, hash or redact the sensitive part in your `key` getter before it reaches the lock.
- **reuse one cache instance**: the lock's isolation scope is entirely a property of the cache instance you pass. construct the cache **once** (at module scope, as every example above does) and reuse the returned guarded function across every call you want serialized. a fresh cache per call — e.g. `createCache()` inside a request handler — silently disables the lock: each call gets its own empty store, so every acquire wins at once. this is the inverse of the "swap the cache to widen scope" pitch — the same instance is one shared lock; a new instance per call is no lock at all. the isolation table above assumes a single shared instance per tier.
- **the cache is shared; lock keys are prefixed**: lock entries are written under a `mutex.<...>` key prefix inside whatever cache you supply. if you reuse that same cache instance for unrelated application data, keep your own keys clear of the `mutex.` prefix so an app entry cannot collide with a lock entry.
- **no acquire-wait signal (v1)**: with `acquire.timeout` unset (the default — wait forever), a caller queued behind a long-held lock emits no log line or hook until it acquires or the process looks hung. v1's `(logic, options)` signature carries no logger by design. if you need wait visibility, set a finite `acquire.timeout` and catch the `SimpleMutexAcquireTimeoutError`, or add your own log around the guarded call.
- **`acquire.timeout` bounds the contention wait, not a hung backend call**: the timeout caps how long you wait *across poll attempts* for a held key to free. it does **not** bound a single cache operation that never settles (e.g. a hung socket whose backend has no timeout of its own): each put-if-absent and version read is awaited directly, and the deadline is re-checked *between* polls, not mid-call. so a caller that leans on `acquire.timeout` as a hard cap can still hang on a stuck backend. if your backend can hang without its own timeout, put a client-side timeout on the cache — the mutex bounds contention, not backend liveness. (a race of each backend call against the residual budget is a planned v2 improvement.)

# see also

- [with-simple-cache](https://github.com/ehmpathy/with-simple-cache) — the `WithCacheConditionals` contract
- [simple-on-disk-cache](https://github.com/ehmpathy/simple-on-disk-cache) — local disk (per-machine) + cloud disk (global) backends
- [sdk-aws-s3](https://github.com/ehmpathy/sdk-aws-s3) — the s3 cloud-disk driver for global locks
