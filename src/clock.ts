import type { Clock, LeaseErrorCode } from "./types";

export class LeaseError extends Error {
  readonly code: LeaseErrorCode;

  constructor(code: LeaseErrorCode, message: string) {
    super(message);
    this.name = "LeaseError";
    this.code = code;
  }
}

export class ManualClock implements Clock {
  private current: number;

  constructor(start = 0) {
    if (!Number.isFinite(start)) throw new LeaseError("INVALID_TTL", "clock start must be a finite number");
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) throw new LeaseError("INVALID_TTL", "clock advance must be a non-negative number");
    this.current += ms;
    return this.current;
  }

  set(ms: number): number {
    if (!Number.isFinite(ms)) throw new LeaseError("INVALID_TTL", "clock value must be a finite number");
    this.current = ms;
    return this.current;
  }
}

export const systemClock: Clock = { now: () => Date.now() };
