import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  grantHumanAuthority,
  productContractGate1Authority,
  type ProductContractRevisionV2,
} from "@moe/core";
import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  type ProductContractGate1Authority,
  type ProductContractGate1AuthorityInput,
  runProductContractGate1Command,
} from "./product-contract-gate-1-command.js";
import {
  PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
  PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
} from "./product-contract-gate-1-contract.js";
import { resolveProductContractGate1V2 } from "./product-contract-v2-gate-1-resolver.js";
import { commitProductContractRevisionV2 } from "./product-contract-v2-store.js";

const PROJECT = "project-product-v2-gate-1";
const PRINCIPAL = "operator-product-v2-gate-1";
const DECIDED_AT = "2026-08-31T12:00:00.000Z";
const hex = (digit: string): string => digit.repeat(64);
const requirement = (requirementId: string, dependencies: readonly string[] = []) => ({
  dependsOnRequirementIds: [...dependencies], priority: "MUST" as const, requirementId,
  statement: `${requirementId} must hold.`, supersedesRequirementId: null,
});
const criterion = (criterionId: string, requirementId: string) => ({
  criterionId, requirementId, statement: `${criterionId} is observable.`,
  supersedesCriterionId: null, verification: `Verify ${criterionId}.`,
});
const CRITERIA = Object.freeze([
  "criterion-deployment", "criterion-keyboard", "criterion-latency",
  "criterion-login", "criterion-runtime", "criterion-session",
]);

function draft(revisionId: string, lineage: ProductContractRevisionV2["lineage"] = null) {
  return {
    assumptions: [{ assumptionId: "assumption-browser", statement: "A browser exists.",
      validationCriterionId: "criterion-runtime" }],
    authorRef: PRINCIPAL,
    budgets: [{ budgetId: "budget-delivery", kind: "TIME", limit: 30, unit: "days" }],
    contractId: "product-contract-v2-gate-1",
    criteria: [criterion("criterion-deployment", "deployment-loopback"),
      criterion("criterion-keyboard", "ux-keyboard"),
      criterion("criterion-latency", "nfr-latency"),
      criterion("criterion-login", "requirement-login"),
      criterion("criterion-runtime", "technology-runtime"),
      criterion("criterion-session", "security-session")],
    deploymentRequirements: [requirement("deployment-loopback", ["technology-runtime"])],
    functionalRequirements: [requirement("requirement-login")],
    journeys: [{ criterionIds: ["criterion-login", "criterion-session"],
      journeyId: "journey-login", statement: "A user signs in.", userJobId: "job-access" }],
    lineage,
    materialDecisions: [{ decisionId: "decision-stack", options: [
      { optionId: "option-next", statement: "Use Next.js." },
      { optionId: "option-rust", statement: "Use Axum." },
    ], question: "Which qualified profile?", selectedOptionId: "option-next" }],
    negativeScope: [{ scopeId: "scope-native", statement: "No native client." }],
    nonFunctionalRequirements: [requirement("nfr-latency", ["requirement-login"])],
    objectives: [{ objectiveId: "objective-adoption", statement: "Enable first use." }],
    productCompleteDefinition: { criterionIds: [...CRITERIA],
      statement: "Every criterion is independently verified." },
    retiredCriterionIds: [], retiredRequirementIds: [], revisionId,
    securityPrivacyRequirements: [requirement("security-session", ["requirement-login"])],
    sourceDocumentDigests: [hex("a")],
    successMetrics: [{ measurement: "Count successful sessions.", metricId: "metric-first-use",
      objectiveIds: ["objective-adoption"], statement: "Users finish.", target: "80 percent." }],
    technologyRequirements: [requirement("technology-runtime")],
    userJobs: [{ job: "Reach the product.", user: "Operator", userJobId: "job-access" }],
    uxAccessibilityRequirements: [requirement("ux-keyboard", ["requirement-login"])],
  };
}

function withStore<T>(run: (store: SqliteEventStore) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "moe-product-contract-v2-gate-1-"));
  const store = SqliteEventStore.openForProject(join(directory, "store.db"), PROJECT);
  try { return run(store); }
  finally { store.close(); rmSync(directory, { force: true, recursive: true }); }
}

function commit(store: SqliteEventStore, value: unknown): ProductContractRevisionV2 {
  const outcome = commitProductContractRevisionV2(store, {
    correlationId: "correlation-product-v2-gate-1", decidedAt: DECIDED_AT,
    draft: value, principalId: PRINCIPAL, projectId: PROJECT,
  });
  if (!outcome.ok) throw new Error(`${outcome.code}@${outcome.layer}`);
  return outcome.revision;
}

const TEST_HUMAN_AUTHORITY: ProductContractGate1Authority = Object.freeze({
  authorize: (input: ProductContractGate1AuthorityInput) => {
    const granted = grantHumanAuthority(
      productContractGate1Authority(input.ref),
      { kind: "HUMAN", principalId: PRINCIPAL },
      input.grantedAtEpochMs,
    );
    if (!granted.ok) throw new Error(`${granted.code}@${granted.layer}`);
    return Object.freeze({ gate: granted.gate, ok: true as const });
  },
});

function approve(store: SqliteEventStore, revision: ProductContractRevisionV2): void {
  const commandId = `approve-${revision.revisionId}`;
  const outcome = runProductContractGate1Command(store, new TextEncoder().encode(JSON.stringify({
    commandId,
    correlationId: `correlation-${commandId}`,
    decidedAt: DECIDED_AT,
    expectedVersion: 0,
    kind: PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
    payload: {
      authentication: { kind: "TEST_ONLY_NON_BEARER" },
      contractId: revision.contractId,
      revisionDigest: revision.revisionDigest,
      revisionId: revision.revisionId,
    },
    principalId: PRINCIPAL,
    projectId: PROJECT,
    schemaVersion: PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
  })), TEST_HUMAN_AUTHORITY, {
    sessionId: "test-only-session", transportOrigin: "MCP_STDIO",
  });
  if (!outcome.ok) throw new Error(`${outcome.code}@${outcome.refusedBy}`);
}

const refOf = (revision: ProductContractRevisionV2) => Object.freeze({
  contractId: revision.contractId,
  revisionDigest: revision.revisionDigest,
  revisionId: revision.revisionId,
});

describe("Product Contract /2 Gate 1 resolver", () => {
  it("validates a durable approval against the exact durable current /2 revision", () =>
    withStore((store) => {
      const revision = commit(store, draft("revision-v2-gate-1-first"));
      approve(store, revision);

      expect(resolveProductContractGate1V2(store, {
        projectId: PROJECT, ref: refOf(revision),
      })).toEqual({
        advisoryOnly: true, gate: "GATE_1", ok: true,
        revisionDigest: revision.revisionDigest,
      });
    }));

  it("refuses a stale approved predecessor before it can authorize current planning", () =>
    withStore((store) => {
      const first = commit(store, draft("revision-v2-gate-1-first"));
      approve(store, first);
      const current = commit(store, draft("revision-v2-gate-1-current", {
        parentRevisionDigest: first.revisionDigest, parentRevisionId: first.revisionId,
      }));

      expect(resolveProductContractGate1V2(store, {
        projectId: PROJECT, ref: refOf(first),
      })).toEqual({
        code: "PRODUCT_CONTRACT_V2_GATE_1_CURRENT_MISMATCH",
        layer: "PRODUCT_CONTRACT_V2_GATE_1_RESOLVER",
        ok: false,
      });
      expect(current.revisionDigest).not.toBe(first.revisionDigest);
    }));

  it("forwards the durable approval reader refusal unchanged", () => withStore((store) => {
    const revision = commit(store, draft("revision-v2-gate-1-unapproved"));
    expect(resolveProductContractGate1V2(store, {
      projectId: PROJECT, ref: refOf(revision),
    })).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_APPROVAL_ABSENT",
      layer: "PRODUCT_CONTRACT_GATE_1_READER",
      ok: false,
    });
  }));

  it("forwards an absent durable current slot at the /2 reader layer", () =>
    withStore((store) => {
      expect(resolveProductContractGate1V2(store, {
        projectId: PROJECT,
        ref: { contractId: "absent-contract", revisionDigest: hex("b"),
          revisionId: "absent-revision" },
      })).toEqual({
        code: "PRODUCT_CONTRACT_V2_CURRENT_SLOT_ABSENT",
        layer: "PRODUCT_CONTRACT_V2_REVISION_READER",
        ok: false,
      });
    }));
});
