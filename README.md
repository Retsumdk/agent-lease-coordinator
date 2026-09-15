# agent-lease-coordinator

Lease-based coordination library for reserving shared tools and preventing conflicting agent operations

## The Problem

When several agents share a tool, a browser session, a GPU slot, or an API quota, nothing in the
runtime stops two of them from using it at the same time. Ad-hoc locks do not survive a crashed
agent, do not expire, and do not tell a blocked agent *why* it is blocked — so fleets end up with
corrupted shared state, silent partial writes, and agents that deadlock waiting on each other.

`agent-lease-coordinator` is a deterministic, dependency-light TypeScript library that turns shared
resources into **leases**: time-bounded, explicitly released grants that a fleet can inspect,
enforce, and recover from.

## What it gives you

- **Exclusive or shared resources.** Register a resource as `exclusive` (one holder at a time) or
  `shared` (up to `capacity` concurrent holders). A request for the wrong mode is denied with a
  reason instead of silently succeeding.
- **TTL-based expiry.** Every lease carries `ttlMs`. Expired holders are swept before any new
  decision, so a crashed agent can never hold a resource forever.
- **FIFO wait queues.** Blocked requests are queued with a `ticketId` and promoted in arrival order
  the moment a holder releases or expires. Queue depth is bounded by `maxQueue`.
- **Explicit lifecycle.** `renew`, `release`, `cancel`, `sweep`, `history`, and `stats` are all
  observable, so a supervisor agent can report on contention and recovery.
- **Guard helpers.** `heldBy()` and `assertHeld()` let critical sections refuse work unless the
  calling agent actually holds the lease.
- **Deterministic by design.** The clock is injected (`ManualClock` in tests, `systemClock` in
  production), so coordination behavior is reproducible in test suites.

## How it works

```
acquire(agentId, resource, ttlMs)
        │
        ├─ sweep expired leases ──────────► revoke + promote queue
        │
        ├─ grantable? ──── yes ───────────► LeaseRecord (active, expiresAt = now + ttlMs)
        │
        ├─ queue === false ───────────────► denied  (reason: who holds it)
        │
        └─ queue has room ────────────────► queued  (ticketId, position)

release / expire ──► revoke lease ──► promote head of FIFO queue ──► LeaseRecord
```

State transitions are confined to `active → released` and `active → expired`. Nothing is reused:
a new grant always produces a new `lease-N` id and appends to `history()`.

## Install

```bash
git clone https://github.com/Retsumdk/agent-lease-coordinator.git
cd agent-lease-coordinator
bun install
```

## Usage

```ts
import { LeaseCoordinator, ManualClock, LeaseError } from "agent-lease-coordinator";

const clock = new ManualClock();
const coordinator = new LeaseCoordinator(clock);

coordinator.register({ name: "browser", mode: "exclusive", maxQueue: 5 });
coordinator.register({ name: "model-api", mode: "shared", capacity: 3 });

const scout = coordinator.acquire({ agentId: "scout", resource: "browser", ttlMs: 5_000 });
coordinator.acquire({ agentId: "scribe", resource: "browser", ttlMs: 5_000 });
// { status: "queued", position: 1, reason: "browser held by scout@lease-1" }

coordinator.release(scout.lease!.id, "page captured");
// scribe is promoted immediately and now holds the browser

clock.advance(60_000);
coordinator.sweep(); // expires anything that overran its ttl

try {
  coordinator.assertHeld("browser", "analyst"); // analyst does not hold the lease
} catch (error) {
  if (error instanceof LeaseError) console.error(error.code, error.message);
  // NOT_LEASE_HOLDER agent "analyst" does not hold a lease on "browser"
}
```

Run the bundled multi-agent demo:

```bash
bun start          # demo: exclusive contention, shared capacity, queue overflow, sweep
bun test           # 22 tests / 59 assertions
bun run build      # type-check and emit dist/
```

## Example output

`bun start` prints the full lifecycle, including queue promotion and expiry recovery:

```text
exclusive acquire    -> granted (lease-1)
contended acquire    -> queued position=1 (browser held by scout@lease-1)
second in line       -> queued position=2, cancelled=true
mode mismatch        -> denied (resource "model-api" only grants shared leases)
shared capacity 3    -> granted, granted, granted
shared overflow      -> queued position=1
queue limit 1        -> queued, overflow denied (queue full for "index-writer" (index-writer held by scout@lease-5))
sweep after 2.1s     -> expired lease-1:scout, lease-2:scout, lease-3:scribe, lease-4:analyst
browser holders now  -> scribe
model-api holders    -> ranger
browser            mode=exclusive capacity=1  holders=scribe(lease-6)  queued=none
model-api          mode=shared    capacity=3  holders=ranger(lease-7)  queued=none
index-writer       mode=exclusive capacity=1  holders=scout(lease-5)  queued=scribe@ticket-4

resources=3  active=3  queued=1  acquired=7  released=0  expired=4  denied=2  cancelled=1
```

## API

### `coordinator.register(definition)`

```ts
coordinator.register({ name: "gpu", mode: "exclusive", capacity: 1, maxQueue: 10, description: "…" });
```

Registers a resource. Defaults are `mode: "exclusive"`, `capacity: 1`, `maxQueue: 100`.
An `exclusive` resource must have capacity `1`.

### `coordinator.acquire(request)`

```ts
const outcome = coordinator.acquire({ agentId: "a", resource: "gpu", ttlMs: 10_000, queue: true });
```

Returns an `AcquireOutcome`:

| Field | Meaning |
| --- | --- |
| `status` | `"granted"`, `"queued"`, or `"denied"` |
| `lease` | the `LeaseRecord` when granted |
| `ticket` / `position` | queue ticket and 1-based position when queued |
| `reason` | human-readable cause for a queue or denial |

Passing `queue: false` makes an unavailable resource fail fast instead of queueing.

### `coordinator.renew(leaseId, ttlMs?)`

Extends `expiresAt` from the current clock time and increments `renewals`. Renewing an expired or
unknown lease throws.

### `coordinator.release(leaseId, reason?)`

Revokes an active lease, records the reason, and promotes the next queued request. Releasing an
already-released lease is idempotent and returns the existing record; releasing an expired lease
throws `LEASE_EXPIRED`.

### Inspection and control

| Method | Purpose |
| --- | --- |
| `sweep()` | expire overdue leases, promote queues, return what expired |
| `cancel(ticketId)` | drop a queued request (`true` if it existed) |
| `heldBy(agentId, resource)` | the agent's active lease, if any |
| `assertHeld(resource, agentId)` | throws unless the agent holds the lease |
| `withLease(request, fn)` | acquire without queueing, run `fn`, always release |
| `activeLeases(resource?)` / `queuedRequests(resource?)` | current holders and waiters |
| `snapshot(resource)` / `snapshots()` | full per-resource state |
| `history()` | every lease the coordinator has issued, with final status |
| `stats()` | `resources`, `activeLeases`, `queuedRequests`, and lifetime counters |

### Error codes

`LeaseError` carries a `code`: `DUPLICATE_RESOURCE`, `UNKNOWN_RESOURCE`, `INVALID_CAPACITY`,
`INVALID_TTL`, `LEASE_NOT_FOUND`, `LEASE_EXPIRED`, `LEASE_UNAVAILABLE`, `NOT_LEASE_HOLDER`,
`QUEUE_LIMIT`.

## Development

```bash
bun install
bun test
bun run build
```

## License

MIT — see [LICENSE](LICENSE).
