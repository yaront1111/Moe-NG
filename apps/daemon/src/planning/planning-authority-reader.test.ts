import { decodePlanRevisionBytes } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  GOAL_ID,
  GRAPH_REVISION_REF,
  PROJECT_ID,
  RUN_ID,
  closeStores,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { planningAuthorityAggregateId } from "./planning-authority-persistence.js";
import {
  PLANNING_AUTHORITY_READER_CODES,
  readApprovedCriteria,
  readApprovedPlan,
} from "./planning-authority-reader.js";
import {
  activationSection,
  approvedStore,
  base64Bytes,
  bodiesPayload,
  own,
  replicaStore,
  severedEnvelopeStore,
  sha256,
  splicedEnvelopeStore,
  substituteRevisionBytes,
  tamperedRevisionBytes,
  unapprovedStore,
  withoutBinding,
} from "./planning-authority-reader-test-fixtures.js";

/**
 * The DURABLE approved-plan and criteria readers (task-47b2dbc6), consumer c320c34a's context
 * matrix rows "approved plan" and "criteria".
 *
 * The join these readers walk did not exist before task-2cc6c59d: `GoalExecutionEnabled` is the
 * daemon's only durable approval fact and its witness named no run, so an approved goal had no
 * path back to the sealed bodies at `planning-authority/<runId>`. The durable witness copy now
 * carries {runId, authorityRef, bodiesDigest, envelopeDigest}, and these readers key on the runId
 * and the DIGESTS — never on `authorityRef` alone, which is a LOCATOR and not evidence.
 *
 * NOTHING HERE IS READ FROM A SPEC FILE OR FROM CALLER INPUT. Both readers take a store, a
 * projectId and a goalId and answer entirely from committed events.
 *
 * Every world is production-produced: the happy arms drive the SHIPPED journey, and the refusal
 * arms re-commit that journey's own durable bytes with ONE field mutated
 * (`planning-authority-reader-test-fixtures.ts`), because the store is append-only and a
 * committed event cannot be rewritten in place.
 */

const READER_LAYER = "PLANNING_AUTHORITY_READER";
const ENVELOPE_LAYER = "PLANNING_AUTHORITY_ENVELOPE";
const PLAN_REVISION_DIGEST_LAYER = "PLAN_REVISION_DIGEST";

afterEach(() => {
  closeStores();
});

const codeAndLayer = (outcome: unknown): readonly unknown[] =>
  [own(outcome, "code"), own(outcome, "layer")];

const sourceOf = (outcome: unknown): readonly unknown[] => {
  const source = own(outcome, "source");
  return [own(source, "code"), own(source, "layer")];
};

describe("readApprovedPlan serves the durably sealed plan of the approved run", () => {
  it("returns the revision the store's own bodies event decodes to, with its run identity", () => {
    const store = approvedStore();
    const payload = bodiesPayload(store);
    const sealed = decodePlanRevisionBytes(base64Bytes(payload["planRevisionBytesBase64"]));

    const outcome = readApprovedPlan(store, PROJECT_ID, GOAL_ID);

    expect(own(outcome, "ok")).toBe(true);
    // The operand is the STORE's bytes decoded independently, never a literal restated here:
    // two hand-authored operands agreeing would prove only that this file agrees with itself.
    expect(sealed.ok).toBe(true);
    expect(own(outcome, "revision")).toStrictEqual(sealed.ok ? sealed.revision : null);
    expect(own(outcome, "planHash")).toBe(payload["planHash"]);
    expect(own(outcome, "revisionId")).toBe(payload["revisionId"]);
    expect(own(outcome, "graphRevisionRef")).toBe(GRAPH_REVISION_REF);
    expect(own(outcome, "runId")).toBe(RUN_ID);
    expect(own(outcome, "authorityRef")).toBe(planningAuthorityAggregateId(RUN_ID));
  });

  it("exposes the plan STEPS c320c34a's matrix row needs, not just the hashes", () => {
    const outcome = readApprovedPlan(approvedStore(), PROJECT_ID, GOAL_ID);

    const steps = own(own(outcome, "revision"), "steps") as readonly unknown[];
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.length).toBeGreaterThan(0);
    expect(typeof own(steps[0], "description")).toBe("string");
    expect(typeof own(steps[0], "stepId")).toBe("string");
    expect(typeof own(steps[0], "kind")).toBe("string");
  });

  it("binds the witness digest to the sealed bodies digest rather than trusting either alone", () => {
    const store = approvedStore();

    // The three-way identity the reader enforces: witness -> payload -> recompute over the
    // canonical bytes. If any pair could disagree while the read succeeded, the join would be a
    // locator lookup rather than evidence.
    expect(activationSection(store)["bodiesDigest"]).toBe(bodiesPayload(store)["bodiesDigest"]);
    expect(own(readApprovedPlan(store, PROJECT_ID, GOAL_ID), "ok")).toBe(true);
  });
});

describe("readApprovedCriteria serves the durably sealed acceptance contract", () => {
  it("returns the decoded contract with the criteria digest the bodies event sealed", () => {
    const store = approvedStore();
    const payload = bodiesPayload(store);

    const outcome = readApprovedCriteria(store, PROJECT_ID, GOAL_ID);

    expect(own(outcome, "ok")).toBe(true);
    expect(own(outcome, "criteriaDigest")).toBe(payload["criteriaDigest"]);
    expect(own(outcome, "criteriaRef")).toBe(payload["criteriaRef"]);
    expect(own(outcome, "runId")).toBe(RUN_ID);
    // The obligations are the point: the matrix row needs statements, not a digest.
    const obligations = own(own(outcome, "contract"), "obligations") as readonly unknown[];
    expect(Array.isArray(obligations)).toBe(true);
    expect(obligations.length).toBeGreaterThan(0);
    expect(typeof own(obligations[0], "statement")).toBe("string");
    expect(own(own(outcome, "contract"), "criteriaDigest")).toBe(payload["criteriaDigest"]);
  });
});

interface RefusalArm {
  readonly code: string;
  readonly detail?: string;
  readonly name: string;
  readonly read?: "criteria";
  readonly source?: readonly [string, string];
  readonly world: () => SqliteEventStore;
}

/**
 * Every refusal the readers can produce, one world each.
 *
 * The table is what makes the roster coverage BIDIRECTIONAL: the last case below asserts that
 * the codes exercised here and the module's closed roster are the SAME SET, so a code added
 * without a world — or a world quietly deleted — reds instead of shrinking its own iteration.
 */
const REFUSAL_ARMS: readonly RefusalArm[] = [
  {
    code: "PLANNING_AUTHORITY_READER_APPROVAL_ABSENT",
    detail: "absent",
    name: "APPROVAL_ABSENT for a goal that was never activated",
    world: unapprovedStore,
  },
  {
    code: "PLANNING_AUTHORITY_READER_APPROVAL_ABSENT",
    detail: "not-current",
    name: "APPROVAL_ABSENT when the durable approval is not a CURRENT approve decision",
    world: () => replicaStore({ approval: (a) => ({ ...a, validity: "SUPERSEDED" }) }),
  },
  {
    // Seeded at store level: the goal reducer refuses a second `goal.activate_initial_graph` on
    // an already-activated goal, so no production writer can produce this history — but a
    // split-brain replay can, and a take-first read would bind whichever landed first.
    code: "PLANNING_AUTHORITY_READER_APPROVAL_AMBIGUOUS",
    name: "APPROVAL_AMBIGUOUS for two activation events on one goal",
    world: () => replicaStore({ duplicateActivation: true }),
  },
  {
    code: "PLANNING_AUTHORITY_READER_APPROVAL_MALFORMED",
    detail: "payload",
    name: "APPROVAL_MALFORMED when the activation event's payload is not readable",
    read: "criteria",
    world: () => replicaStore({ goalPayloadBytes: new TextEncoder().encode("{not json") }),
  },
  {
    // Three keys present and one absent is not pre-binding history; it is a broken witness, and
    // reporting it as legacy would retire a real corruption as "an old run".
    code: "PLANNING_AUTHORITY_READER_APPROVAL_MALFORMED",
    detail: "partial-binding",
    name: "APPROVAL_MALFORMED for a PARTIALLY bound witness, never legacy",
    world: () => replicaStore({
      activation: (activation) => {
        const partial = { ...activation };
        delete partial["runId"];
        return partial;
      },
    }),
  },
  {
    code: "PLANNING_AUTHORITY_READER_LEGACY_UNBOUND",
    name: "LEGACY_UNBOUND for a witness written before the binding shipped",
    world: () => replicaStore({ activation: withoutBinding }),
  },
  {
    // `authorityRef` is a LOCATOR, not evidence: the reader derives the aggregate from `runId`
    // and refuses the disagreement instead of following the ref.
    code: "PLANNING_AUTHORITY_READER_LOCATOR_MISMATCH",
    name: "LOCATOR_MISMATCH when authorityRef names an aggregate the runId does not",
    world: () => replicaStore({
      activation: (a) => ({ ...a, authorityRef: "planning-authority/run-other" }),
    }),
  },
  {
    code: "PLANNING_AUTHORITY_READER_SEAL_ABSENT",
    detail: "bodies",
    name: "SEAL_ABSENT when the authority aggregate holds no bodies event",
    read: "criteria",
    world: () => replicaStore({ omitAuthority: true }),
  },
  {
    code: "PLANNING_AUTHORITY_READER_SEAL_ABSENT",
    detail: "envelope",
    name: "SEAL_ABSENT when the bodies are sealed but the envelope is not",
    world: () => replicaStore({ omitEnvelope: true }),
  },
  {
    code: "PLANNING_AUTHORITY_READER_SEAL_AMBIGUOUS",
    detail: "bodies",
    name: "SEAL_AMBIGUOUS for two bodies events on one authority aggregate",
    world: () => replicaStore({ duplicateBodies: true }),
  },
  {
    code: "PLANNING_AUTHORITY_READER_SEAL_MALFORMED",
    detail: "bodies",
    name: "SEAL_MALFORMED when the sealed bodies payload is not a readable record",
    world: () => replicaStore({ bodiesPayloadBytes: new TextEncoder().encode("[]") }),
  },
  {
    code: "PLANNING_AUTHORITY_READER_PROJECT_MISMATCH",
    name: "PROJECT_MISMATCH when the sealed bodies belong to another project",
    world: () => replicaStore({ bodies: (p) => ({ ...p, projectId: "project-other" }) }),
  },
  {
    code: "PLANNING_AUTHORITY_READER_GOAL_MISMATCH",
    name: "GOAL_MISMATCH when the sealed bodies were sealed for another goal",
    world: () => replicaStore({ bodies: (p) => ({ ...p, goalRef: "goal-other" }) }),
  },
  {
    // Codec-valid on both sides: only the witness <-> payload comparison can see this class.
    code: "PLANNING_AUTHORITY_READER_WITNESS_DIGEST_MISMATCH",
    detail: "bodies",
    name: "WITNESS_DIGEST_MISMATCH when the sealed bodiesDigest is swapped under the witness",
    world: () => replicaStore({
      bodies: (p) => ({ ...p, bodiesDigest: sha256(new TextEncoder().encode("other")) }),
    }),
  },
  {
    code: "PLANNING_AUTHORITY_READER_WITNESS_DIGEST_MISMATCH",
    detail: "envelope",
    name: "WITNESS_DIGEST_MISMATCH when the sealed envelopeDigest is swapped",
    read: "criteria",
    world: () => replicaStore({
      envelope: (p) => ({ ...p, envelopeDigest: sha256(new TextEncoder().encode("other")) }),
    }),
  },
  {
    // The payload digest and the witness still agree, so the reader's own comparison cannot see
    // this class and the CODEC is what answers. Which layer answers is pinned.
    code: "PLANNING_AUTHORITY_READER_BODIES_INVALID",
    name: "BODIES_INVALID, passing the CORE codec's refusal through, on tampered plan bytes",
    source: ["PLAN_REVISION_DIGEST_MISMATCH", PLAN_REVISION_DIGEST_LAYER],
    world: () => replicaStore({
      bodies: (p) => ({
        ...p, planRevisionBytesBase64: tamperedRevisionBytes(p["planRevisionBytesBase64"]),
      }),
    }),
  },
  {
    // Both codecs stay green and both digest fields still agree with the witness. Only the
    // framed recompute over the bytes actually on disk notices the substitution.
    code: "PLANNING_AUTHORITY_READER_SEAL_DIGEST_MISMATCH",
    detail: "bodies",
    name: "SEAL_DIGEST_MISMATCH when a VALID but different plan body is substituted",
    world: () => replicaStore({
      bodies: (p) => ({
        ...p, planRevisionBytesBase64: substituteRevisionBytes(p["planRevisionBytesBase64"]),
      }),
    }),
  },
  {
    code: "PLANNING_AUTHORITY_READER_ENVELOPE_INVALID",
    name: "ENVELOPE_INVALID, passing the envelope codec's refusal through, on a severed binding",
    read: "criteria",
    source: ["PLANNING_AUTHORITY_REVISION_MISMATCH", ENVELOPE_LAYER],
    world: severedEnvelopeStore,
  },
  {
    // The full splice: the foreign envelope, its digest on the payload AND on the witness, so
    // every digest comparison agrees and only the cross-EVENT check can refuse.
    code: "PLANNING_AUTHORITY_READER_ENVELOPE_DIVERGED",
    name: "ENVELOPE_DIVERGED for a VALID envelope sealed for a different run",
    world: splicedEnvelopeStore,
  },
];

describe("the reader refuses with the code that names WHICH check answered", () => {
  it("accepts an UNMUTATED replica — the positive control for every arm below", () => {
    // Without this, a replica whose bytes never reached the reader would make every refusal arm
    // below pass for the wrong reason.
    const store = replicaStore();

    expect(own(readApprovedPlan(store, PROJECT_ID, GOAL_ID), "ok")).toBe(true);
    expect(own(readApprovedCriteria(store, PROJECT_ID, GOAL_ID), "ok")).toBe(true);
  });

  it.each(REFUSAL_ARMS)("answers $name", (arm) => {
    const read = arm.read === "criteria" ? readApprovedCriteria : readApprovedPlan;

    const outcome = read(arm.world(), PROJECT_ID, GOAL_ID);

    expect(codeAndLayer(outcome)).toStrictEqual([arm.code, READER_LAYER]);
    if (arm.detail !== undefined) expect(own(outcome, "detail")).toBe(arm.detail);
    expect(sourceOf(outcome)).toStrictEqual(arm.source ?? [undefined, undefined]);
    // UNKNOWN never becomes empty: a refusal carrying an empty revision or contract would let a
    // caller read "no steps" as an answer about the plan.
    for (const key of ["contract", "criteriaDigest", "planHash", "revision", "revisionId", "runId"]) {
      expect(own(outcome, key)).toBeUndefined();
    }
  });

  it("exercises every code in the reader's closed roster, and no other", () => {
    // The sweep above is only worth its green if it actually generated cases, and only worth its
    // coverage claim if the roster cannot grow a code that no world reaches.
    expect(REFUSAL_ARMS.length).toBe(19);
    expect([...new Set(REFUSAL_ARMS.map((arm) => arm.code))].sort())
      .toStrictEqual([...PLANNING_AUTHORITY_READER_CODES].sort());
  });
});
