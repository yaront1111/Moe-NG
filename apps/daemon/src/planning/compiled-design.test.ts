import { afterEach, expect, it } from "vitest";
import { readDesignRevision, submitDesignRevision } from "../design/design-store.js";
import { designRevisionFixture, secondDesignRevisionFixture } from "../design/design-test-fixtures.js";
import { approveGate1, boundWorld, closeStores, committedRevision, GOAL_ID, PROJECT_ID, submit }
  from "./plan-reject-test-fixtures.js";
import { decodeCompiledContractBinding, readCompiledContractBinding } from "./compiled-contract-binding.js";

afterEach(closeStores);

it("replays an already compiled plan without reselecting mutable design state", () => {
  const store = boundWorld(); const ref = committedRevision(store); approveGate1(store, ref);
  expect(submit(store, ref).ok).toBe(true);
  const unavailable = new Proxy(store, { get(target, key) {
    if (key === "readEvents") return (aggregateId: string) => {
      if (aggregateId === `design:${GOAL_ID}`) throw new Error("latest design unavailable");
      return target.readEvents(aggregateId);
    };
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  expect(submit(unavailable, ref)).toMatchObject({ ok: true, disposition: "REPLAYED" });
});

it("keeps legacy design selection unknown and rejects malformed version bindings", () => {
  const binding = { version: "moe-compiled-contract/1", projectId: PROJECT_ID, goalRef: GOAL_ID,
    planningRunRef: "run-1", graphContentHash: "a".repeat(64), submissionHash: "b".repeat(64),
    contractRef: { contractId: "contract-a", revisionId: "revision-1", revisionDigest: "c".repeat(64) } };
  const decode = (row: unknown) => decodeCompiledContractBinding(new TextEncoder().encode(JSON.stringify(row)));
  expect(decode(binding)).toEqual(binding);
  expect(decode({ ...binding, designVersion: null })).toMatchObject({ designVersion: null });
  for (const designVersion of [0, -1, 1.5, "1", {}]) expect(decode({ ...binding, designVersion })).toBeNull();
});

it("retains the design revision sealed with the plan after a new design is submitted", () => {
  const store = boundWorld(); const ref = committedRevision(store); approveGate1(store, ref);
  const design = (version: number, revision: unknown) => submitDesignRevision(store, {
    commandId: `design-${version}`, correlationId: `design-${version}`, decidedAt: "2026-09-05T09:00:00.000Z",
    expectedVersion: version - 1, goalRef: GOAL_ID, projectId: PROJECT_ID,
    principalId: "designer-agent", contractRef: ref, revision,
  });
  expect(design(1, designRevisionFixture()).ok).toBe(true);
  const compiled = submit(store, ref);
  if (!compiled.ok) throw new Error(compiled.code);
  expect(design(2, secondDesignRevisionFixture()).ok).toBe(true);
  expect(readDesignRevision(store, { projectId: PROJECT_ID, goalRef: GOAL_ID })).toMatchObject({
    ok: true, record: { version: 2 },
  });
  expect(readDesignRevision(store, { projectId: PROJECT_ID, goalRef: GOAL_ID,
    planningRunRef: compiled.runId })).toMatchObject({ ok: true, record: { version: 1 } });
  expect(readCompiledContractBinding(store, PROJECT_ID, compiled.runId)).toMatchObject({
    ok: true, binding: { designVersion: 1 },
  });
  expect(submit(store, ref)).toMatchObject({ ok: true, disposition: "REPLAYED" });
});

it("keeps a plan compiled without design absent after a design is added", () => {
  const store = boundWorld(); const ref = committedRevision(store); approveGate1(store, ref);
  const compiled = submit(store, ref);
  if (!compiled.ok) throw new Error(compiled.code);
  expect(submitDesignRevision(store, { commandId: "late-design", correlationId: "late-design",
    decidedAt: "2026-09-05T09:00:00.000Z", expectedVersion: 0, goalRef: GOAL_ID,
    projectId: PROJECT_ID, principalId: "designer-agent", contractRef: ref,
    revision: designRevisionFixture() }).ok).toBe(true);
  expect(readDesignRevision(store, { projectId: PROJECT_ID, goalRef: GOAL_ID,
    planningRunRef: compiled.runId })).toMatchObject({ ok: false, code: "DESIGN_REVISION_ABSENT" });
  expect(readDesignRevision(store, { projectId: PROJECT_ID, goalRef: "another-goal",
    planningRunRef: compiled.runId })).toMatchObject({ ok: false, code: "DESIGN_RECORD_MALFORMED" });
});
