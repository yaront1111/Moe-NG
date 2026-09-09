/**
 * The versioned `design:<goalId>` aggregate, over a REAL file-backed SqliteEventStore.
 *
 * NOTHING HERE HAND-BUILDS THE APPROVAL. The approved world comes from the production journey the
 * rest of the daemon drives — `boundWorld()` binds a goal to a PRD, `committedRevision()` commits
 * a product-contract revision through the real writer, and `approveGate1()` grants Gate 1 through
 * the real command with a real paired session. The UNAPPROVED world is the SAME builder with the
 * approval step omitted, so the DESIGN_CONTRACT_NOT_APPROVED arm differs from the green arm by
 * exactly the fact under test rather than by a hand-folded state object.
 *
 * HISTORY IS THE PROPERTY, NOT "THE SECOND SUBMIT WORKED". Every resubmit arm reads version 1
 * back AFTER version 2 exists and compares its content; an arm that only checked the new version
 * would pass just as happily against a store that overwrote.
 *
 * WINDOWS HANDLE DISCIPLINE: every store is closed by `closeStores()` in `afterAll`.
 */

import { afterAll, describe, expect, it } from "vitest";

import type { ProductContractRevisionRef } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { GOAL_ID, PROJECT_ID, closeStores } from "../bootstrap/bootstrap-test-fixtures.js";
import {
  approveGate1, boundWorld, committedRevision,
} from "../planning/plan-reject-test-fixtures.js";
import {
  DESIGN_REVISION_KEYS, DESIGN_SECTION_KEYS, DESIGN_SKIP_KEYS, designAggregateId, isDesignSkip,
} from "./design-contracts.js";
import { designRevisionFixture, designSkipFixture, secondDesignRevisionFixture }
  from "./design-test-fixtures.js";
import { readApprovedDesignContract, readDesignRevision, submitDesignRevision }
  from "./design-store.js";

const DECIDED_AT = "2026-09-05T09:00:00.000Z";

interface World {
  readonly ref: ProductContractRevisionRef;
  readonly store: SqliteEventStore;
}

/** The production journey up to an APPROVED Gate 1, and nothing hand-folded. */
function approvedWorld(): World {
  const store = boundWorld();
  const ref = committedRevision(store);
  approveGate1(store, ref);
  return { ref, store };
}

/** The same journey with the human's grant withheld. One fact apart from `approvedWorld`. */
function unapprovedWorld(): World {
  const store = boundWorld();
  return { ref: committedRevision(store), store };
}

function submit(world: World, expectedVersion: number, revision: unknown, seed: string) {
  return submitDesignRevision(world.store, {
    commandId: `cmd-design-${seed}`,
    contractRef: world.ref,
    correlationId: `corr-design-${seed}`,
    decidedAt: DECIDED_AT,
    expectedVersion,
    goalRef: GOAL_ID,
    principalId: "designer-agent-1",
    projectId: PROJECT_ID,
    revision,
  });
}

afterAll(() => { closeStores(); });

describe("submitDesignRevision over a real store", () => {
  it("appends version 2 without overwriting version 1", () => {
    const world = approvedWorld();
    const first = submit(world, 0, designRevisionFixture(), "v1-history");
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(`first submit refused: ${first.code}@${first.layer}`);
    expect(first.record.version).toBe(1);

    const second = submit(world, 1, secondDesignRevisionFixture(), "v2-history");
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(`second submit refused: ${second.code}@${second.layer}`);
    expect(second.record.version).toBe(2);

    // THE PROPERTY: version 1 is still there AFTER version 2 exists.
    const one = readDesignRevision(world.store, {
      goalRef: GOAL_ID, projectId: PROJECT_ID, version: 1,
    });
    expect(one.ok).toBe(true);
    if (!one.ok) throw new Error(`version 1 unreadable: ${one.code}@${one.layer}`);
    expect(one.record.version).toBe(1);
    expect(one.record.revision).toEqual(designRevisionFixture());

    const two = readDesignRevision(world.store, {
      goalRef: GOAL_ID, projectId: PROJECT_ID, version: 2,
    });
    expect(two.ok).toBe(true);
    if (!two.ok) throw new Error(`version 2 unreadable: ${two.code}@${two.layer}`);
    expect(two.record.revision).toEqual(secondDesignRevisionFixture());

    // Raw cardinality, not only the version number: an overwrite would move one and not the other.
    expect(world.store.readEvents(designAggregateId(GOAL_ID))).toHaveLength(2);
    expect(world.store.getAggregateVersion(designAggregateId(GOAL_ID))).toBe(2);
    expect(one.versions).toEqual([1, 2]);
  });

  it("reads the LATEST with its version number when no version is named", () => {
    const world = approvedWorld();
    expect(submit(world, 0, designRevisionFixture(), "v1-latest").ok).toBe(true);
    expect(submit(world, 1, secondDesignRevisionFixture(), "v2-latest").ok).toBe(true);
    const latest = readDesignRevision(world.store, { goalRef: GOAL_ID, projectId: PROJECT_ID });
    expect(latest.ok).toBe(true);
    if (!latest.ok) throw new Error(`latest unreadable: ${latest.code}@${latest.layer}`);
    expect(latest.record.version).toBe(2);
    expect(latest.record.revision).toEqual(secondDesignRevisionFixture());
    expect(latest.versions).toEqual([1, 2]);
  });

  it.each([...DESIGN_REVISION_KEYS])(
    "round trips the %s section byte-identically through the store",
    (section) => {
      const world = approvedWorld();
      expect(submit(world, 0, designRevisionFixture(), `roundtrip-${section}`).ok).toBe(true);
      const read = readDesignRevision(world.store, { goalRef: GOAL_ID, projectId: PROJECT_ID });
      expect(read.ok).toBe(true);
      if (!read.ok) throw new Error(`read refused: ${read.code}@${read.layer}`);
      // A design and a skip now share this slot, so the arm pins which one came back before it
      // indexes sections: a skip here would compare undefined to undefined per section and pass.
      if (isDesignSkip(read.record.revision)) throw new Error("a design must not read as a skip");
      // PER SECTION, so a dropped one names itself instead of failing as one opaque inequality.
      expect(read.record.revision[section]).toEqual(designRevisionFixture()[section]);
      expect(JSON.stringify(read.record.revision[section]))
        .toBe(JSON.stringify(designRevisionFixture()[section]));
    },
  );

  it("carries the five sections and the open-decisions list, and no other member", () => {
    const world = approvedWorld();
    expect(submit(world, 0, designRevisionFixture(), "member-roster").ok).toBe(true);
    const read = readDesignRevision(world.store, { goalRef: GOAL_ID, projectId: PROJECT_ID });
    if (!read.ok) throw new Error(`read refused: ${read.code}@${read.layer}`);
    expect(Object.keys(read.record.revision).sort()).toEqual([...DESIGN_REVISION_KEYS].sort());
    expect([...DESIGN_SECTION_KEYS]).toHaveLength(5);
    expect(read.record.contractRef).toEqual(world.ref);
  });

  it("refuses DESIGN_REVISION_CONFLICT at LEDGER on a stale expected version", () => {
    const world = approvedWorld();
    expect(submit(world, 0, designRevisionFixture(), "conflict-v1").ok).toBe(true);
    // A second seat that still believes the aggregate is empty.
    const stale = submit(world, 0, secondDesignRevisionFixture(), "conflict-stale");
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("a stale expected version must be refused");
    expect(stale.code).toBe("DESIGN_REVISION_CONFLICT");
    expect(stale.layer).toBe("LEDGER");

    // THE STORE IS UNCHANGED: the loser appended nothing and the winner still reads back.
    expect(world.store.readEvents(designAggregateId(GOAL_ID))).toHaveLength(1);
    expect(world.store.getAggregateVersion(designAggregateId(GOAL_ID))).toBe(1);
    const read = readDesignRevision(world.store, { goalRef: GOAL_ID, projectId: PROJECT_ID });
    if (!read.ok) throw new Error(`read refused: ${read.code}@${read.layer}`);
    expect(read.record.version).toBe(1);
    expect(read.record.revision).toEqual(designRevisionFixture());
  });

  it("refuses DESIGN_CONTRACT_NOT_APPROVED at CONTRACT_AUTHORITY with no Gate 1 grant", () => {
    const world = unapprovedWorld();
    const refused = submit(world, 0, designRevisionFixture(), "not-approved");
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("an unapproved contract must be refused");
    expect(refused.code).toBe("DESIGN_CONTRACT_NOT_APPROVED");
    expect(refused.layer).toBe("CONTRACT_AUTHORITY");
    // The delegated verdict is carried verbatim, so WHICH authority answered is not lost — and
    // this is what proves the gate refused for the absent grant rather than for a malformed ref.
    expect(refused.sourceCode).toBe("PRODUCT_CONTRACT_GATE_1_APPROVAL_ABSENT");
    expect(refused.sourceLayer).toBe("PRODUCT_CONTRACT_GATE_1_READER");
    expect(world.store.readEvents(designAggregateId(GOAL_ID))).toHaveLength(0);
  });

  it("refuses DESIGN_SHAPE_INVALID at REQUEST before it consults the approval", () => {
    const world = unapprovedWorld();
    const refused = submit(world, 0, { screens: [] }, "shape-first");
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("a malformed revision must be refused");
    // The unapproved world would ALSO refuse: asserting the code pins WHICH layer answered, so
    // this arm cannot pass by the approval gate accidentally covering for the decoder.
    expect(refused.code).toBe("DESIGN_SHAPE_INVALID");
    expect(refused.layer).toBe("REQUEST");
  });

  it("refuses DESIGN_REVISION_ABSENT at LEDGER before any design exists", () => {
    const world = approvedWorld();
    const read = readDesignRevision(world.store, { goalRef: GOAL_ID, projectId: PROJECT_ID });
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("an empty aggregate must be refused");
    expect(read.code).toBe("DESIGN_REVISION_ABSENT");
    expect(read.layer).toBe("LEDGER");
  });

  it("refuses DESIGN_REVISION_ABSENT at LEDGER for a version that was never appended", () => {
    const world = approvedWorld();
    expect(submit(world, 0, designRevisionFixture(), "absent-version").ok).toBe(true);
    const read = readDesignRevision(world.store, {
      goalRef: GOAL_ID, projectId: PROJECT_ID, version: 2,
    });
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("an unwritten version must be refused");
    expect(read.code).toBe("DESIGN_REVISION_ABSENT");
    expect(read.layer).toBe("LEDGER");
  });
});

/**
 * A DECLARED SKIP on the same aggregate, over the same REAL store and the same production journey.
 *
 * THREE STATES, NOT TWO. "No design was ever submitted", "the design step was skipped" and "a real
 * design exists" are three different facts, and any TWO of them cannot tell the third apart — a
 * compiler seat that receives nothing cannot distinguish a skip from a failed read, and will
 * guess. Every arm below reads back through `readDesignRevision` and names WHICH of the three it
 * got: the absent case by its refusal CODE and LAYER, the other two by `isDesignSkip`.
 */
describe("a design that is SKIPPED rather than submitted", () => {
  it("lands a version, and reads back as a skip carrying the operator's reason", () => {
    const world = approvedWorld();
    const submitted = submit(world, 0, designSkipFixture(), "skip-v1");
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) throw new Error(`skip refused: ${submitted.code}@${submitted.layer}`);
    expect(submitted.record.version).toBe(1);

    const read = readDesignRevision(world.store, { goalRef: GOAL_ID, projectId: PROJECT_ID });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(`skip unreadable: ${read.code}@${read.layer}`);
    expect(isDesignSkip(read.record.revision)).toBe(true);
    if (!isDesignSkip(read.record.revision)) throw new Error("a skip must read back as a skip");
    expect(read.record.revision.skipped).toBe(true);
    expect(read.record.revision.reason).toBe(designSkipFixture().reason);
    expect(Object.keys(read.record.revision).sort()).toEqual([...DESIGN_SKIP_KEYS].sort());
    // The record's own arity did NOT move: `revision` is one key whose value is the union.
    expect(read.record.contractRef).toEqual(world.ref);
    expect(read.versions).toEqual([1]);
  });

  it("is distinguishable from BOTH an absent design and a real design", () => {
    // THE THREE STATES, measured in one arm so no pair can stand in for the triple.
    const absent = approvedWorld();
    const absentRead = readDesignRevision(absent.store, {
      goalRef: GOAL_ID, projectId: PROJECT_ID,
    });
    expect(absentRead.ok).toBe(false);
    if (absentRead.ok) throw new Error("an empty aggregate must not read as a design");
    expect(absentRead.code).toBe("DESIGN_REVISION_ABSENT");
    expect(absentRead.layer).toBe("LEDGER");

    const skipped = approvedWorld();
    expect(submit(skipped, 0, designSkipFixture(), "three-states-skip").ok).toBe(true);
    const skippedRead = readDesignRevision(skipped.store, {
      goalRef: GOAL_ID, projectId: PROJECT_ID,
    });
    if (!skippedRead.ok) {
      throw new Error(`skip unreadable: ${skippedRead.code}@${skippedRead.layer}`);
    }
    expect(isDesignSkip(skippedRead.record.revision)).toBe(true);

    const designed = approvedWorld();
    expect(submit(designed, 0, designRevisionFixture(), "three-states-design").ok).toBe(true);
    const designedRead = readDesignRevision(designed.store, {
      goalRef: GOAL_ID, projectId: PROJECT_ID,
    });
    if (!designedRead.ok) {
      throw new Error(`design unreadable: ${designedRead.code}@${designedRead.layer}`);
    }
    expect(isDesignSkip(designedRead.record.revision)).toBe(false);
    expect(designedRead.record.revision).toEqual(designRevisionFixture());
  });

  it("refuses DESIGN_CONTRACT_NOT_APPROVED at CONTRACT_AUTHORITY with no Gate 1 grant", () => {
    // THE FREE FENCE, PINNED. `submitDesignRevision` decodes first and re-proves the approval
    // second, so a SKIP travels the identical path a design travels: you cannot skip the design
    // for a goal whose product contract was never approved. A refactor that hoisted the approval
    // read or short-circuited on skips would open that window silently — this arm closes it.
    const world = unapprovedWorld();
    const refused = submit(world, 0, designSkipFixture(), "skip-not-approved");
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("a skip must not bypass the Gate 1 fence");
    expect(refused.code).toBe("DESIGN_CONTRACT_NOT_APPROVED");
    expect(refused.layer).toBe("CONTRACT_AUTHORITY");
    expect(refused.sourceCode).toBe("PRODUCT_CONTRACT_GATE_1_APPROVAL_ABSENT");
    expect(refused.sourceLayer).toBe("PRODUCT_CONTRACT_GATE_1_READER");
    expect(world.store.readEvents(designAggregateId(GOAL_ID))).toHaveLength(0);
  });

  it.each([
    ["a skip that still carries all six sections", {
      ...designRevisionFixture(), ...designSkipFixture(),
    }],
    ["an un-skipped marker carrying no sections", { reason: "changed my mind", skipped: false }],
  ])("refuses %s DESIGN_SHAPE_INVALID at REQUEST and appends nothing", (_label, value) => {
    // Against the UNAPPROVED world on purpose: that world would ALSO refuse, so asserting the
    // CODE pins that the decoder answered rather than the approval gate covering for it.
    const world = unapprovedWorld();
    const refused = submit(world, 0, value, `half-skipped-${_label.slice(0, 12)}`);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("a half-skipped revision must be refused");
    expect(refused.code).toBe("DESIGN_SHAPE_INVALID");
    expect(refused.layer).toBe("REQUEST");
    expect(world.store.readEvents(designAggregateId(GOAL_ID))).toHaveLength(0);
  });

  it("keeps a skip at v1 readable after a real design lands at v2", () => {
    // The operator is allowed to change their mind, and history must show that they did.
    const world = approvedWorld();
    expect(submit(world, 0, designSkipFixture(), "mind-change-v1").ok).toBe(true);
    expect(submit(world, 1, designRevisionFixture(), "mind-change-v2").ok).toBe(true);

    const one = readDesignRevision(world.store, {
      goalRef: GOAL_ID, projectId: PROJECT_ID, version: 1,
    });
    if (!one.ok) throw new Error(`version 1 unreadable: ${one.code}@${one.layer}`);
    expect(isDesignSkip(one.record.revision)).toBe(true);
    expect(one.record.revision).toEqual(designSkipFixture());

    const latest = readDesignRevision(world.store, { goalRef: GOAL_ID, projectId: PROJECT_ID });
    if (!latest.ok) throw new Error(`latest unreadable: ${latest.code}@${latest.layer}`);
    expect(latest.record.version).toBe(2);
    expect(isDesignSkip(latest.record.revision)).toBe(false);
    expect(latest.record.revision).toEqual(designRevisionFixture());
    expect(latest.versions).toEqual([1, 2]);
    expect(world.store.readEvents(designAggregateId(GOAL_ID))).toHaveLength(2);
  });

  it("refuses DESIGN_REVISION_CONFLICT at LEDGER for a second skip at the same version", () => {
    const world = approvedWorld();
    expect(submit(world, 0, designSkipFixture(), "skip-conflict-v1").ok).toBe(true);
    const stale = submit(world, 0, designSkipFixture(), "skip-conflict-stale");
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("a stale expected version must be refused for a skip too");
    expect(stale.code).toBe("DESIGN_REVISION_CONFLICT");
    expect(stale.layer).toBe("LEDGER");
    expect(world.store.readEvents(designAggregateId(GOAL_ID))).toHaveLength(1);
    expect(world.store.getAggregateVersion(designAggregateId(GOAL_ID))).toBe(1);
  });
});

describe("readApprovedDesignContract", () => {
  it("admits the approved triple and answers with the ref it re-proved", () => {
    const world = approvedWorld();
    const approved = readApprovedDesignContract(world.store, {
      contractRef: world.ref, goalRef: GOAL_ID, projectId: PROJECT_ID,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) throw new Error(`gate refused: ${approved.code}@${approved.layer}`);
    expect(approved.ref).toEqual(world.ref);
  });

  it("refuses a triple whose revision is not the one that was approved", () => {
    const world = approvedWorld();
    const refused = readApprovedDesignContract(world.store, {
      contractRef: { ...world.ref, revisionId: "revision-9999" },
      goalRef: GOAL_ID,
      projectId: PROJECT_ID,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("a foreign revision id must not pass the gate");
    expect(refused.code).toBe("DESIGN_CONTRACT_NOT_APPROVED");
    expect(refused.layer).toBe("CONTRACT_AUTHORITY");
    expect(refused.sourceCode).toBe("PRODUCT_CONTRACT_REVISION_ABSENT");
  });

  it("refuses an approved contract presented for a DIFFERENT goal", () => {
    const world = approvedWorld();
    const refused = readApprovedDesignContract(world.store, {
      contractRef: world.ref, goalRef: "goal-somebody-elses", projectId: PROJECT_ID,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("an approved ref must not travel to another goal");
    expect(refused.code).toBe("DESIGN_CONTRACT_NOT_APPROVED");
    expect(refused.layer).toBe("CONTRACT_AUTHORITY");
    expect(refused.sourceCode).toBe("PRODUCT_CONTRACT_PROVENANCE_GOAL_UNBOUND");
  });

  it("refuses a malformed triple at the admission surface", () => {
    const world = approvedWorld();
    const refused = readApprovedDesignContract(world.store, {
      contractRef: { contractId: "", revisionDigest: "", revisionId: "" },
      goalRef: GOAL_ID,
      projectId: PROJECT_ID,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("a malformed triple must not pass the gate");
    expect(refused.code).toBe("DESIGN_CONTRACT_NOT_APPROVED");
    expect(refused.layer).toBe("CONTRACT_AUTHORITY");
    expect(refused.sourceLayer).not.toBe("CONTRACT_AUTHORITY");
  });
});
