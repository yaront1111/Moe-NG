import { createHash } from "node:crypto";

import { CAPABILITY_CATALOG_LIMITS } from "@moe/core";
import { DurableStoreError, SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  createPlannerAdmissionProfileRevision,
  encodePlannerAdmissionProfileRevision,
} from "../planning/v2-compiler/planner-admission-profile-codec.js";
import { PLANNER_ADMISSION_PROFILE_VERSION } from
  "../planning/v2-compiler/planner-admission-profile-contract.js";
import type { DeliveryV2AppendContext } from "./contracts.js";
import {
  DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_ADDRESS_DOMAIN,
  DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_COMMAND_KIND,
  DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_EVENT_ID_DOMAIN,
  DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_EVENT_TYPE,
  appendDeliveryV2PlannerAdmissionProfileRevision,
  deriveDeliveryV2PlannerAdmissionProfileRevisionAggregateId,
  deriveDeliveryV2PlannerAdmissionProfileRevisionEventId,
} from "./planner-admission-profile-persistence.js";

const PROJECT = "project-planner-admission-profile";
const PRINCIPAL = "principal:planner-admission-profile-publisher";
const PURPOSES = Object.freeze([
  "CONTINGENCY", "EXECUTION", "FINAL_ACCEPTANCE", "INDEPENDENT_REVIEW", "VERIFICATION",
] as const);
const hex = (digit: string): string => digit.repeat(64);

function draft(overrides: Record<string, unknown> = {}) {
  return {
    admissionGatePolicy: "POLICY_ALLOWANCE",
    allocationDecisionRef: "allocation-decision:build-r1",
    allocationSemantics: "SINGLE_ADMISSION_FULL_ENVELOPE",
    authorRef: PRINCIPAL,
    authorityKind: "BUILDER",
    budgetAllocations: [{
      conversion: {
        authorityRef: "conversion-authority:seconds-to-runner-ms-r1",
        denominator: 1,
        numerator: 1_000,
        targetMeter: "runner.authorized_ms",
      },
      purposeQuantities: PURPOSES.map((purpose) => ({ purpose, quantity: 3_000 })),
      sourceBudget: { budgetId: "budget-time-a", kind: "TIME", limit: 15, unit: "seconds" },
    }],
    budgetBindingDigest: `moe.v2.budget-bindings.sha256:${hex("b")}`,
    contractBinding: {
      contractId: "contract-v2", revisionDigest: hex("a"), revisionId: "contract-v2-r1",
    },
    graphId: "graph-v2-r1",
    graphSnapshotIdentity: hex("c"),
    nodeIntentDigest: hex("d"),
    nodeKey: "node-build",
    policyRevision: hex("e"),
    profileId: "planner-admission-profile-build",
    revisionId: "planner-admission-profile-build-r1",
    ...overrides,
  };
}

function created(value: unknown = draft()) {
  const result = createPlannerAdmissionProfileRevision(value);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.revision;
}

function bytesOf(revision = created()): Uint8Array {
  const result = encodePlannerAdmissionProfileRevision(revision);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.bytes;
}

function context(commandId: string, expectedVersion = 0): DeliveryV2AppendContext {
  return Object.freeze({
    commandId,
    correlationId: `correlation:${commandId}`,
    decidedAt: "2026-09-01T10:00:00.000Z",
    expectedVersion,
    principalId: PRINCIPAL,
    projectId: PROJECT,
  });
}

function framedDigest(domain: string, ...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of [domain, ...parts]) {
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length).update(bytes);
  }
  return hash.digest("hex");
}

const expectedAggregateId = (projectId: string, revisionDigest: string): string =>
  `delivery-v2:planner-admission-profile-revision:${framedDigest(
    DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_ADDRESS_DOMAIN,
    projectId,
    revisionDigest,
  )}`;

const expectedEventId = (projectId: string, principalId: string, commandId: string): string =>
  `delivery-v2:planner-admission-profile-revision-event:${framedDigest(
    DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_EVENT_ID_DOMAIN,
    projectId,
    principalId,
    commandId,
  )}`;

describe("delivery-v2 PlannerAdmissionProfileRevision persistence", () => {
  it("commits and replays one canonical inert revision effect", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const revision = created();
    const bytes = bytesOf(revision);
    const request = context("planner-profile-commit-1");
    const aggregateId = expectedAggregateId(PROJECT, revision.revisionDigest);
    const eventId = expectedEventId(PROJECT, PRINCIPAL, request.commandId);

    expect(DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_COMMAND_KIND)
      .toBe("delivery_v2.planner_admission_profile_revision.commit");
    expect(DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_EVENT_TYPE)
      .toBe("DeliveryV2PlannerAdmissionProfileRevisionCommitted");
    expect(deriveDeliveryV2PlannerAdmissionProfileRevisionAggregateId(
      PROJECT, revision.revisionDigest,
    )).toBe(aggregateId);
    expect(deriveDeliveryV2PlannerAdmissionProfileRevisionEventId(
      PROJECT, PRINCIPAL, request.commandId,
    )).toBe(eventId);

    expect(appendDeliveryV2PlannerAdmissionProfileRevision(store, request, draft()))
      .toStrictEqual({
        bytes,
        disposition: "DECIDED",
        ok: true,
        ref: {
          profileId: revision.profileId,
          projectId: PROJECT,
          revisionDigest: revision.revisionDigest,
          revisionId: revision.revisionId,
        },
        revision,
      });
    expect(appendDeliveryV2PlannerAdmissionProfileRevision(store, {
      ...request,
      correlationId: "correlation:retry-proposal",
      decidedAt: "2026-09-01T11:00:00.000Z",
    }, draft())).toMatchObject({ disposition: "REPLAYED", ok: true });

    const page = store.readAggregateEvents(aggregateId, 0, 2);
    expect(page.hasMore).toBe(false);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      aggregateId,
      aggregateSequence: 1,
      domainSchemaVersion: PLANNER_ADMISSION_PROFILE_VERSION,
      eventId,
      eventType: DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_EVENT_TYPE,
      payload: bytes,
    });
    const decision = store.getCommandDecision({
      commandId: request.commandId, principalId: PRINCIPAL, projectId: PROJECT,
    });
    expect(decision?.resultBytes).toStrictEqual(bytes);
    expect(decision?.businessEventIds).toStrictEqual([eventId]);
  });

  it("scopes fixed-size event identity by project, publisher, and raw command id", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const commandId = "c".repeat(CAPABILITY_CATALOG_LIMITS.maxIdBytes);
    const otherPrincipal = "principal:planner-admission-profile-publisher-two";
    const secondDraft = draft({
      profileId: "planner-admission-profile-verify",
      revisionId: "planner-admission-profile-verify-r1",
    });
    const first = created();
    const second = created(secondDraft);

    expect(appendDeliveryV2PlannerAdmissionProfileRevision(
      store, { ...context(commandId), correlationId: "correlation:max-command" }, draft(),
    )).toMatchObject({ disposition: "DECIDED", ok: true });
    expect(appendDeliveryV2PlannerAdmissionProfileRevision(store, {
      ...context(commandId),
      correlationId: "correlation:second-publisher",
      principalId: otherPrincipal,
    }, secondDraft)).toMatchObject({ disposition: "DECIDED", ok: true });

    const firstEvent = store.readAggregateEvents(deriveDeliveryV2PlannerAdmissionProfileRevisionAggregateId(
      PROJECT, first.revisionDigest,
    ), 0, 2).items[0];
    const secondEvent = store.readAggregateEvents(deriveDeliveryV2PlannerAdmissionProfileRevisionAggregateId(
      PROJECT, second.revisionDigest,
    ), 0, 2).items[0];
    expect(firstEvent?.eventId).toBe(expectedEventId(PROJECT, PRINCIPAL, commandId));
    expect(secondEvent?.eventId).toBe(expectedEventId(PROJECT, otherPrincipal, commandId));
    expect(firstEvent?.eventId).not.toBe(secondEvent?.eventId);
    expect(Buffer.byteLength(firstEvent?.eventId ?? "", "utf8")).toBeLessThanOrEqual(512);
  });

  it("refuses changed canonical bytes under the same scoped command without residue", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const request = context("planner-profile-idempotency");
    const first = created();
    const changedDraft = draft({ revisionId: "planner-admission-profile-build-r2" });
    const changed = created(changedDraft);
    expect(appendDeliveryV2PlannerAdmissionProfileRevision(store, request, draft()))
      .toMatchObject({ disposition: "DECIDED", ok: true });
    expect(appendDeliveryV2PlannerAdmissionProfileRevision(store, request, changedDraft))
      .toStrictEqual({ code: "IDEMPOTENCY_CONFLICT", layer: "DURABLE_STORE", ok: false });
    expect(store.readAggregateEvents(deriveDeliveryV2PlannerAdmissionProfileRevisionAggregateId(
      PROJECT, first.revisionDigest,
    ), 0, 2).items).toHaveLength(1);
    expect(store.readAggregateEvents(deriveDeliveryV2PlannerAdmissionProfileRevisionAggregateId(
      PROJECT, changed.revisionDigest,
    ), 0, 2).items).toHaveLength(0);
    expect(store.readCommandDecisionsAfter(0n, 10).items).toHaveLength(1);
  });

  it("preserves profile-codec refusals and writes nothing", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    expect(appendDeliveryV2PlannerAdmissionProfileRevision(
      store, context("malformed-profile"), draft({ policyRevision: "not-a-digest" }),
    )).toStrictEqual({
      code: "PLANNER_ADMISSION_PROFILE_MALFORMED",
      layer: "PLANNER_ADMISSION_PROFILE_ADMISSION",
      ok: false,
    });
    expect(appendDeliveryV2PlannerAdmissionProfileRevision(
      store, context("full-revision"), created(),
    )).toStrictEqual({
      code: "PLANNER_ADMISSION_PROFILE_MALFORMED",
      layer: "PLANNER_ADMISSION_PROFILE_ADMISSION",
      ok: false,
    });
    expect(store.readCommandDecisionsAfter(0n, 10).items).toHaveLength(0);
  });

  it("requires expectedVersion zero and a valid publisher/context before codec work", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const expected = {
      code: "DELIVERY_V2_INPUT_INVALID",
      layer: "DAEMON_DELIVERY_V2_PERSISTENCE",
      ok: false,
    } as const;
    const cases = [
      { ...context("nonzero", 1) },
      { ...context("negative-zero"), expectedVersion: -0 },
      { ...context("empty-publisher"), principalId: "" },
      { ...context("nul-publisher"), principalId: "principal\0publisher" },
      { ...context("ill-formed-publisher"), principalId: "\ud800" },
      { ...context("overbound-publisher"), principalId: "p".repeat(513) },
      { ...context("overbound-command"), commandId: "c".repeat(513) },
      { ...context("invalid-time"), decidedAt: "2026-09-01" },
      { ...context("extra-context"), extra: true } as never,
    ];
    for (const candidate of cases) {
      expect(appendDeliveryV2PlannerAdmissionProfileRevision(store, candidate, draft()))
        .toStrictEqual(expected);
    }
    expect(store.readCommandDecisionsAfter(0n, 10).items).toHaveLength(0);
  });

  it("preserves aggregate conflicts and durable-store failures", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    expect(appendDeliveryV2PlannerAdmissionProfileRevision(store, context("first"), draft()))
      .toMatchObject({ disposition: "DECIDED", ok: true });
    expect(appendDeliveryV2PlannerAdmissionProfileRevision(store, context("second"), draft()))
      .toStrictEqual({
        code: "EXPECTED_VERSION_CONFLICT", layer: "DURABLE_STORE", ok: false,
      });
    const closed = Object.freeze({
      commitExpectedVersionDecisionLegs: () => {
        throw new DurableStoreError("STORE_CLOSED", "closed by test");
      },
    }) as unknown as SqliteEventStore;
    expect(appendDeliveryV2PlannerAdmissionProfileRevision(closed, context("closed"), draft()))
      .toStrictEqual({ code: "STORE_CLOSED", layer: "DURABLE_STORE", ok: false });
  });

  it("refuses fabricated disposition, event cardinality, and submitted context", () => {
    const dispositionUnderlying = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const disposition = Object.freeze({
      commitExpectedVersionDecisionLegs: (
        input: Parameters<SqliteEventStore["commitExpectedVersionDecisionLegs"]>[0],
      ) => Object.freeze({
        ...dispositionUnderlying.commitExpectedVersionDecisionLegs(input),
        disposition: "COMMITTED",
      }),
      getCommandDecision: dispositionUnderlying.getCommandDecision.bind(dispositionUnderlying),
      getCommandReceipt: dispositionUnderlying.getCommandReceipt.bind(dispositionUnderlying),
      readAggregateEvents: dispositionUnderlying.readAggregateEvents.bind(dispositionUnderlying),
    }) as unknown as SqliteEventStore;
    expect(appendDeliveryV2PlannerAdmissionProfileRevision(
      disposition, context("fabricated-disposition"), draft(),
    )).toStrictEqual({
      code: "DELIVERY_V2_MATERIAL_UNREADABLE",
      layer: "DAEMON_DELIVERY_V2_PERSISTENCE",
      ok: false,
    });

    const underlying = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const fabricated = Object.freeze({
      commitExpectedVersionDecisionLegs: (
        input: Parameters<SqliteEventStore["commitExpectedVersionDecisionLegs"]>[0],
      ) => underlying.commitExpectedVersionDecisionLegs({
        ...input,
        correlationId: "correlation:substituted",
        decidedAt: "2026-09-01T12:00:00.000Z",
      }),
      getCommandDecision: underlying.getCommandDecision.bind(underlying),
      getCommandReceipt: underlying.getCommandReceipt.bind(underlying),
      readAggregateEvents: underlying.readAggregateEvents.bind(underlying),
    }) as unknown as SqliteEventStore;
    expect(appendDeliveryV2PlannerAdmissionProfileRevision(
      fabricated, context("fabricated-context"), draft(),
    )).toStrictEqual({
      code: "DELIVERY_V2_MATERIAL_UNREADABLE",
      layer: "DAEMON_DELIVERY_V2_PERSISTENCE",
      ok: false,
    });

    const extraUnderlying = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const extra = Object.freeze({
      commitExpectedVersionDecisionLegs:
        extraUnderlying.commitExpectedVersionDecisionLegs.bind(extraUnderlying),
      getCommandDecision: extraUnderlying.getCommandDecision.bind(extraUnderlying),
      getCommandReceipt: extraUnderlying.getCommandReceipt.bind(extraUnderlying),
      readAggregateEvents: (...args: Parameters<SqliteEventStore["readAggregateEvents"]>) => {
        const page = extraUnderlying.readAggregateEvents(...args);
        const first = page.items[0];
        return first === undefined ? page : Object.freeze({
          ...page,
          items: Object.freeze([first, Object.freeze({
            ...first, aggregateSequence: 2, eventId: `${first.eventId}:extra`,
          })]),
        });
      },
    }) as unknown as SqliteEventStore;
    expect(appendDeliveryV2PlannerAdmissionProfileRevision(
      extra, context("fabricated-extra"), draft(),
    )).toStrictEqual({
      code: "DELIVERY_V2_MATERIAL_UNREADABLE",
      layer: "DAEMON_DELIVERY_V2_PERSISTENCE",
      ok: false,
    });
  });

  it("detaches returned bytes and never claims current or allocation authority", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const mutable = draft();
    const result = appendDeliveryV2PlannerAdmissionProfileRevision(
      store, context("detached"), mutable,
    );
    mutable.revisionId = "mutated-after-call";
    expect(result).toMatchObject({ disposition: "DECIDED", ok: true });
    if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
    expect(Object.keys(result).sort()).toStrictEqual([
      "bytes", "disposition", "ok", "ref", "revision",
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.ref)).toBe(true);
    expect(Object.isFrozen(result.revision)).toBe(true);
    result.bytes[0] = 0;
    const event = store.readAggregateEvents(deriveDeliveryV2PlannerAdmissionProfileRevisionAggregateId(
      PROJECT, result.ref.revisionDigest,
    ), 0, 2).items[0];
    expect(event?.payload).toStrictEqual(bytesOf());
    expect(new TextDecoder().decode(event?.payload)).not.toContain("mutated-after-call");
  });
});
