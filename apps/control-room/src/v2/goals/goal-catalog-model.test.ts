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
      goalCountLabel: "0 GOALS \u00b7 DURABLE CATALOG",
      goals: [],
    });
  });

  it("maps every durable goal and preserves its real planning-run reference", () => {
    const data = deriveGoalCatalog(catalog([
      { brief: null, goalId: "goal-alpha", planningRunRef: "run-alpha" },
      { brief: null, goalId: "goal-beta", planningRunRef: "run-beta" },
    ]));

    expect(data.goalCountLabel).toBe("2 GOALS \u00b7 DURABLE CATALOG");
    expect(data.goals.map((goal) => ({
      goalId: goal.goalId,
      headline: goal.headline,
      title: goal.title,
    }))).toStrictEqual([
      {
        goalId: "goal-alpha",
        headline: "Durable GoalCreated record \u00b7 planning run run-alpha",
        title: "goal-alpha",
      },
      {
        goalId: "goal-beta",
        headline: "Durable GoalCreated record \u00b7 planning run run-beta",
        title: "goal-beta",
      },
    ]);
    expect(data.goals[0]).toMatchObject({
      budgetComingOnline: "No budget read is joined to the goal catalog yet.",
      needsYou: false,
      state: "DRAFT",
      titleIsIdentifier: true,
    });
    expect(data.goals[0]?.progress).toBeUndefined();
    expect(data.goals[0]?.facts).toContainEqual(expect.objectContaining({
      label: "Planning run",
      value: "run-alpha",
    }));
  });

  /**
   * A goal the daemon can name in the operator's own prose is titled with that prose; a legacy
   * brief-unknown row keeps showing its identifier, and `titleIsIdentifier` says which of the
   * two the card is rendering, so the shell never presents an id as if it were a human title.
   */
  it("titles a brief-bearing goal with its durable prose and a legacy goal with its id", () => {
    const data = deriveGoalCatalog(catalog([
      {
        brief: { instructions: "Behind bearer credentials", title: "Ship stdio entry" },
        goalId: "goal-brief",
        planningRunRef: "run-brief",
      },
      { brief: null, goalId: "goal-legacy", planningRunRef: "run-legacy" },
    ]));

    expect(data.goals.map((goal) => ({
      goalId: goal.goalId, title: goal.title, titleIsIdentifier: goal.titleIsIdentifier,
    }))).toStrictEqual([
      { goalId: "goal-brief", title: "Ship stdio entry", titleIsIdentifier: false },
      { goalId: "goal-legacy", title: "goal-legacy", titleIsIdentifier: true },
    ]);
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
