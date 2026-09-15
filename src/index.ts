#!/usr/bin/env bun
import { Command } from "commander";
import { LeaseError, ManualClock, systemClock } from "./clock";
import { LeaseCoordinator } from "./coordinator";
import type { CoordinatorStats, LeaseRecord, ResourceSnapshot } from "./types";

export { LeaseCoordinator } from "./coordinator";
export { LeaseError, ManualClock, systemClock } from "./clock";
export * from "./types";

export function formatSnapshot(snapshot: ResourceSnapshot): string {
  const holders = snapshot.holders.length > 0 ? snapshot.holders.map((lease) => `${lease.agentId}(${lease.id})`).join(", ") : "free";
  const queued = snapshot.queued.length > 0 ? snapshot.queued.map((ticket) => `${ticket.agentId}@${ticket.ticketId}`).join(", ") : "none";
  return `${snapshot.name.padEnd(18)} mode=${snapshot.mode.padEnd(9)} capacity=${snapshot.capacity}  holders=${holders}  queued=${queued}`;
}

export function formatStats(stats: CoordinatorStats): string {
  return [
    `resources=${stats.resources}`,
    `active=${stats.activeLeases}`,
    `queued=${stats.queuedRequests}`,
    `acquired=${stats.totalAcquired}`,
    `released=${stats.totalReleased}`,
    `expired=${stats.totalExpired}`,
    `denied=${stats.totalDenied}`,
    `cancelled=${stats.totalCancelled}`,
  ].join("  ");
}

export function formatLease(lease: LeaseRecord): string {
  const state = lease.releasedAt !== undefined ? `ended=${lease.releasedAt}` : `expires=${lease.expiresAt}`;
  return `${lease.id.padEnd(9)} ${lease.resource.padEnd(16)} ${lease.agentId.padEnd(12)} ${lease.mode.padEnd(9)} ${state}  status=${lease.status}${lease.releaseReason ? ` (${lease.releaseReason})` : ""}`;
}

export interface DemoOptions {
  verbose?: boolean;
}

export function runDemo(options: DemoOptions = {}): { coordinator: LeaseCoordinator; clock: ManualClock } {
  const clock = new ManualClock(1_000);
  const coordinator = new LeaseCoordinator(clock);

  coordinator
    .register({ name: "browser", mode: "exclusive", description: "single headless browser session" })
    .register({ name: "model-api", mode: "shared", capacity: 3, maxQueue: 10, description: "rate-limited model endpoint" })
    .register({ name: "index-writer", mode: "exclusive", maxQueue: 1, description: "writes the shared search index" });

  const granted = coordinator.acquire({ agentId: "scout", resource: "browser", ttlMs: 2_000 });
  const queuedFirst = coordinator.acquire({ agentId: "scribe", resource: "browser", ttlMs: 2_000 });
  const queuedSecond = coordinator.acquire({ agentId: "analyst", resource: "browser", ttlMs: 2_000 });
  const cancelled = queuedSecond.ticket ? coordinator.cancel(queuedSecond.ticket.ticketId) : false;
  const modeMismatch = coordinator.acquire({ agentId: "scout", resource: "model-api", mode: "exclusive" });

  const sharedFirst = coordinator.acquire({ agentId: "scout", resource: "model-api", ttlMs: 500 });
  const sharedSecond = coordinator.acquire({ agentId: "scribe", resource: "model-api", ttlMs: 500 });
  const sharedThird = coordinator.acquire({ agentId: "analyst", resource: "model-api", ttlMs: 500 });
  const sharedOverflow = coordinator.acquire({ agentId: "ranger", resource: "model-api", ttlMs: 1_500 });

  coordinator.acquire({ agentId: "scout", resource: "index-writer", ttlMs: 5_000 });
  const queueFull = coordinator.acquire({ agentId: "scribe", resource: "index-writer", ttlMs: 5_000 });
  const queueOverflow = coordinator.acquire({ agentId: "analyst", resource: "index-writer", ttlMs: 5_000 });

  if (options.verbose) {
    console.log(`exclusive acquire    -> ${granted.status} (${granted.lease?.id})`);
    console.log(`contended acquire    -> ${queuedFirst.status} position=${queuedFirst.position} (${queuedFirst.reason})`);
    console.log(`second in line       -> ${queuedSecond.status} position=${queuedSecond.position}, cancelled=${cancelled}`);
    console.log(`mode mismatch        -> ${modeMismatch.status} (${modeMismatch.reason})`);
    console.log(`shared capacity 3    -> ${sharedFirst.status}, ${sharedSecond.status}, ${sharedThird.status}`);
    console.log(`shared overflow      -> ${sharedOverflow.status} position=${sharedOverflow.position}`);
    console.log(`queue limit 1        -> ${queueFull.status}, overflow ${queueOverflow.status} (${queueOverflow.reason})`);
  }

  clock.advance(2_100);
  const expired = coordinator.sweep();

  if (options.verbose) {
    console.log(`sweep after 2.1s     -> expired ${expired.map((lease) => `${lease.id}:${lease.agentId}`).join(", ") || "none"}`);
    console.log(`browser holders now  -> ${coordinator.activeLeases("browser").map((lease) => lease.agentId).join(", ") || "none"}`);
    console.log(`model-api holders    -> ${coordinator.activeLeases("model-api").map((lease) => lease.agentId).join(", ") || "none"}`);
  }

  return { coordinator, clock };
}

function printState(coordinator: LeaseCoordinator): void {
  for (const snapshot of coordinator.snapshots()) console.log(formatSnapshot(snapshot));
  console.log("");
  console.log(formatStats(coordinator.stats()));
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("agent-lease-coordinator")
    .description("Reserve exclusive or shared agent resources with TTL leases and a fair wait queue.")
    .option("--demo", "run the bundled demo and print the final state", false)
    .option("--verbose", "print each step of the demo", false)
    .option("--history", "print every lease ever issued by the demo", false)
    .option("--json", "emit the demo result as JSON", false);

  program.parse(process.argv);
  const options = program.opts<{ demo: boolean; verbose: boolean; history: boolean; json: boolean }>();

  const verbose = options.verbose || (!options.json && !options.history && !options.demo);
  const { coordinator } = runDemo({ verbose });

  if (options.json) {
    console.log(
      JSON.stringify(
        { resources: coordinator.snapshots(), leases: coordinator.history(), stats: coordinator.stats() },
        null,
        2,
      ),
    );
    return;
  }

  if (options.history) {
    for (const lease of coordinator.history()) console.log(formatLease(lease));
    return;
  }

  printState(coordinator);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    if (error instanceof LeaseError) {
      console.error(`Error [${error.code}]: ${error.message}`);
      process.exit(1);
    }
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
