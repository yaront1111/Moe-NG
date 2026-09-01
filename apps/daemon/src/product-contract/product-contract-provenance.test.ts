/**
 * The provenance join, driven off the PRODUCTION wire: a real
 * `goal.create_with_source` dispatch binds the PRD, and every arm measures the
 * fence against that durable world. The quiet-invention arm — a digest list that
 * omits the goal's own PRD sha — is the one the owner's "never quietly invent a
 * product decision" rule turns on.
 */
import { createHash } from "node:crypto";

import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  GOAL_CREATE_COMMAND_ID,
  GOAL_ID,
  PROJECT_ID,
  closeStores,
  driveThrough,
  envelope,
  openStore,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { validateRevisionProvenance } from "./product-contract-provenance.js";

const PRD = "# Build the widget\n\nRequirements the operator wrote.\n";
const PRD_SHA = createHash("sha256").update(PRD, "utf8").digest("hex");

afterEach(closeStores);

function boundWorld(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "goal.create");
  const outcome = send(store, envelope("goal.create_with_source", 0, {
    instructions: "Bind a PRD for provenance drills.",
    source: { displayPath: "docs/prd.md", mediaType: "text/markdown", text: PRD },
    title: "Provenance journey goal",
  }, GOAL_CREATE_COMMAND_ID));
  if (!outcome.ok) throw new Error(`fixture bind refused: ${outcome.code}`);
  return store;
}

describe("validateRevisionProvenance", () => {
  it("joins a digest list naming the goal's own PRD, answering verified facts", () => {
    const store = boundWorld();
    const joined = validateRevisionProvenance(store, PROJECT_ID, GOAL_ID, [PRD_SHA]);
    if (!joined.ok) throw new Error(`join refused: ${joined.code}`);
    expect(joined.goalId).toBe(GOAL_ID);
    expect(joined.contentSha256).toBe(PRD_SHA);
    expect(joined.planningRunRef).toBe("run-1");
  });

  it("refuses a digest list that quietly omits the goal's PRD", () => {
    const store = boundWorld();
    const other = "ab".repeat(32);
    expect(validateRevisionProvenance(store, PROJECT_ID, GOAL_ID, [other])).toMatchObject({
      code: "PRODUCT_CONTRACT_PROVENANCE_DIGEST_MISSING", ok: false,
    });
  });

  it("refuses a cited digest with no stored source behind it", () => {
    const store = boundWorld();
    const phantom = "cd".repeat(32);
    expect(
      validateRevisionProvenance(store, PROJECT_ID, GOAL_ID, [phantom, PRD_SHA].sort()),
    ).toMatchObject({
      code: "PRODUCT_CONTRACT_PROVENANCE_SOURCE_UNRESOLVED", ok: false,
    });
  });

  it("refuses goals the store does not bind", () => {
    const store = boundWorld();
    expect(validateRevisionProvenance(store, PROJECT_ID, "goal-unknown", [PRD_SHA]))
      .toMatchObject({ code: "PRODUCT_CONTRACT_PROVENANCE_GOAL_UNBOUND", ok: false });
  });

  it("refuses a source-less goal: the plain bootstrap journey's goal has no binding", () => {
    const store = openStore();
    driveThrough(store, "plan.propose");
    expect(validateRevisionProvenance(store, PROJECT_ID, GOAL_ID, [PRD_SHA]))
      .toMatchObject({ code: "PRODUCT_CONTRACT_PROVENANCE_GOAL_UNBOUND", ok: false });
  });

  it("refuses malformed inputs before touching the store", () => {
    const store = boundWorld();
    for (const digests of [[], ["not-hex"], ["AB".repeat(32)], "x", null, [PRD_SHA, 42]]) {
      expect(validateRevisionProvenance(store, PROJECT_ID, GOAL_ID, digests)).toMatchObject({
        code: "PRODUCT_CONTRACT_PROVENANCE_MALFORMED", ok: false,
      });
    }
    expect(validateRevisionProvenance(store, PROJECT_ID, "", [PRD_SHA])).toMatchObject({
      code: "PRODUCT_CONTRACT_PROVENANCE_MALFORMED", ok: false,
    });
  });
});
