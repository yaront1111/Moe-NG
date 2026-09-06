import { describe, expect, it } from "vitest";

import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import { deriveGoalCatalog } from "./goal-catalog-model.js";

function catalog(
  goals: GoalCatalogFrame["goals"],
): GoalCatalogFrame {
  return {
    connection: "CONNECTED",
    detail: "",
    goals,
    outcome: "GOALS",
  };
}

describe("deriveGoalCatalog", () => {
  it("renders no synthetic goal while the durable catalog is pending or empty", () => {
    expect(deriveGoalCatalog(null)).toMatchObject({
      goalCountLabel: "GOAL CATALOG COMING ONLINE",
      goals: [],
    });
    expect(deriveGoalCatalog(catalog([]))).toMatchObject({
      comingOnlineNote: "This project has no durable goals yet.",
      goalCountLabel: "0 GOALS \u00b7 CURRENT PAGE",
      goals: [],
    });
  });

  it("maps every durable goal and preserves its real planning-run reference", () => {
    const data = deriveGoalCatalog(catalog([
      {
        brief: { instructions: "Deliver alpha with tests.", title: "Deliver alpha" },
        goalId: "goal-alpha", planningRunRef: "run-alpha",
        prd: {
          byteLength: 41, contentSha256: "a".repeat(64), displayPath: "alpha.md",
          mediaType: "text/markdown", sourceRef: "document-source/alpha",
        },
      },
      { brief: null, goalId: "goal-beta", planningRunRef: "run-beta", prd: null },
    ]));

    expect(data.goalCountLabel).toBe("2 GOALS \u00b7 CURRENT PAGE");
    expect(data.goals.map((goal) => ({
      goalId: goal.goalId,
      headline: goal.headline,
      title: goal.title,
    }))).toStrictEqual([
      {
        goalId: "goal-alpha",
        headline: "Durable goal brief \u00b7 planning run run-alpha",
        title: "Deliver alpha",
      },
      {
        goalId: "goal-beta",
        headline: "Durable legacy goal \u00b7 planning run run-beta",
        title: "goal-beta",
      },
    ]);
    expect(data.goals[0]).toMatchObject({
      budgetComingOnline: "No budget read is joined to the goal catalog yet.",
      needsYou: false,
      state: "UNKNOWN",
      titleIsIdentifier: false,
    });
    expect(data.goals[0]?.progress).toBeUndefined();
    for (const goal of data.goals) {
      expect(goal.state).toBe("UNKNOWN");
      expect(goal.comingOnlineFacts).toContainEqual({
        label: "Current state",
        reason: "The goal catalog does not include the current goal state.",
      });
    }
    expect(data.goals[0]?.facts).toContainEqual(expect.objectContaining({
      label: "Planning run",
      value: "run-alpha",
    }));
    expect(data.goals[0]?.facts).toContainEqual(expect.objectContaining({
      label: "Goal brief", value: "Deliver alpha with tests.",
    }));
    expect(data.goals[0]?.facts).toContainEqual(expect.objectContaining({
      label: "PRD", value: "alpha.md (41 B)",
    }));
    expect(data.goals[1]).toMatchObject({ title: "goal-beta", titleIsIdentifier: true });
  });

  it.each([
    [{ connection: "DISCONNECTED", detail: "TRANSPORT_REQUEST_FAILED", goals: [], outcome: "UNDELIVERED" },
      "DISCONNECTED \u00b7 TRANSPORT_REQUEST_FAILED"],
    [{ connection: "CONNECTED", detail: "GOAL_CATALOG_READ_PROJECT_MISMATCH", goals: [], outcome: "REFUSED" },
      "REFUSED \u00b7 GOAL_CATALOG_READ_PROJECT_MISMATCH"],
    [{ connection: "CONNECTED", detail: "LIVE_GOAL_CATALOG_UNREADABLE", goals: [], outcome: "UNREADABLE" },
      "UNREADABLE \u00b7 LIVE_GOAL_CATALOG_UNREADABLE"],
  ] satisfies readonly (readonly [GoalCatalogFrame, string])[])(
    "renders catalog failure %s verbatim and without a goal",
    (frame, label) => {
      const data = deriveGoalCatalog(frame);
      expect(data.goalCountLabel).toBe(label);
      expect(data.goals).toStrictEqual([]);
      expect(data.comingOnlineNote).toContain(frame.detail);
    },
  );
});
