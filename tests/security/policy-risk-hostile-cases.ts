/** Production-reachable hostile cases for the durable policy-risk boundary. */

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { JsonObject, RuntimeCommandEnvelope } from "@moe/contracts";
import type { ApprovalDecisionRecord } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { seedActivationGraph } from
  "../../apps/daemon/src/activation/activation-world-fixtures.js";
import { readPolicyRisk } from "../../apps/daemon/src/bootstrap/policy-risk-reader.js";
import {
  POLICY_RISK_EVENT_TYPE,
  policyRiskAggregateIdFor,
} from "../../apps/daemon/src/bootstrap/policy-risk-record.js";
import { commitAcceptedLegs } from
  "../../apps/daemon/src/bootstrap/bootstrap-ledger.js";
import type { CommitPlan } from "../../apps/daemon/src/bootstrap/bootstrap-ledger.js";
import {
  GOAL_ID,
  PROJECT_ID,
  SEALED_SUBMISSION_HASH,
  approvalPayload,
  approvalRecord,
  driveThrough,
} from "../../apps/daemon/src/bootstrap/bootstrap-test-fixtures.js";
import { createDaemonCommandPorts } from
  "../../apps/daemon/src/daemon-command-registry.js";
import type { AuthenticatedPrincipal, DecisionPortResult } from
  "../../apps/daemon/src/http/http-contract.js";
import { readCurrentActiveGraph } from
  "../../apps/daemon/src/planning/active-graph-projection.js";
import {
  APPROVAL_MODE_ENV_KEY,
  SPEED_MODE_DELAY_ENV_KEY,
} from "../../apps/daemon/src/planning/approval-policy-settings.js";
import {
  closeStores,
  commitSeamFacade,
  decidedApproval,
  openEmptyFileStore,
  requestFor,
  twoHandles,
} from "../../apps/daemon/src/planning/graph-activation-test-fixtures.js";
import {
  prepareSupersession,
  successorSupersedeInput,
  supersedeContext,
} from "../../apps/daemon/src/planning/graph-supersede-test-fixtures.js";
import { supersedeActiveGraph } from
  "../../apps/daemon/src/planning/graph-supersede-service.js";
import {
  POLICY_RISK_APPROVAL_ACTION,
  buildPolicyRiskLeg,
} from "../../apps/daemon/src/planning/policy-risk-leg.js";
import type {
  PolicyRiskLegInput,
  PolicyRiskSubject,
} from "../../apps/daemon/src/planning/policy-risk-leg.js";
import { asLayered } from "./scheduler-activation-hostile-cases.js";
import type {
  HostileCase,
  HostileRaceCase,
} from "./scheduler-activation-hostile-cases.js";

const PRINCIPAL_ID = "principal-1";
const ASSESSED_AT = "2026-08-26T00:05:00.000Z";
const DECISION_A = "1".repeat(64);
const DECISION_B = "2".repeat(64);
const REQUEST_DIGEST = "d".repeat(64);
const OPERATOR: AuthenticatedPrincipal = Object.freeze({
  capabilities: Object.freeze(["planning.write"]),
  principalId: PRINCIPAL_ID,
  projectId: PROJECT_ID,
});

type AcceptedRiskLeg = Extract<
  ReturnType<typeof buildPolicyRiskLeg>,
  { readonly ok: true }
>;

function currentSubject(store: SqliteEventStore): PolicyRiskSubject {
  const active = readCurrentActiveGraph(store, PROJECT_ID);
  if (!active.ok) throw new Error(`active graph fixture refused: ${active.code}@${active.layer}`);
  return Object.freeze({
    subjectRef: active.graphContentHash,
    subjectRevision: active.graphEpoch,
  });
}

function approval(decisionRef: string): ApprovalDecisionRecord {
  return Object.freeze({ ...decidedApproval(), policyDecisionRef: decisionRef });
}

function requireLeg(
  store: SqliteEventStore,
  subject: PolicyRiskSubject,
  commandId: string,
  decisionRef: string,
): AcceptedRiskLeg {
  const input: PolicyRiskLegInput = Object.freeze({
    actionKind: POLICY_RISK_APPROVAL_ACTION,
    approval: approval(decisionRef),
    approvedBy: PRINCIPAL_ID,
    assessedAt: ASSESSED_AT,
    commandId,
    projectId: PROJECT_ID,
    subject,
  });
  const built = buildPolicyRiskLeg(store, input);
  if (!built.ok) throw new Error(`policy-risk fixture refused: ${built.code}@${built.layer}`);
  return built;
}

function seededActiveStore(): SqliteEventStore {
  const store = openEmptyFileStore();
  driveThrough(store, "approval.decide");
  seedActivationGraph(store);
  currentSubject(store);
  return store;
}

async function missingBefore(): Promise<unknown> {
  try {
    const store = seededActiveStore();
    return readPolicyRisk(store, PROJECT_ID, PRINCIPAL_ID, POLICY_RISK_APPROVAL_ACTION);
  } finally {
    closeStores();
  }
}

function qualifyingPayload(): JsonObject {
  return approvalPayload({
    record: {
      ...approvalRecord(SEALED_SUBMISSION_HASH),
      policyDecisionRef: DECISION_A,
    },
  }) as JsonObject;
}

function runtimeEnvelope(commandId: string): RuntimeCommandEnvelope {
  return {
    commandId,
    commandKind: "approval.decide",
    correlationId: `corr-${commandId}`,
    expectedVersion: 0,
    payload: qualifyingPayload(),
    requestDigest: REQUEST_DIGEST,
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: "credential-policy-risk-hostile",
    targetAggregateId: GOAL_ID,
  };
}

function dispatchQualifyingApproval(store: SqliteEventStore): DecisionPortResult {
  const commandId = "cmd-policy-risk-hostile-approval";
  const ports = createDaemonCommandPorts({
    clock: () => ASSESSED_AT,
    operatorPrincipalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
    store,
  });
  const entry = ports.registry.get("approval.decide");
  if (entry === undefined) throw new Error("approval.decide is absent from production registry");
  return ports.decisions.decide(
    { commandId, principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
    REQUEST_DIGEST,
    () => entry.handler({ envelope: runtimeEnvelope(commandId), principal: OPERATOR }),
  );
}

interface EnvValue { readonly exists: boolean; readonly value: string | undefined }

function envValue(key: string): EnvValue {
  return { exists: Object.hasOwn(process.env, key), value: process.env[key] };
}

function restoreEnv(key: string, prior: EnvValue): void {
  if (prior.exists && prior.value !== undefined) process.env[key] = prior.value;
  else delete process.env[key];
}

function requireHumanMode<T>(work: () => T): T {
  const mode = envValue(APPROVAL_MODE_ENV_KEY);
  const speed = envValue(SPEED_MODE_DELAY_ENV_KEY);
  process.env[APPROVAL_MODE_ENV_KEY] = "REQUIRE_HUMAN";
  delete process.env[SPEED_MODE_DELAY_ENV_KEY];
  try { return work(); } finally {
    restoreEnv(APPROVAL_MODE_ENV_KEY, mode);
    restoreEnv(SPEED_MODE_DELAY_ENV_KEY, speed);
  }
}

async function supersededAfter(): Promise<unknown> {
  return requireHumanMode(() => {
    try {
      const store = seededActiveStore();
      const subject = currentSubject(store);
      const outcome = dispatchQualifyingApproval(store);
      if (outcome.outcome !== "DECIDED") {
        throw new Error(`production approval refused: ${outcome.refusal.code}`);
      }
      const aggregateId = policyRiskAggregateIdFor({
        actionKind: POLICY_RISK_APPROVAL_ACTION, projectId: PROJECT_ID, subjectRef: subject.subjectRef,
      });
      const beforeMove = store.readEvents(aggregateId)
        .filter((event) => event.eventType === POLICY_RISK_EVENT_TYPE);
      if (beforeMove.length !== 1) throw new Error("registry writer did not write one risk event");
      const accepted = readPolicyRisk(store, PROJECT_ID, PRINCIPAL_ID, POLICY_RISK_APPROVAL_ACTION);
      if (!accepted.ok || accepted.factId !== DECISION_A || accepted.tier !== "R2"
        || accepted.truthClass !== "HUMAN_APPROVED")
        throw new Error("registry-written risk was not current before supersession");
      prepareSupersession(store);
      const moved = supersedeActiveGraph(
        supersedeContext(store, "cmd-policy-risk-hostile-supersede"),
        successorSupersedeInput(store),
      );
      if (!moved.ok) throw new Error(`production supersession refused: ${moved.code}`);
      return readPolicyRisk(store, PROJECT_ID, PRINCIPAL_ID, POLICY_RISK_APPROVAL_ACTION);
    } finally {
      closeStores();
    }
  });
}

function carrierPlan(side: "left" | "right"): CommitPlan {
  return Object.freeze({
    aggregateId: `policy-risk-hostile-carrier:${side}`,
    eventPayload: Object.freeze({ side }),
    eventType: "PolicyRiskHostileCarrierCommitted",
    expectedVersion: 0,
    result: Object.freeze({ side }),
  });
}

let lastRaceDurableAdmissions = -1;

async function versionRace(): Promise<readonly [unknown, unknown]> {
  lastRaceDurableAdmissions = -1;
  try {
    const store = openEmptyFileStore();
    const { a, b } = twoHandles(store);
    const subject = Object.freeze({ subjectRef: "a".repeat(64), subjectRevision: 1 });
    const left = requireLeg(a, subject, "cmd-policy-risk-race-left", DECISION_A);
    const right = requireLeg(b, subject, "cmd-policy-risk-race-right", DECISION_B);
    if (left.leg.expectedVersion !== 0 || right.leg.expectedVersion !== 0) {
      throw new Error("policy-risk race legs were not both built at version zero");
    }
    let winner: unknown;
    const loserStore = commitSeamFacade(a, () => {
      winner = asLayered(commitAcceptedLegs(
        b, requestFor("cmd-policy-risk-race-right"), carrierPlan("right"), [right.leg],
      ), "refusedBy");
    });
    const loser = asLayered(commitAcceptedLegs(
      loserStore, requestFor("cmd-policy-risk-race-left"), carrierPlan("left"), [left.leg],
    ), "refusedBy");
    if (winner === undefined) throw new Error("risk-leg winner did not run at the commit seam");
    lastRaceDurableAdmissions = a.readEvents(left.leg.aggregateId)
      .filter((event) => event.eventType === POLICY_RISK_EVENT_TYPE).length;
    return Object.freeze([winner, loser] as const);
  } finally {
    closeStores();
  }
}

export const POLICY_RISK_CASES: readonly HostileCase[] = Object.freeze([
  Object.freeze({
    constant: "POLICY_RISK_LAYER", arm: "BEFORE",
    name: "an active project with no risk row stays UNKNOWN",
    arranged: "DAEMON_POLICY_RISK",
    expected: Object.freeze({
      code: "POLICY_RISK_RECORD_MISSING", layer: "DAEMON_POLICY_RISK",
    }),
    run: missingBefore,
  }),
  // REVISION_STALE is unreachable through production today: a real supersession changes the
  // content hash as well as the epoch, so SUBJECT_STALE answers first. Reaching the later fence
  // would require a hand-seeded same-subject/different-epoch active record, which this lane bars.
  Object.freeze({
    constant: "POLICY_RISK_LAYER", arm: "AFTER",
    name: "real graph supersession invalidates registry-written risk authority",
    arranged: "DAEMON_POLICY_RISK",
    expected: Object.freeze({
      code: "POLICY_RISK_SUBJECT_STALE", layer: "DAEMON_POLICY_RISK",
    }),
    run: supersededAfter,
  }),
]);

export const POLICY_RISK_RACES: readonly HostileRaceCase[] = Object.freeze([
  Object.freeze({
    constant: "POLICY_RISK_LAYER",
    name: "divergent version-zero risk legs admit exactly one durable event",
    arranged: "DURABLE_STORE",
    expected: Object.freeze({ code: "EXPECTED_VERSION_CONFLICT", layer: "DURABLE_STORE" }),
    maxAdmitted: 1,
    run: versionRace,
    durableAdmissions: () => lastRaceDurableAdmissions,
  }),
]);
