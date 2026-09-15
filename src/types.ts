export type LeaseMode = "exclusive" | "shared";

export type LeaseStatus = "active" | "released" | "expired";

export type RequestStatus = "granted" | "queued" | "denied";

export type LeaseErrorCode =
  | "DUPLICATE_RESOURCE"
  | "UNKNOWN_RESOURCE"
  | "INVALID_CAPACITY"
  | "INVALID_TTL"
  | "LEASE_NOT_FOUND"
  | "LEASE_EXPIRED"
  | "LEASE_UNAVAILABLE"
  | "NOT_LEASE_HOLDER"
  | "QUEUE_LIMIT";

export interface Clock {
  now(): number;
}

export interface ResourceDefinition {
  name: string;
  mode?: LeaseMode;
  capacity?: number;
  maxQueue?: number;
  description?: string;
}

export interface ResourceSnapshot {
  name: string;
  mode: LeaseMode;
  capacity: number;
  maxQueue?: number;
  holders: LeaseRecord[];
  queued: PendingRequest[];
}

export interface LeaseRecord {
  id: string;
  resource: string;
  agentId: string;
  mode: LeaseMode;
  acquiredAt: number;
  expiresAt: number;
  ttlMs: number;
  renewals: number;
  status: LeaseStatus;
  releasedAt?: number;
  releaseReason?: string;
  metadata?: Record<string, string>;
}

export interface AcquireRequest {
  agentId: string;
  resource: string;
  ttlMs?: number;
  mode?: LeaseMode;
  queue?: boolean;
  metadata?: Record<string, string>;
}

export interface PendingRequest {
  ticketId: string;
  resource: string;
  agentId: string;
  mode: LeaseMode;
  ttlMs: number;
  requestedAt: number;
  metadata?: Record<string, string>;
}

export interface AcquireOutcome {
  status: RequestStatus;
  resource: string;
  agentId: string;
  lease?: LeaseRecord;
  ticket?: PendingRequest;
  position?: number;
  reason?: string;
}

export interface CoordinatorStats {
  resources: number;
  activeLeases: number;
  queuedRequests: number;
  totalAcquired: number;
  totalQueued: number;
  totalReleased: number;
  totalExpired: number;
  totalDenied: number;
  totalCancelled: number;
}

export const DEFAULT_TTL_MS = 30_000;

export const DEFAULT_MAX_QUEUE = 100;
