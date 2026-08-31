import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_VERSION,
  PRODUCT_CONTRACT_V2_VERSION,
  createProductContractCurrentRevisionSlotV2,
  createProductContractRevisionV2,
  encodeProductContractCurrentRevisionSlotV2,
  encodeProductContractRevisionV2,
  type ProductContractRevisionV2,
} from "@moe/core";
import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  commitProductContractRevisionV2,
  deriveProductContractCurrentRevisionSlotV2AggregateId,
  deriveProductContractRevisionV2AggregateId,
} from "./product-contract-v2-store.js";
import {
  PRODUCT_CONTRACT_CURRENT_SLOT_V2_EVENT_TYPE,
  PRODUCT_CONTRACT_REVISION_V2_EVENT_TYPE,
  readCurrentProductContractRevisionV2,
} from "./product-contract-v2-reader.js";

const PROJECT = "project-product-v2";
const PRINCIPAL = "operator-product-v2";
const hex = (digit: string): string => digit.repeat(64);
const requirement = (requirementId: string, dependencies: readonly string[] = []) => ({
  dependsOnRequirementIds: [...dependencies], priority: "MUST" as const, requirementId,
  statement: `${requirementId} must hold.`, supersedesRequirementId: null,
});
const criterion = (criterionId: string, requirementId: string) => ({
  criterionId, requirementId, statement: `${criterionId} is observable.`,
  supersedesCriterionId: null, verification: `Run deterministic ${criterionId} verification.`,
});
const CRITERIA = Object.freeze([
  "criterion-deployment", "criterion-keyboard", "criterion-latency",
  "criterion-login", "criterion-runtime", "criterion-session",
]);

function draft(): Record<string, unknown> {
  return {
    assumptions: [{ assumptionId: "assumption-browser", statement: "A browser exists.",
      validationCriterionId: "criterion-runtime" }],
    authorRef: PRINCIPAL,
    budgets: [{ budgetId: "budget-delivery", kind: "TIME", limit: 30, unit: "days" }],
    contractId: "product-contract-v2-a",
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
    lineage: null,
    materialDecisions: [{ decisionId: "decision-stack", options: [
      { optionId: "option-next", statement: "Use Next.js." },
      { optionId: "option-rust", statement: "Use Axum." },
    ], question: "Which qualified profile?", selectedOptionId: "option-next" }],
    negativeScope: [{ scopeId: "scope-native", statement: "No native client." }],
    nonFunctionalRequirements: [requirement("nfr-latency", ["requirement-login"])],
    objectives: [{ objectiveId: "objective-adoption", statement: "Enable first use." }],
    productCompleteDefinition: { criterionIds: [...CRITERIA],
      statement: "Every criterion is independently verified." },
    retiredCriterionIds: [], retiredRequirementIds: [], revisionId: "revision-v2-1",
    securityPrivacyRequirements: [requirement("security-session", ["requirement-login"])],
    sourceDocumentDigests: [hex("a")],
    successMetrics: [{ measurement: "Count successful sessions.", metricId: "metric-first-use",
      objectiveIds: ["objective-adoption"], statement: "Users finish.", target: "80 percent." }],
    technologyRequirements: [requirement("technology-runtime")],
    userJobs: [{ job: "Reach the product.", user: "Operator", userJobId: "job-access" }],
    uxAccessibilityRequirements: [requirement("ux-keyboard", ["requirement-login"])],
  };
}

function successor(current: ProductContractRevisionV2): Record<string, unknown> {
  return {
    ...draft(),
    lineage: { parentRevisionDigest: current.revisionDigest,
      parentRevisionId: current.revisionId },
    objectives: [{ objectiveId: "objective-adoption", statement: "Enable proven first use." }],
    revisionId: "revision-v2-2",
  };
}

function withStore<T>(run: (store: SqliteEventStore) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "moe-product-contract-v2-"));
  const store = SqliteEventStore.openForProject(join(directory, "store.db"), PROJECT);
  try { return run(store); }
  finally { store.close(); rmSync(directory, { force: true, recursive: true }); }
}

function commit(store: SqliteEventStore, value: unknown) {
  return commitProductContractRevisionV2(store, {
    correlationId: "correlation-product-v2", decidedAt: "2026-08-31T00:00:00.000Z",
    draft: value, principalId: PRINCIPAL, projectId: PROJECT,
  });
}

describe("durable ProductContractRevision /2 current slot", () => {
  it("atomically commits the exact first revision and generation-one slot", () =>
    withStore((store) => {
      const result = commit(store, draft());
      expect(result).toMatchObject({ disposition: "DECIDED", ok: true });
      if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
      expect(result.slot.generation).toBe(1);
      const revisionEvents = store.readEvents(deriveProductContractRevisionV2AggregateId(
        PROJECT, result.revision.contractId, result.revision.revisionId,
      ));
      const slotEvents = store.readEvents(deriveProductContractCurrentRevisionSlotV2AggregateId(
        PROJECT, result.revision.contractId,
      ));
      expect(revisionEvents).toHaveLength(1);
      expect(slotEvents).toHaveLength(1);
      const revisionBytes = encodeProductContractRevisionV2(result.revision);
      const slotBytes = encodeProductContractCurrentRevisionSlotV2(result.slot);
      if (!revisionBytes.ok || !slotBytes.ok) throw new Error("committed result did not encode");
      expect(revisionEvents[0]?.payload).toEqual(revisionBytes.bytes);
      expect(slotEvents[0]?.payload).toEqual(slotBytes.bytes);
      expect(readCurrentProductContractRevisionV2(store, {
        contractId: result.revision.contractId, projectId: PROJECT,
      })).toEqual({ ok: true, revision: result.revision, slot: result.slot });
    }));

  it("advances a valid successor and retains exact bounded history", () => withStore((store) => {
    const first = commit(store, draft());
    if (!first.ok) throw new Error(`${first.code}@${first.layer}`);
    const second = commit(store, successor(first.revision));
    expect(second).toMatchObject({ disposition: "DECIDED", ok: true });
    if (!second.ok) throw new Error(`${second.code}@${second.layer}`);
    expect(second.slot.generation).toBe(2);
    expect(second.slot.revisionHistory).toEqual([first.slot.currentRevision]);
    expect(readCurrentProductContractRevisionV2(store, {
      contractId: second.revision.contractId, projectId: PROJECT,
    })).toEqual({ ok: true, revision: second.revision, slot: second.slot });
  }));

  it("replays identical candidate bytes without adding revision or slot events", () =>
    withStore((store) => {
      const first = commit(store, draft());
      expect(first).toMatchObject({ disposition: "DECIDED", ok: true });
      const replay = commit(store, draft());
      expect(replay).toMatchObject({ disposition: "REPLAYED", ok: true });
      if (!replay.ok) throw new Error(`${replay.code}@${replay.layer}`);
      expect(store.readEvents(deriveProductContractRevisionV2AggregateId(
        PROJECT, replay.revision.contractId, replay.revision.revisionId,
      ))).toHaveLength(1);
      expect(store.readEvents(deriveProductContractCurrentRevisionSlotV2AggregateId(
        PROJECT, replay.revision.contractId,
      ))).toHaveLength(1);
    }));

  it("replays an immutable predecessor after the current slot advances", () =>
    withStore((store) => {
      const first = commit(store, draft());
      if (!first.ok) throw new Error(`${first.code}@${first.layer}`);
      const second = commit(store, successor(first.revision));
      if (!second.ok) throw new Error(`${second.code}@${second.layer}`);

      const replay = commit(store, draft());

      expect(replay).toMatchObject({ disposition: "REPLAYED", ok: true });
      if (!replay.ok) throw new Error(`${replay.code}@${replay.layer}`);
      expect(replay.revision).toEqual(first.revision);
      expect(replay.slot).toEqual(first.slot);
      expect(store.readEvents(deriveProductContractRevisionV2AggregateId(
        PROJECT, first.revision.contractId, first.revision.revisionId,
      ))).toHaveLength(1);
      expect(store.readEvents(deriveProductContractCurrentRevisionSlotV2AggregateId(
        PROJECT, first.revision.contractId,
      ))).toHaveLength(2);
      expect(readCurrentProductContractRevisionV2(store, {
        contractId: first.revision.contractId, projectId: PROJECT,
      })).toEqual({ ok: true, revision: second.revision, slot: second.slot });
    }));

  it("refuses divergent bytes under a predecessor command identity", () =>
    withStore((store) => {
      const first = commit(store, draft());
      if (!first.ok) throw new Error(`${first.code}@${first.layer}`);
      const second = commit(store, successor(first.revision));
      if (!second.ok) throw new Error(`${second.code}@${second.layer}`);
      const divergent = draft();
      divergent["objectives"] = [{ objectiveId: "objective-adoption",
        statement: "Divergent bytes must not borrow prior authority." }];

      expect(commit(store, divergent)).toEqual({
        code: "COMMAND_ID_CONFLICT", layer: "DURABLE_STORE", ok: false,
      });
      expect(readCurrentProductContractRevisionV2(store, {
        contractId: first.revision.contractId, projectId: PROJECT,
      })).toEqual({ ok: true, revision: second.revision, slot: second.slot });
    }));

  it("refuses absence at the v2 reader instead of consulting /1 history", () =>
    withStore((store) => {
      expect(readCurrentProductContractRevisionV2(store, {
        contractId: "missing-contract", projectId: PROJECT,
      })).toEqual({
        code: "PRODUCT_CONTRACT_V2_CURRENT_SLOT_ABSENT",
        layer: "PRODUCT_CONTRACT_V2_REVISION_READER",
        ok: false,
      });
    }));

  it("reads current authority through bounded aggregate pages", () =>
    withStore((store) => {
      const committed = commit(store, draft());
      if (!committed.ok) throw new Error(`${committed.code}@${committed.layer}`);
      let pageReads = 0;
      const pagedOnly = new Proxy(store, { get(target, key) {
        if (key === "readEvents") return () => { throw new Error("whole-stream read forbidden"); };
        if (key === "readAggregateEvents") {
          return (...args: Parameters<SqliteEventStore["readAggregateEvents"]>) => {
            pageReads += 1;
            return target.readAggregateEvents(...args);
          };
        }
        const member = Reflect.get(target, key, target) as unknown;
        return typeof member === "function" ? member.bind(target) : member;
      } });

      expect(readCurrentProductContractRevisionV2(pagedOnly, {
        contractId: committed.revision.contractId, projectId: PROJECT,
      })).toEqual({ ok: true, revision: committed.revision, slot: committed.slot });
      expect(pageReads).toBe(2);
    }));

  it("refuses canonical v2 events written without the atomic decision authority", () =>
    withStore((store) => {
      const created = createProductContractRevisionV2(draft());
      if (!created.ok) throw new Error(`${created.code}@${created.layer}`);
      const slot = createProductContractCurrentRevisionSlotV2(PROJECT, created.revision);
      if (!slot.ok) throw new Error(`${slot.code}@${slot.layer}`);
      const revisionBytes = encodeProductContractRevisionV2(created.revision);
      const slotBytes = encodeProductContractCurrentRevisionSlotV2(slot.slot);
      if (!revisionBytes.ok || !slotBytes.ok) throw new Error("v2 bytes did not encode");
      store.commit({
        aggregateId: deriveProductContractRevisionV2AggregateId(
          PROJECT, created.revision.contractId, created.revision.revisionId,
        ),
        commandBytes: revisionBytes.bytes, commandId: "forged-v2-revision",
        committedAt: "2026-08-31T00:00:00.000Z", expectedVersion: 0,
        events: [{ domainSchemaVersion: PRODUCT_CONTRACT_V2_VERSION,
          eventId: "forged-v2-revision-event", eventType: PRODUCT_CONTRACT_REVISION_V2_EVENT_TYPE,
          payload: revisionBytes.bytes }],
      });
      store.commit({
        aggregateId: deriveProductContractCurrentRevisionSlotV2AggregateId(
          PROJECT, created.revision.contractId,
        ),
        commandBytes: slotBytes.bytes, commandId: "forged-v2-slot",
        committedAt: "2026-08-31T00:00:00.000Z", expectedVersion: 0,
        events: [{ domainSchemaVersion: PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_VERSION,
          eventId: "forged-v2-slot-event", eventType: PRODUCT_CONTRACT_CURRENT_SLOT_V2_EVENT_TYPE,
          payload: slotBytes.bytes }],
      });

      expect(readCurrentProductContractRevisionV2(store, {
        contractId: created.revision.contractId, projectId: PROJECT,
      })).toEqual({
        code: "PRODUCT_CONTRACT_V2_PROVENANCE_ABSENT",
        layer: "PRODUCT_CONTRACT_V2_REVISION_READER",
        ok: false,
      });
    }));

  it.each([
    ["decision", "PRODUCT_CONTRACT_V2_DECISION_UNRESOLVED"],
    ["receipt", "PRODUCT_CONTRACT_V2_RECEIPT_UNBOUND"],
  ] as const)("refuses a valid event stream with an unresolved %s", (hidden, code) =>
    withStore((store) => {
      const committed = commit(store, draft());
      if (!committed.ok) throw new Error(`${committed.code}@${committed.layer}`);
      const incomplete = new Proxy(store, { get(target, key) {
        if (hidden === "decision" && key === "getCommandDecision") return () => null;
        if (hidden === "receipt" && key === "getCommandReceipt") return () => null;
        const member = Reflect.get(target, key, target) as unknown;
        return typeof member === "function" ? member.bind(target) : member;
      } });

      expect(readCurrentProductContractRevisionV2(incomplete, {
        contractId: committed.revision.contractId, projectId: PROJECT,
      })).toEqual({ code, layer: "PRODUCT_CONTRACT_V2_REVISION_READER", ok: false });
    }));

  it("loses a slot-version race without orphaning the candidate revision", () =>
    withStore((store) => {
      const candidate = draft();
      const contractId = candidate["contractId"] as string;
      const slotAggregateId = deriveProductContractCurrentRevisionSlotV2AggregateId(
        PROJECT, contractId,
      );
      let injected = false;
      const raced = new Proxy(store, { get(target, key) {
        if (key === "commitExpectedVersionDecisionLegs") {
          return (value: Parameters<SqliteEventStore["commitExpectedVersionDecisionLegs"]>[0]) => {
            if (!injected) {
              injected = true;
              target.commit({
                aggregateId: slotAggregateId,
                commandBytes: new TextEncoder().encode("slot-race"),
                commandId: "slot-race-command",
                committedAt: "2026-08-31T00:00:00.000Z",
                events: [{ eventId: "slot-race-event", eventType: "HostileSlotRace",
                  payload: new Uint8Array([1]) }],
                expectedVersion: 0,
              });
            }
            return target.commitExpectedVersionDecisionLegs(value);
          };
        }
        const member = Reflect.get(target, key, target) as unknown;
        return typeof member === "function" ? member.bind(target) : member;
      } });
      expect(commit(raced, candidate)).toEqual({
        code: "EXPECTED_VERSION_CONFLICT", layer: "DURABLE_STORE", ok: false,
      });
      expect(store.readEvents(slotAggregateId).map((event) => event.eventType))
        .toEqual(["HostileSlotRace"]);
      expect(store.readEvents(deriveProductContractRevisionV2AggregateId(
        PROJECT, contractId, candidate["revisionId"] as string,
      ))).toEqual([]);
    }));
});
