import { LeaseError, systemClock } from "./clock";
import {
  DEFAULT_MAX_QUEUE,
  DEFAULT_TTL_MS,
  type AcquireOutcome,
  type AcquireRequest,
  type Clock,
  type CoordinatorStats,
  type LeaseMode,
  type LeaseRecord,
  type PendingRequest,
  type ResourceDefinition,
  type ResourceSnapshot,
} from "./types";

interface ResourceState {
  name: string;
  mode: LeaseMode;
  capacity: number;
  maxQueue: number;
  description?: string;
  holders: LeaseRecord[];
  queue: PendingRequest[];
}

export class LeaseCoordinator {
  private readonly registry = new Map<string, ResourceState>();
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly tickets = new Map<string, PendingRequest>();
  private readonly records: LeaseRecord[] = [];
  private leaseCounter = 0;
  private ticketCounter = 0;
  private counters = {
    acquired: 0,
    queued: 0,
    released: 0,
    expired: 0,
    denied: 0,
    cancelled: 0,
  };

  constructor(private readonly clock: Clock = systemClock) {}

  register(definition: ResourceDefinition): this {
    const name = definition.name?.trim();
    if (!name) throw new LeaseError("UNKNOWN_RESOURCE", "resource name must be a non-empty string");
    if (this.registry.has(name)) {
      throw new LeaseError("DUPLICATE_RESOURCE", `resource "${name}" is already registered`);
    }

    const mode: LeaseMode = definition.mode ?? "exclusive";
    const capacity = definition.capacity ?? 1;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new LeaseError("INVALID_CAPACITY", `resource "${name}" capacity must be an integer >= 1`);
    }
    if (mode === "exclusive" && capacity !== 1) {
      throw new LeaseError("INVALID_CAPACITY", `resource "${name}" is exclusive and must have capacity 1`);
    }
    const maxQueue = definition.maxQueue ?? DEFAULT_MAX_QUEUE;
    if (!Number.isInteger(maxQueue) || maxQueue < 0) {
      throw new LeaseError("QUEUE_LIMIT", `resource "${name}" maxQueue must be an integer >= 0`);
    }

    this.registry.set(name, {
      name,
      mode,
      capacity,
      maxQueue,
      description: definition.description,
      holders: [],
      queue: [],
    });
    return this;
  }

  has(resource: string): boolean {
    return this.registry.has(resource);
  }

  list(): string[] {
    return [...this.registry.keys()];
  }

  snapshot(resource: string): ResourceSnapshot {
    const state = this.requireState(resource);
    return {
      name: state.name,
      mode: state.mode,
      capacity: state.capacity,
      maxQueue: state.maxQueue,
      holders: state.holders.map((lease) => ({ ...lease })),
      queued: state.queue.map((ticket) => ({ ...ticket })),
    };
  }

  snapshots(): ResourceSnapshot[] {
    return [...this.registry.keys()].map((name) => this.snapshot(name));
  }

  acquire(request: AcquireRequest): AcquireOutcome {
    this.sweep();
    const state = this.requireState(request.resource);
    if (!request.agentId?.trim()) {
      throw new LeaseError("NOT_LEASE_HOLDER", "agentId must be a non-empty string");
    }
    const ttlMs = request.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new LeaseError("INVALID_TTL", `ttlMs must be a positive number for resource "${state.name}"`);
    }
    const mode: LeaseMode = request.mode ?? state.mode;
    const base = { resource: state.name, agentId: request.agentId };

    if (mode !== state.mode) {
      this.counters.denied += 1;
      return {
        ...base,
        status: "denied",
        reason: `resource "${state.name}" only grants ${state.mode} leases`,
      };
    }

    if (this.canGrant(state, mode)) {
      const lease = this.grant(state, request.agentId, mode, ttlMs, request.metadata);
      return { ...base, status: "granted", lease };
    }

    const conflict = this.describeConflict(state);

    if (request.queue === false) {
      this.counters.denied += 1;
      return { ...base, status: "denied", reason: conflict };
    }

    if (state.queue.length >= state.maxQueue) {
      this.counters.denied += 1;
      return { ...base, status: "denied", reason: `queue full for "${state.name}" (${conflict})` };
    }

    const ticket: PendingRequest = {
      ticketId: `ticket-${++this.ticketCounter}`,
      resource: state.name,
      agentId: request.agentId,
      mode,
      ttlMs,
      requestedAt: this.clock.now(),
      metadata: request.metadata,
    };
    state.queue.push(ticket);
    this.tickets.set(ticket.ticketId, ticket);
    this.counters.queued += 1;
    return { ...base, status: "queued", ticket, position: state.queue.length, reason: conflict };
  }

  renew(leaseId: string, ttlMs?: number): LeaseRecord {
    const lease = this.leases.get(leaseId);
    if (!lease) throw new LeaseError("LEASE_NOT_FOUND", `unknown lease "${leaseId}"`);
    if (lease.status === "expired" || this.clock.now() >= lease.expiresAt) {
      this.sweep();
      throw new LeaseError("LEASE_EXPIRED", `lease "${leaseId}" already expired and cannot be renewed`);
    }
    if (lease.status !== "active") {
      throw new LeaseError("LEASE_NOT_FOUND", `lease "${leaseId}" is ${lease.status} and cannot be renewed`);
    }
    const nextTtl = ttlMs ?? lease.ttlMs;
    if (!Number.isFinite(nextTtl) || nextTtl <= 0) {
      throw new LeaseError("INVALID_TTL", `ttlMs must be a positive number for lease "${leaseId}"`);
    }
    lease.ttlMs = nextTtl;
    lease.expiresAt = this.clock.now() + nextTtl;
    lease.renewals += 1;
    return { ...lease };
  }

  release(leaseId: string, reason = "released"): LeaseRecord {
    const lease = this.leases.get(leaseId);
    if (!lease) throw new LeaseError("LEASE_NOT_FOUND", `unknown lease "${leaseId}"`);
    if (lease.status === "expired") throw new LeaseError("LEASE_EXPIRED", `lease "${leaseId}" already expired`);
    if (lease.status === "released") return { ...lease };

    const state = this.requireState(lease.resource);
    this.revoke(state, lease, reason);
    this.counters.released += 1;
    this.promote(state);
    return { ...lease };
  }

  cancel(ticketId: string): boolean {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return false;
    const state = this.registry.get(ticket.resource);
    if (state) state.queue = state.queue.filter((entry) => entry.ticketId !== ticketId);
    this.tickets.delete(ticketId);
    this.counters.cancelled += 1;
    return true;
  }

  sweep(): LeaseRecord[] {
    const now = this.clock.now();
    const expired: LeaseRecord[] = [];
    for (const state of this.registry.values()) {
      let changed = false;
      for (const lease of [...state.holders]) {
        if (lease.expiresAt <= now) {
          this.revoke(state, lease, "expired");
          this.counters.expired += 1;
          changed = true;
          expired.push({ ...lease });
        }
      }
      if (changed) this.promote(state);
    }
    return expired;
  }

  activeLeases(resource?: string): LeaseRecord[] {
    const all = [...this.leases.values()].filter((lease) => lease.status === "active");
    const scoped = resource ? all.filter((lease) => lease.resource === resource) : all;
    return scoped.map((lease) => ({ ...lease }));
  }

  queuedRequests(resource?: string): PendingRequest[] {
    const states = resource ? [this.requireState(resource)] : [...this.registry.values()];
    return states.flatMap((state) => state.queue.map((ticket) => ({ ...ticket })));
  }

  history(): LeaseRecord[] {
    return this.records.map((lease) => ({ ...lease }));
  }

  heldBy(agentId: string, resource: string): LeaseRecord | undefined {
    const state = this.registry.get(resource);
    const lease = state?.holders.find((entry) => entry.agentId === agentId);
    return lease ? { ...lease } : undefined;
  }

  assertHeld(resource: string, agentId: string): LeaseRecord {
    const lease = this.heldBy(agentId, resource);
    if (!lease) {
      throw new LeaseError("NOT_LEASE_HOLDER", `agent "${agentId}" does not hold a lease on "${resource}"`);
    }
    return lease;
  }

  async withLease<T>(request: AcquireRequest, fn: (lease: LeaseRecord) => T | Promise<T>): Promise<T> {
    const outcome = this.acquire({ ...request, queue: false });
    if (outcome.status !== "granted" || !outcome.lease) {
      throw new LeaseError(
        "LEASE_UNAVAILABLE",
        outcome.reason ?? `resource "${request.resource}" is currently unavailable`,
      );
    }
    const leaseId = outcome.lease.id;
    try {
      return await fn(outcome.lease);
    } finally {
      if (this.leases.get(leaseId)?.status === "active") this.release(leaseId, "withLease");
      else this.sweep();
    }
  }

  stats(): CoordinatorStats {
    return {
      resources: this.registry.size,
      activeLeases: this.activeLeases().length,
      queuedRequests: this.queuedRequests().length,
      totalAcquired: this.counters.acquired,
      totalQueued: this.counters.queued,
      totalReleased: this.counters.released,
      totalExpired: this.counters.expired,
      totalDenied: this.counters.denied,
      totalCancelled: this.counters.cancelled,
    };
  }

  private requireState(resource: string): ResourceState {
    const state = this.registry.get(resource);
    if (!state) throw new LeaseError("UNKNOWN_RESOURCE", `unknown resource "${resource}"`);
    return state;
  }

  private canGrant(state: ResourceState, mode: LeaseMode): boolean {
    if (state.holders.length === 0) return true;
    if (mode === "exclusive" || state.mode === "exclusive") return false;
    return state.holders.length < state.capacity;
  }

  private describeConflict(state: ResourceState): string {
    const holders = state.holders.map((lease) => `${lease.agentId}@${lease.id}`).join(", ");
    return `${state.name} held by ${holders || "no one"}`;
  }

  private grant(
    state: ResourceState,
    agentId: string,
    mode: LeaseMode,
    ttlMs: number,
    metadata?: Record<string, string>,
  ): LeaseRecord {
    const now = this.clock.now();
    const lease: LeaseRecord = {
      id: `lease-${++this.leaseCounter}`,
      resource: state.name,
      agentId,
      mode,
      acquiredAt: now,
      expiresAt: now + ttlMs,
      ttlMs,
      renewals: 0,
      status: "active",
      metadata,
    };
    state.holders.push(lease);
    this.leases.set(lease.id, lease);
    this.records.push(lease);
    this.counters.acquired += 1;
    return { ...lease };
  }

  private revoke(state: ResourceState, lease: LeaseRecord, reason: string): void {
    lease.status = reason === "expired" ? "expired" : "released";
    lease.releasedAt = this.clock.now();
    lease.releaseReason = reason;
    state.holders = state.holders.filter((entry) => entry.id !== lease.id);
  }

  private promote(state: ResourceState): void {
    while (state.queue.length > 0) {
      const head = state.queue[0];
      if (!this.canGrant(state, head.mode)) return;
      state.queue.shift();
      this.tickets.delete(head.ticketId);
      this.grant(state, head.agentId, head.mode, head.ttlMs, head.metadata);
    }
  }
}
