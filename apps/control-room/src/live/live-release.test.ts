import { describe, expect, it } from "vitest";

import { mapReleaseAnswer } from "./live-release.js";

/**
 * THE RELEASE DECODER ADMITS WHAT THE DAEMON CAN SERVE. `/release/read` answers one criterion
 * row per contract criterion, titled with the criterion's FULL statement
 * (apps/daemon/src/release/release-durable-facts.ts:136 `title: criterion.statement`), and
 * core admits a statement up to `maxStatementBytes` 32_768 and up to `maxCriteria` 512
 * (packages/core/src/product-contract/product-contract-contract.ts). Measured before these
 * arms: the browser capped the list at 256 rows and the title at 4096 chars, so a goal on a
 * large contract read ERROR RELEASE_RESPONSE_INVALID on exactly the Gate 3 card whose UNKNOWN
 * rows an operator most needs before deciding.
 */

const SHA = "a".repeat(40);

function criterion(id: string, title: string): Readonly<Record<string, unknown>> {
  return {
    command: "pnpm test", criterionId: id, exitCode: "0", gaps: [],
    landing: SHA, nodeKey: `node-${id}`, receiptSha: "c".repeat(40), title,
  };
}

function presentBody(criteria: readonly unknown[]): unknown {
  return {
    evidence: {
      ancestryMeasured: true, criteria, goalId: "goal-1", goalTitle: "Ship the orders screen",
      preview: null, receipt: null, reviewRounds: [], sha: SHA,
    },
    kind: "PRESENT",
  };
}

const rows = (count: number): readonly unknown[] =>
  Array.from({ length: count }, (_, index) => criterion(`crit-${String(index).padStart(4, "0")}`, `Criterion ${String(index)}`));

describe("the release decoder admits every row and title the daemon can serve", () => {
  it("decodes a contract with more than 256 criteria (core admits 512)", () => {
    const answer = mapReleaseAnswer(200, presentBody(rows(512)));
    expect(answer.status).toBe("PRESENT");
    if (answer.status === "PRESENT") expect(answer.evidence.criteria).toHaveLength(512);
  });

  it("decodes a criterion whose statement is longer than 4096 chars (core admits 32_768 bytes)", () => {
    const title = "x".repeat(32_768);
    const answer = mapReleaseAnswer(200, presentBody([criterion("crit-long", title)]));
    expect(answer.status).toBe("PRESENT");
    if (answer.status === "PRESENT") expect(answer.evidence.criteria[0]?.title).toBe(title);
  });

  it("still refuses a list past the core roster (513 rows) and a title past the core statement cap", () => {
    expect(mapReleaseAnswer(200, presentBody(rows(513))))
      .toEqual({ code: "RELEASE_RESPONSE_INVALID", layer: "CONTROL_ROOM_RELEASE_READ", status: "ERROR" });
    expect(mapReleaseAnswer(200, presentBody([criterion("crit-over", "x".repeat(32_769))])))
      .toEqual({ code: "RELEASE_RESPONSE_INVALID", layer: "CONTROL_ROOM_RELEASE_READ", status: "ERROR" });
    // An empty title is still not a title.
    expect(mapReleaseAnswer(200, presentBody([criterion("crit-empty", "")])).status).toBe("ERROR");
  });
});
