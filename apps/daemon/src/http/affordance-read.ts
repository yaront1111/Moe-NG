import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { NextAllowedCommand } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { BOOTSTRAP_COMMAND_KINDS, BOOTSTRAP_SCHEMA_VERSION } from "../bootstrap/bootstrap-contracts.js";
import type { BootstrapCommandKind } from "../bootstrap/bootstrap-contracts.js";
import { missingPrerequisites, readDurableLedger, versionOf } from "../bootstrap/bootstrap-ledger.js";
import type { DurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { aggregateIdFor } from "../bootstrap/bootstrap-sequence.js";
import { SESSION_SCHEMA_VERSION } from "../identity/session-contracts.js";
import { readSessionLedger } from "../identity/session-read-model.js";
import { AFFORDANCE_SURFACE_LAYER } from "./affordance-contract.js";
import type {
  AffordancePort,
  AffordanceSurfaceResult,
  ChainStep,
} from "./affordance-contract.js";

/**
 * Derives the surface from the durable decision ledgers alone. Every version it
 * offers was read from a committed aggregate; every BLOCKED list comes from the
 * same prerequisite table the services enforce, so the surface can never offer
 * a command the pipeline would refuse on ordering.
 *
 * DEVELOPMENT default-subject convention: creation-shaped kinds whose subject
 * the caller names (goal/planning aggregates, a fresh session) are offered
 * against these fixed dev subjects, so the expectedVersion is the true durable
 * version of the aggregate the default payload will address. A caller choosing
 * a different subject re-derives its own expectedVersion by reading events —
 * that flow belongs to a later query surface, not to this one.
 */
export const DEFAULT_SUBJECTS: Readonly<Partial<Record<BootstrapCommandKind, string>>> =
  Object.freeze({
    "approval.decide": "run-live-1",
    "goal.close": "goal-live-1",
    "goal.create": "goal-live-1",
    "plan.propose": "run-live-1",
  });

export const DEFAULT_SESSION_SUBJECT = "sess-ui-1";

export interface AffordancePortConfig {
  readonly mintId: () => string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

function bootstrapAggregateId(
  kind: BootstrapCommandKind, projectId: string,
): string {
  return aggregateIdFor(
    { kind, projectId } as Parameters<typeof aggregateIdFor>[0],
    DEFAULT_SUBJECTS[kind] ?? null,
  );
}

export function createAffordancePort(config: AffordancePortConfig): AffordancePort {
  const offer = (
    kind: string, aggregateId: string, version: number, inputSchemaVersion: string,
  ): NextAllowedCommand => Object.freeze({
    commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    commandId: config.mintId(),
    commandKind: kind as NextAllowedCommand["commandKind"],
    expectedVersion: version,
    inputSchemaVersion,
    targetAggregateId: aggregateId,
  });

  const bootstrapSteps = (
    ledger: DurableLedger, offers: NextAllowedCommand[],
  ): ChainStep[] => BOOTSTRAP_COMMAND_KINDS.map((kind) => {
    const aggregateId = bootstrapAggregateId(kind, config.projectId);
    if (ledger.kinds.has(kind)) {
      return Object.freeze({
        aggregateId, kind, missing: [], status: "COMMITTED" as const,
        version: versionOf(ledger, aggregateId),
      });
    }
    const missing = missingPrerequisites(ledger, kind);
    if (missing.length > 0) {
      return Object.freeze({
        aggregateId: null, kind, missing, status: "BLOCKED" as const, version: null,
      });
    }
    const version = versionOf(ledger, aggregateId);
    offers.push(offer(kind, aggregateId, version, BOOTSTRAP_SCHEMA_VERSION));
    return Object.freeze({
      aggregateId, kind, missing: [], status: "READY" as const, version,
    });
  });

  const readSurface = (): AffordanceSurfaceResult => {
    const offers: NextAllowedCommand[] = [];
    const ledger = readDurableLedger(config.store, config.projectId);
    const steps: ChainStep[] = bootstrapSteps(ledger, offers);

    const sessions = readSessionLedger(config.store, config.projectId);
    if (sessions.unreadable) {
      // Fail closed on the whole surface: offering session commands over an
      // unreadable ledger could re-open a spent id.
      return Object.freeze({
        code: "SESSION_LEDGER_UNREADABLE",
        detail: "a committed session decision did not parse back as session facts",
        layer: AFFORDANCE_SURFACE_LAYER,
        outcome: "REFUSED",
      } as const);
    }

    const openAggregate = `session/${DEFAULT_SESSION_SUBJECT}`;
    const openExisting = sessions.sessions.get(DEFAULT_SESSION_SUBJECT);
    if (openExisting === undefined) {
      offers.push(offer("session.open", openAggregate, 0, SESSION_SCHEMA_VERSION));
      steps.push(Object.freeze({
        aggregateId: openAggregate, kind: "session.open", missing: [],
        status: "READY" as const, version: 0,
      }));
    } else {
      steps.push(Object.freeze({
        aggregateId: openAggregate, kind: "session.open", missing: [],
        status: "COMMITTED" as const, version: openExisting.version,
      }));
    }
    for (const record of sessions.sessions.values()) {
      if (record.status !== "OPEN") continue;
      const aggregateId = `session/${record.sessionId}`;
      for (const kind of ["session.close", "session.renew"] as const) {
        offers.push(offer(kind, aggregateId, record.version, SESSION_SCHEMA_VERSION));
        steps.push(Object.freeze({
          aggregateId, kind, missing: [], status: "READY" as const, version: record.version,
        }));
      }
    }

    return Object.freeze({
      nextAllowedCommands: Object.freeze(offers),
      outcome: "SURFACE",
      steps: Object.freeze(steps),
    } as const);
  };

  return Object.freeze({ readSurface });
}
