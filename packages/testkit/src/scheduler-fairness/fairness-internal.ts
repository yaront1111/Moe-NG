import type {
  FairnessError,
  FairnessIssue,
  FairnessReasonCode,
  FairnessTicket,
} from "./fairness-model.js";

/** Deterministic ascending string comparison (code-unit order). */
export function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/** Recursively freeze so outputs cannot be mutated to affect later calls. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

export function makeIssue(
  code: FairnessReasonCode,
  message: string,
  ticketIds: readonly string[] = [],
): FairnessIssue {
  return Object.freeze({
    code,
    message,
    ticketIds: Object.freeze([...ticketIds]),
  });
}

export function fail(...issues: readonly FairnessIssue[]): FairnessError {
  return deepFreeze({ ok: false, issues: [...issues] });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Tickets sorted by ticketId — the canonical output ordering. */
export function sortTickets(
  tickets: readonly FairnessTicket[],
): FairnessTicket[] {
  return [...tickets].sort((a, b) => compareStrings(a.ticketId, b.ticketId));
}

export function findTicket(
  tickets: readonly FairnessTicket[],
  ticketId: string,
): FairnessTicket | undefined {
  return tickets.find((ticket) => ticket.ticketId === ticketId);
}

/** Count of continuously-dispatchable tickets — the M_d admission unit. */
export function dispatchableCount(tickets: readonly FairnessTicket[]): number {
  let count = 0;
  for (const ticket of tickets) {
    if (ticket.dispatchable) {
      count += 1;
    }
  }
  return count;
}
