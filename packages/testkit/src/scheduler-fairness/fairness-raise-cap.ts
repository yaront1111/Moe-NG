import type {
  FairnessResult,
  FairnessState,
} from "./fairness-model.js";
import {
  deepFreeze,
  fail,
  makeIssue,
  sortTickets,
} from "./fairness-internal.js";
import {
  arrayLengthExceeds,
  hasExactKeys,
  isFairnessId,
  readDataArray,
  readDataRecord,
} from "./fairness-input.js";
import { DEFAULT_M_D, isNonNegativeInteger } from "./fairness-policy.js";
import { boundFor } from "./fairness-selection.js";

interface Migration {
  readonly ticketId: string;
  readonly boundAtMost: number;
}

const MIGRATION_KEYS = ["ticketId", "boundAtMost"] as const;

/** Validate the optional migration list; returns issues or a normalized map. */
function readMigrations(
  state: FairnessState,
  raw: unknown,
): { readonly ok: false; readonly result: FairnessResult } | {
  readonly ok: true;
  readonly map: ReadonlyMap<string, number>;
} {
  const map = new Map<string, number>();
  if (raw === undefined) {
    return { ok: true, map };
  }
  if (arrayLengthExceeds(raw, DEFAULT_M_D)) {
    return {
      ok: false,
      result: fail(makeIssue("FAIRNESS_EVENT_LIMIT_EXCEEDED", "migration evidence exceeds the project ceiling")),
    };
  }
  const entries = readDataArray(raw, DEFAULT_M_D);
  if (entries === null) {
    return {
      ok: false,
      result: fail(makeIssue("FAIRNESS_MALFORMED_EVENT", "migrations must be an array")),
    };
  }
  const ticketsById = new Map(state.tickets.map((ticket) => [ticket.ticketId, ticket]));
  for (const rawEntry of entries) {
    const entry = readDataRecord(rawEntry);
    if (entry === null || !hasExactKeys(entry, MIGRATION_KEYS)) {
      return {
        ok: false,
        result: fail(makeIssue("FAIRNESS_MALFORMED_EVENT", "migration must be a record")),
      };
    }
    const { ticketId, boundAtMost } = entry as Partial<Migration>;
    if (!isFairnessId(ticketId) || !isNonNegativeInteger(boundAtMost)) {
      return {
        ok: false,
        result: fail(makeIssue("FAIRNESS_MALFORMED_EVENT", "migration fields are malformed")),
      };
    }
    if (map.has(ticketId)) {
      return {
        ok: false,
        result: fail(
          makeIssue("FAIRNESS_MALFORMED_EVENT", "duplicate migration ticketId", [ticketId]),
        ),
      };
    }
    const target = ticketsById.get(ticketId);
    if (target === undefined || !target.dispatchable) {
      return {
        ok: false,
        result: fail(
          makeIssue(
            "FAIRNESS_MALFORMED_EVENT",
            "migration references an unknown or non-dispatchable ticket",
            [ticketId],
          ),
        ),
      };
    }
    map.set(ticketId, boundAtMost);
  }
  return { ok: true, map };
}

/**
 * Apply a `RAISE_CAP`. A loosening raise (`newMd > policyMd`) is admitted only
 * when every live dispatchable ticket is drained or carries an equal-or-tighter
 * migration bound; otherwise `CAP_RAISE_REQUIRES_DRAIN_OR_TIGHTER_MIGRATION`.
 * Migrations are admission-gate evidence only — no per-ticket state is mutated.
 */
export function applyRaiseCap(state: FairnessState, ev: Record<string, unknown>): FairnessResult {
  const newMd = ev["newMd"];
  if (!isNonNegativeInteger(newMd) || newMd < 1) {
    return fail(makeIssue("FAIRNESS_MALFORMED_EVENT", "newMd must be a positive integer"));
  }
  if (newMd > state.projectCeilingMd) {
    return fail(
      makeIssue("FAIRNESS_PROJECT_CEILING_EXCEEDED", "newMd exceeds the project ceiling"),
    );
  }
  if (newMd < state.dispatchableCount) {
    return fail(
      makeIssue(
        "FAIRNESS_TICKET_CAP_EXCEEDED",
        "newMd is below the live dispatchable count",
      ),
    );
  }
  const migrations = readMigrations(state, ev["migrations"]);
  if (!migrations.ok) {
    return migrations.result;
  }

  if (newMd > state.policyMd) {
    const uncovered: string[] = [];
    for (const ticket of state.tickets) {
      if (!ticket.dispatchable) {
        continue;
      }
      const current = boundFor(state, ticket.ticketId);
      const migrated = migrations.map.get(ticket.ticketId);
      if (current === null || migrated === undefined || migrated > current.value) {
        uncovered.push(ticket.ticketId);
      }
    }
    if (uncovered.length > 0) {
      return fail(
        makeIssue(
          "CAP_RAISE_REQUIRES_DRAIN_OR_TIGHTER_MIGRATION",
          "a cap raise needs every live dispatchable ticket drained or tighter-migrated",
          uncovered,
        ),
      );
    }
  }

  const tickets = state.tickets.map((ticket) => {
    const migrated = migrations.map.get(ticket.ticketId);
    if (migrated === undefined) return ticket;
    return {
      ...ticket,
      migratedBoundAtMost: ticket.migratedBoundAtMost === null
        ? migrated
        : Math.min(ticket.migratedBoundAtMost, migrated),
    };
  });
  return deepFreeze({
    ok: true,
    state: { ...state, tickets: sortTickets(tickets), policyMd: newMd },
  });
}
