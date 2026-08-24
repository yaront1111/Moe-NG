import { randomBytes as nodeRandomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  PAIRING_APPROVAL_COLLISION_ATTEMPTS,
  PAIRING_APPROVAL_MAX_LIVE_REQUESTS,
  PAIRING_APPROVAL_TTL_MS,
  refusePairingApproval,
} from "./pairing-approval-contract.js";
import type {
  PairingApprovalGranted,
  PairingApprovalRefusal,
  PairingApprovalWindow,
  PairingApprovalWindowOptions,
  PairingClaimReserved,
  PairingRandomBytesSource,
  PairingRequestCreated,
} from "./pairing-approval-contract.js";

export * from "./pairing-approval-contract.js";

type ActiveState = "PENDING" | "APPROVED" | "CLAIMING";
type TerminalState = "EXPIRED" | "CLAIMED";
interface ActiveRequest {
  readonly confirmationLabel: string;
  readonly deadline: number;
  generation: number;
  readonly requestId: string;
  state: ActiveState;
}
interface TerminalRequest {
  readonly confirmationLabel: string; readonly requestId: string; readonly state: TerminalState;
}
interface Identity { readonly confirmationLabel: string; readonly requestId: string; }
const REQUEST_ID = /^[0-9a-f]{64}$/u;
const CONFIRMATION_LABEL = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u;
const refuse = refusePairingApproval;
function randomHex(source: PairingRandomBytesSource, size: number): string | null {
  try {
    const bytes = source(size);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size) return null;
    return Buffer.from(bytes).toString("hex");
  } catch {
    return null;
  }
}
function labelFrom(hex: string): string {
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}
class PairingApprovalState {
  private readonly active = new Map<string, ActiveRequest>();
  private readonly terminal = new Map<string, TerminalRequest>();
  private clockFailed = false;
  private closed = false;
  private lastObserved: number | null = null;
  private readonly now: () => number;
  private readonly randomBytes: PairingRandomBytesSource;

  constructor(
    now: () => number,
    randomBytes: PairingRandomBytesSource,
  ) {
    this.now = now;
    this.randomBytes = randomBytes;
  }

  private observeTime(): number | null {
    if (this.clockFailed) return null;
    try {
      const observed = this.now();
      if (!Number.isFinite(observed) || observed < 0
        || (this.lastObserved !== null && observed < this.lastObserved)) {
        this.clockFailed = true;
        return null;
      }
      this.lastObserved = observed;
      return observed;
    } catch {
      this.clockFailed = true;
      return null;
    }
  }

  private rememberTerminal(record: ActiveRequest, state: TerminalState): void {
    if (this.terminal.size >= PAIRING_APPROVAL_MAX_LIVE_REQUESTS) {
      const oldest = this.terminal.keys().next().value as string | undefined;
      if (oldest !== undefined) this.terminal.delete(oldest);
    }
    this.terminal.set(record.requestId, Object.freeze({
      confirmationLabel: record.confirmationLabel, requestId: record.requestId, state,
    }));
  }

  private expireAt(observed: number): void {
    for (const [requestId, record] of this.active) {
      if (observed < record.deadline) continue;
      this.active.delete(requestId);
      this.rememberTerminal(record, "EXPIRED");
    }
  }

  private activeByLabel(label: string): ActiveRequest | null {
    for (const record of this.active.values()) {
      if (record.confirmationLabel === label) return record;
    }
    return null;
  }

  private terminalByLabel(label: string): TerminalRequest | null {
    for (const record of this.terminal.values()) {
      if (record.confirmationLabel === label) return record;
    }
    return null;
  }

  private terminalRefusal(record: TerminalRequest): PairingApprovalRefusal {
    return refuse(record.state === "CLAIMED"
      ? "PAIRING_REQUEST_ALREADY_CLAIMED" : "PAIRING_REQUEST_EXPIRED");
  }

  private nextIdentity(): Identity | PairingApprovalRefusal {
    for (let attempt = 0; attempt < PAIRING_APPROVAL_COLLISION_ATTEMPTS; attempt += 1) {
      const requestId = randomHex(this.randomBytes, 32);
      const labelHex = randomHex(this.randomBytes, 6);
      if (requestId === null || labelHex === null) {
        return refuse("PAIRING_APPROVAL_ENTROPY_UNAVAILABLE");
      }
      const confirmationLabel = labelFrom(labelHex);
      const labelTaken = this.activeByLabel(confirmationLabel) !== null
        || this.terminalByLabel(confirmationLabel) !== null;
      if (!this.active.has(requestId) && !this.terminal.has(requestId) && !labelTaken) {
        return { confirmationLabel, requestId };
      }
    }
    return refuse("PAIRING_APPROVAL_IDENTITY_EXHAUSTED");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.active.clear();
    this.terminal.clear();
  }

  create(): PairingRequestCreated | PairingApprovalRefusal {
    if (this.closed) return refuse("PAIRING_APPROVAL_UNAVAILABLE");
    const observed = this.observeTime();
    if (observed === null) return refuse("PAIRING_APPROVAL_CLOCK_UNAVAILABLE");
    this.expireAt(observed);
    if (this.active.size >= PAIRING_APPROVAL_MAX_LIVE_REQUESTS) {
      return refuse("PAIRING_APPROVAL_CAPACITY_EXHAUSTED");
    }
    const deadline = observed + PAIRING_APPROVAL_TTL_MS;
    if (!Number.isFinite(deadline)) {
      this.clockFailed = true;
      return refuse("PAIRING_APPROVAL_CLOCK_UNAVAILABLE");
    }
    const identity = this.nextIdentity();
    if ("ok" in identity) return identity;
    this.active.set(identity.requestId, {
      ...identity, deadline, generation: 0, state: "PENDING",
    });
    return Object.freeze({ ...identity, ok: true as const });
  }

  private reservationFor(record: ActiveRequest): PairingClaimReserved {
    record.state = "CLAIMING";
    record.generation += 1;
    const generation = record.generation;
    let settled = false;
    const applies = (): boolean => this.active.get(record.requestId) === record
      && record.state === "CLAIMING" && record.generation === generation;
    const reservation = Object.freeze({
      commit: (): void => {
        if (settled) return;
        settled = true;
        if (!applies()) return;
        this.active.delete(record.requestId);
        this.rememberTerminal(record, "CLAIMED");
      },
      release: (): void => {
        if (settled) return;
        settled = true;
        if (applies()) record.state = "APPROVED";
      },
    });
    return Object.freeze({ ok: true as const, reservation, state: "CLAIMING" as const });
  }

  reserve(requestId: unknown): PairingClaimReserved | PairingApprovalRefusal {
    if (this.closed) return refuse("PAIRING_APPROVAL_UNAVAILABLE");
    if (typeof requestId !== "string" || requestId.length !== 64 || !REQUEST_ID.test(requestId)) {
      return refuse("PAIRING_REQUEST_INVALID");
    }
    const observed = this.observeTime();
    if (observed === null) return refuse("PAIRING_APPROVAL_CLOCK_UNAVAILABLE");
    this.expireAt(observed);
    const record = this.active.get(requestId);
    if (record === undefined) {
      const prior = this.terminal.get(requestId);
      return prior === undefined ? refuse("PAIRING_REQUEST_UNKNOWN") : this.terminalRefusal(prior);
    }
    if (record.state === "PENDING") return refuse("PAIRING_APPROVAL_REQUIRED");
    if (record.state === "CLAIMING") return refuse("PAIRING_REQUEST_BUSY");
    return this.reservationFor(record);
  }

  approve(label: unknown): PairingApprovalGranted | PairingApprovalRefusal {
    if (this.closed) return refuse("PAIRING_APPROVAL_UNAVAILABLE");
    if (typeof label !== "string" || label.length !== 14 || !CONFIRMATION_LABEL.test(label)) {
      return refuse("PAIRING_CONFIRMATION_INVALID");
    }
    const observed = this.observeTime();
    if (observed === null) return refuse("PAIRING_APPROVAL_CLOCK_UNAVAILABLE");
    this.expireAt(observed);
    const record = this.activeByLabel(label);
    if (record === null) {
      const prior = this.terminalByLabel(label);
      return prior === null ? refuse("PAIRING_CONFIRMATION_UNKNOWN") : this.terminalRefusal(prior);
    }
    if (record.state === "CLAIMING") return refuse("PAIRING_REQUEST_BUSY");
    record.state = "APPROVED";
    return Object.freeze({ ok: true as const, state: "APPROVED" as const });
  }
}

/** Creates a pure authority-free state seam; authenticated composition is a later task. */
export function createPairingApprovalWindow(
  options: PairingApprovalWindowOptions = {},
): PairingApprovalWindow {
  const state = new PairingApprovalState(
    options.now ?? (() => performance.now()),
    options.randomBytes ?? nodeRandomBytes,
  );
  const requests = Object.freeze({ create: () => state.create(), reserve: (id: unknown) => state.reserve(id) });
  const operator = Object.freeze({ approve: (label: unknown) => state.approve(label) });
  return Object.freeze({ close: () => state.close(), operator, requests });
}
