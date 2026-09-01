import type { PolicyRiskTier } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import {
  ACTIVE_GRAPH_PROJECTION_LAYER,
  readCurrentActiveGraph,
} from "../planning/active-graph-projection.js";
import type { ActiveGraphRefusal } from "../planning/active-graph-projection.js";
import {
  POLICY_RISK_EVENT_TYPE,
  POLICY_RISK_READER_CODES,
  decodePolicyRiskRecord,
  policyRiskAggregateIdFor,
  policyRiskRefusal,
  selectCurrentPolicyRiskRecord,
} from "./policy-risk-record.js";
import type {
  PolicyRiskLayer,
  PolicyRiskReaderCode,
  PolicyRiskRecord,
} from "./policy-risk-record.js";

export { POLICY_RISK_READER_CODES };
export type { PolicyRiskReaderCode };

export interface PolicyRiskAccepted {
  readonly factId: string;
  readonly ok: true;
  readonly tier: PolicyRiskTier;
  readonly truthClass: "HUMAN_APPROVED";
}

export interface PolicyRiskUnknown {
  readonly code: PolicyRiskReaderCode | ActiveGraphRefusal["code"];
  readonly layer: PolicyRiskLayer | typeof ACTIVE_GRAPH_PROJECTION_LAYER;
  readonly ok: false;
  readonly sourceCode?: ActiveGraphRefusal["sourceCode"];
  readonly sourceLayer?: ActiveGraphRefusal["sourceLayer"];
  readonly tier: null;
  readonly truthClass: "UNKNOWN";
}

export type PolicyRiskReadResult = PolicyRiskAccepted | PolicyRiskUnknown;

const AGGREGATE_PREFIX = "policy-risk:sha256:";

function unknown(code: PolicyRiskReaderCode): PolicyRiskUnknown {
  return Object.freeze({
    ...policyRiskRefusal(code),
    tier: null, truthClass: "UNKNOWN" as const,
  });
}

function activeUnknown(refusal: ActiveGraphRefusal): PolicyRiskUnknown {
  return Object.freeze({
    code: refusal.code,
    layer: refusal.layer,
    ok: false as const,
    sourceCode: refusal.sourceCode,
    sourceLayer: refusal.sourceLayer,
    tier: null,
    truthClass: "UNKNOWN" as const,
  });
}

function readHorizon(store: SqliteEventStore): bigint | null {
  try { return store.readEventHorizon(); } catch { return null; }
}

type Loaded =
  | Readonly<{ readonly ok: true; readonly records: readonly Readonly<PolicyRiskRecord>[] }>
  | Readonly<{ readonly ok: false }>;

function loadRecords(store: SqliteEventStore): Loaded {
  const records: Readonly<PolicyRiskRecord>[] = [];
  try {
    const aggregateIds = store.enumerateAggregateIdsByPrefix(AGGREGATE_PREFIX);
    for (const aggregateId of aggregateIds) {
      const events = store.readEvents(aggregateId);
      if (events.length === 0
        || events.some((event) => event.eventType !== POLICY_RISK_EVENT_TYPE)) {
        return Object.freeze({ ok: false as const });
      }
      for (const event of events) {
        const decoded = decodePolicyRiskRecord(event.payload);
        if (!decoded.ok || policyRiskAggregateIdFor(decoded.record) !== aggregateId) {
          return Object.freeze({ ok: false as const });
        }
        records.push(decoded.record);
      }
    }
  } catch {
    return Object.freeze({ ok: false as const });
  }
  return Object.freeze({ ok: true as const, records: Object.freeze(records) });
}

/**
 * Resolve human policy-risk authority by five ordered exact joins. The active subject is read
 * server-side; no caller can name it. Every miss stays UNKNOWN with no tier, and this module has
 * deliberately no branch capable of minting a DAEMON_VERIFIED risk fact.
 */
export function readPolicyRisk(
  store: SqliteEventStore,
  projectId: string,
  authenticatedPrincipal: string,
  evaluatedAction: string,
): PolicyRiskReadResult {
  const horizon = readHorizon(store);
  if (horizon === null) return unknown("POLICY_RISK_RECORD_UNREADABLE");
  const loaded = loadRecords(store);
  if (!loaded.ok) return unknown("POLICY_RISK_RECORD_UNREADABLE");
  if (loaded.records.length === 0) return unknown("POLICY_RISK_RECORD_MISSING");
  const project = loaded.records.filter((record) => record.projectId === projectId);
  if (project.length === 0) return unknown("POLICY_RISK_PROJECT_FOREIGN");
  const principal = project.filter((record) => record.approvedBy === authenticatedPrincipal);
  if (principal.length === 0) return unknown("POLICY_RISK_APPROVER_FOREIGN");
  const action = principal.filter((record) => record.actionKind === evaluatedAction);
  if (action.length === 0) return unknown("POLICY_RISK_ACTION_MISSING");
  const active = readCurrentActiveGraph(store, projectId);
  if (!active.ok) return activeUnknown(active);
  const subject = action.filter((record) => record.subjectRef === active.graphContentHash);
  if (subject.length === 0) return unknown("POLICY_RISK_SUBJECT_STALE");
  const selected = selectCurrentPolicyRiskRecord(subject);
  if (!selected.ok || selected.record === null) return unknown("POLICY_RISK_RECORD_UNREADABLE");
  if (selected.record.subjectRevision !== active.graphEpoch) {
    return unknown("POLICY_RISK_REVISION_STALE");
  }
  if (readHorizon(store) !== horizon) return unknown("POLICY_RISK_RECORD_UNREADABLE");
  return Object.freeze({
    factId: selected.record.decisionRef,
    ok: true as const,
    tier: selected.record.tier,
    truthClass: "HUMAN_APPROVED" as const,
  });
}
