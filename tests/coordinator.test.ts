import { describe, expect, test } from "bun:test";
import { LeaseError, ManualClock } from "../src/clock";
import { LeaseCoordinator } from "../src/coordinator";

function makeCoordinator(start = 1_000) {
  const clock = new ManualClock(start);
  const coordinator = new LeaseCoordinator(clock);
  coordinator.register({ name: "tool", mode: "exclusive", maxQueue: 5 });
  coordinator.register({ name: "model-api", mode: "shared", capacity: 3, maxQueue: 5 });
  return { coordinator, clock };
}

describe("ManualClock", () => {
  test("advances and reports the current time", () => {
    const clock = new ManualClock(100);
    clock.advance(50);
    expect(clock.now()).toBe(150);
    clock.set(9);
    expect(clock.now()).toBe(9);
  });

  test("rejects non-finite and negative values", () => {
    expect(() => new ManualClock(Number.NaN)).toThrow(LeaseError);
    expect(() => new ManualClock(0).advance(-1)).toThrow(/non-negative/);
  });
});

describe("resource registration", () => {
  test("rejects duplicates", () => {
    const { coordinator } = makeCoordinator();
    expect(() => coordinator.register({ name: "tool" })).toThrow(/already registered/);
  });

  test("rejects an exclusive resource with capacity above one", () => {
    const coordinator = new LeaseCoordinator(new ManualClock());
    expect(() => coordinator.register({ name: "lock", mode: "exclusive", capacity: 2 })).toThrow(
      /exclusive/,
    );
  });

  test("rejects a negative queue limit and reports unknown resources", () => {
    const coordinator = new LeaseCoordinator(new ManualClock());
    expect(() => coordinator.register({ name: "x", maxQueue: -1 })).toThrow(/maxQueue/);
    expect(() => coordinator.acquire({ agentId: "a", resource: "ghost" })).toThrow(/unknown resource/);
  });
});

describe("exclusive leases", () => {
  test("grants one lease and queues the next requester", () => {
    const { coordinator } = makeCoordinator();
    const first = coordinator.acquire({ agentId: "a", resource: "tool", ttlMs: 100 });
    expect(first.status).toBe("granted");
    expect(first.lease?.expiresAt).toBe(1_100);

    const second = coordinator.acquire({ agentId: "b", resource: "tool", ttlMs: 100 });
    expect(second.status).toBe("queued");
    expect(second.position).toBe(1);
    expect(second.reason).toContain("held by a@");
  });

  test("denies without queueing when queue is disabled", () => {
    const { coordinator } = makeCoordinator();
    coordinator.acquire({ agentId: "a", resource: "tool" });
    const denied = coordinator.acquire({ agentId: "b", resource: "tool", queue: false });
    expect(denied.status).toBe("denied");
    expect(coordinator.queuedRequests()).toHaveLength(0);
  });

  test("denies an incompatible mode without queueing", () => {
    const { coordinator } = makeCoordinator();
    const outcome = coordinator.acquire({ agentId: "a", resource: "model-api", mode: "exclusive" });
    expect(outcome.status).toBe("denied");
    expect(outcome.reason).toContain("only grants shared leases");
    expect(coordinator.queuedRequests()).toHaveLength(0);
  });

  test("promotes the queued request on release, in FIFO order", () => {
    const { coordinator } = makeCoordinator();
    const held = coordinator.acquire({ agentId: "a", resource: "tool" });
    coordinator.acquire({ agentId: "b", resource: "tool" });
    coordinator.acquire({ agentId: "c", resource: "tool" });

    const released = coordinator.release(held.lease!.id, "done");
    expect(released.status).toBe("released");
    expect(coordinator.heldBy("b", "tool")).toBeDefined();
    expect(coordinator.queuedRequests("tool").map((ticket) => ticket.agentId)).toEqual(["c"]);

    expect(coordinator.release(held.lease!.id, "again").status).toBe("released");
  });

  test("rejects requests once the queue is full", () => {
    const clock = new ManualClock();
    const coordinator = new LeaseCoordinator(clock);
    coordinator.register({ name: "tool", mode: "exclusive", maxQueue: 1 });
    coordinator.acquire({ agentId: "a", resource: "tool" });
    expect(coordinator.acquire({ agentId: "b", resource: "tool" }).status).toBe("queued");
    const overflow = coordinator.acquire({ agentId: "c", resource: "tool" });
    expect(overflow.status).toBe("denied");
    expect(overflow.reason).toContain("queue full");
  });
});

describe("shared leases", () => {
  test("grants up to capacity and queues beyond it", () => {
    const { coordinator } = makeCoordinator();
    expect(coordinator.acquire({ agentId: "a", resource: "model-api" }).status).toBe("granted");
    expect(coordinator.acquire({ agentId: "b", resource: "model-api" }).status).toBe("granted");
    expect(coordinator.acquire({ agentId: "c", resource: "model-api" }).status).toBe("granted");
    const fourth = coordinator.acquire({ agentId: "d", resource: "model-api" });
    expect(fourth.status).toBe("queued");
    expect(coordinator.activeLeases("model-api")).toHaveLength(3);
  });
});

describe("ttl, renewal, and sweeping", () => {
  test("sweep expires a lease and promotes the queue", () => {
    const { coordinator, clock } = makeCoordinator();
    coordinator.acquire({ agentId: "a", resource: "tool", ttlMs: 500 });
    coordinator.acquire({ agentId: "b", resource: "tool", ttlMs: 500 });

    expect(coordinator.sweep()).toHaveLength(0);
    clock.advance(500);
    const expired = coordinator.sweep();
    expect(expired).toHaveLength(1);
    expect(expired[0].releaseReason).toBe("expired");
    expect(coordinator.heldBy("b", "tool")).toBeDefined();
  });

  test("acquire sweeps expired holders before deciding", () => {
    const { coordinator, clock } = makeCoordinator();
    coordinator.acquire({ agentId: "a", resource: "tool", ttlMs: 10 });
    clock.advance(10);
    const outcome = coordinator.acquire({ agentId: "b", resource: "tool", ttlMs: 10 });
    expect(outcome.status).toBe("granted");
  });

  test("renew extends the expiry and records the renewal", () => {
    const { coordinator, clock } = makeCoordinator();
    const lease = coordinator.acquire({ agentId: "a", resource: "tool", ttlMs: 100 }).lease!;
    clock.advance(50);
    const renewed = coordinator.renew(lease.id, 200);
    expect(renewed.expiresAt).toBe(1_250);
    expect(renewed.renewals).toBe(1);

    clock.advance(200);
    expect(() => coordinator.renew(lease.id)).toThrow(/expired/);
    expect(coordinator.history().find((entry) => entry.id === lease.id)?.status).toBe("expired");
  });

  test("rejects unknown leases and invalid ttls", () => {
    const { coordinator } = makeCoordinator();
    expect(() => coordinator.renew("lease-404")).toThrow(/unknown lease/);
    expect(() => coordinator.acquire({ agentId: "a", resource: "tool", ttlMs: 0 })).toThrow(
      /ttlMs must be a positive number/,
    );
  });
});

describe("cancellation and holder checks", () => {
  test("cancel removes a queued ticket", () => {
    const { coordinator } = makeCoordinator();
    coordinator.acquire({ agentId: "a", resource: "tool" });
    const queued = coordinator.acquire({ agentId: "b", resource: "tool" });
    expect(coordinator.cancel(queued.ticket!.ticketId)).toBe(true);
    expect(coordinator.cancel(queued.ticket!.ticketId)).toBe(false);
    expect(coordinator.queuedRequests()).toHaveLength(0);
    expect(coordinator.stats().totalCancelled).toBe(1);
  });

  test("assertHeld guards a critical section", () => {
    const { coordinator } = makeCoordinator();
    coordinator.acquire({ agentId: "a", resource: "tool" });
    expect(coordinator.assertHeld("tool", "a").agentId).toBe("a");
    expect(() => coordinator.assertHeld("tool", "b")).toThrow(/does not hold a lease/);
  });

  test("withLease releases the lease even when the callback throws", async () => {
    const { coordinator } = makeCoordinator();
    await expect(
      coordinator.withLease({ agentId: "a", resource: "tool" }, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(coordinator.activeLeases("tool")).toHaveLength(0);

    const value = await coordinator.withLease({ agentId: "a", resource: "tool" }, (lease) => lease.id);
    expect(value).toMatch(/^lease-/);
    expect(coordinator.activeLeases("tool")).toHaveLength(0);
  });

  test("withLease refuses an unavailable resource", async () => {
    const { coordinator } = makeCoordinator();
    coordinator.acquire({ agentId: "a", resource: "tool" });
    await expect(
      coordinator.withLease({ agentId: "b", resource: "tool" }, () => "never"),
    ).rejects.toThrow(/held by a@/);
  });
});

describe("history, snapshots, and stats", () => {
  test("snapshots expose holders and queued requests", () => {
    const { coordinator } = makeCoordinator();
    coordinator.acquire({ agentId: "a", resource: "tool" });
    coordinator.acquire({ agentId: "b", resource: "tool" });
    const snapshot = coordinator.snapshot("tool");
    expect(snapshot.mode).toBe("exclusive");
    expect(snapshot.holders.map((lease) => lease.agentId)).toEqual(["a"]);
    expect(snapshot.queued.map((ticket) => ticket.agentId)).toEqual(["b"]);
  });

  test("history records every lease transition", () => {
    const { coordinator, clock } = makeCoordinator();
    const lease = coordinator.acquire({ agentId: "a", resource: "tool", ttlMs: 10 }).lease!;
    coordinator.release(lease.id, "finished");
    coordinator.acquire({ agentId: "b", resource: "tool", ttlMs: 10 });
    clock.advance(10);
    coordinator.sweep();

    const history = coordinator.history();
    expect(history).toHaveLength(2);
    expect(history.map((entry) => entry.status)).toEqual(["released", "expired"]);
    expect(coordinator.heldBy("b", "tool")).toBeUndefined();
  });

  test("stats aggregate the counters", () => {
    const { coordinator } = makeCoordinator();
    const lease = coordinator.acquire({ agentId: "a", resource: "tool" }).lease!;
    coordinator.acquire({ agentId: "b", resource: "tool" });
    coordinator.acquire({ agentId: "c", resource: "tool", queue: false });
    coordinator.release(lease.id, "done");

    expect(coordinator.stats()).toEqual({
      resources: 2,
      activeLeases: 1,
      queuedRequests: 0,
      totalAcquired: 2,
      totalQueued: 1,
      totalReleased: 1,
      totalExpired: 0,
      totalDenied: 1,
      totalCancelled: 0,
    });
  });
});
