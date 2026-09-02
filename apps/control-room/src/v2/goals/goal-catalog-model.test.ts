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
      {
        binding: null, brief: null, goalId: "goal-alpha", planningRunRef: "run-alpha",
        truthClass: "DAEMON_VERIFIED",
      },
      {
        binding: null, brief: null, goalId: "goal-beta", planningRunRef: "run-beta",
        truthClass: "HUMAN_APPROVED",
      },
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
        binding: null,
        brief: { instructions: "Behind bearer credentials", title: "Ship stdio entry" },
        goalId: "goal-brief",
        planningRunRef: "run-brief",
        truthClass: "DAEMON_VERIFIED",
      },
      {
        binding: null, brief: null, goalId: "goal-legacy", planningRunRef: "run-legacy",
        truthClass: "HUMAN_APPROVED",
      },
    ]));

    expect(data.goals.map((goal) => ({
      goalId: goal.goalId, title: goal.title, titleIsIdentifier: goal.titleIsIdentifier,
    }))).toStrictEqual([
      { goalId: "goal-brief", title: "Ship stdio entry", titleIsIdentifier: false },
      { goalId: "goal-legacy", title: "goal-legacy", titleIsIdentifier: true },
    ]);
    expect(data.goals[0]?.facts.map((fact) => ({
      factId: fact.factId, label: fact.label, truthClass: fact.truthClass, value: fact.value,
    }))).toContainEqual({
      factId: "catalog.goal-brief.brief.instructions",
      label: "Brief instructions",
      truthClass: "DAEMON_VERIFIED",
      value: "Behind bearer credentials",
    });
    expect(data.goals[0]?.facts.some((fact) => fact.factId.includes(".binding."))).toBe(false);
    expect(data.goals[0]?.comingOnlineFacts.map((fact) => fact.label)).not.toContain("Goal title");
    expect(data.goals[1]?.comingOnlineFacts.map((fact) => fact.label)).toContain("Goal title");
  });

  it("expands every daemon-returned source binding field without recomputing it", () => {
    const binding = Object.freeze({
      byteLength: 57,
      contentSha256: "8f1c6f6427e2f52f2fd26066a328d591eb039bbd495f509026edf52256c75bb6",
      sourceAggregateId: "document-source:project-alpha:8f1c6f64:source-alpha",
      sourceRef: "source-alpha",
    });
    const data = deriveGoalCatalog(catalog([{
      binding,
      brief: { instructions: "Use the exact attached PRD.", title: "Bound goal" },
      goalId: "goal-bound",
      planningRunRef: "run-bound",
      truthClass: "DAEMON_VERIFIED",
    }]));

    expect(data.goals[0]?.facts.map((fact) => ({
      factId: fact.factId,
      label: fact.label,
      rows: fact.rows,
      truthClass: fact.truthClass,
      value: fact.value,
    }))).toStrictEqual([
      {
        factId: "catalog.goal-bound.identity",
        label: "Goal",
        rows: [{ k: "SOURCE", v: "POST /goals/read" }, { k: "GOAL", v: "goal-bound" }],
        truthClass: "DAEMON_VERIFIED",
        value: "goal-bound",
      },
      {
        factId: "catalog.goal-bound.planning-run",
        label: "Planning run",
        rows: [{ k: "SOURCE", v: "POST /goals/read" }, { k: "RUN", v: "run-bound" }],
        truthClass: "DAEMON_VERIFIED",
        value: "run-bound",
      },
      {
        factId: "catalog.goal-bound.brief.instructions",
        label: "Brief instructions",
        rows: [
          { k: "SOURCE", v: "POST /goals/read" },
          { k: "brief.instructions", v: "Use the exact attached PRD." },
        ],
        truthClass: "DAEMON_VERIFIED",
        value: "Use the exact attached PRD.",
      },
      {
        factId: "catalog.goal-bound.binding.byteLength",
        label: "PRD byte length",
        rows: [
          { k: "SOURCE", v: "POST /goals/read" },
          { k: "binding.byteLength", v: "57" },
        ],
        truthClass: "DAEMON_VERIFIED",
        value: "57",
      },
      {
        factId: "catalog.goal-bound.binding.contentSha256",
        label: "PRD content SHA-256",
        rows: [
          { k: "SOURCE", v: "POST /goals/read" },
          { k: "binding.contentSha256", v: binding.contentSha256 },
        ],
        truthClass: "DAEMON_VERIFIED",
        value: binding.contentSha256,
      },
      {
        factId: "catalog.goal-bound.binding.sourceAggregateId",
        label: "PRD source aggregate",
        rows: [
          { k: "SOURCE", v: "POST /goals/read" },
          { k: "binding.sourceAggregateId", v: binding.sourceAggregateId },
        ],
        truthClass: "DAEMON_VERIFIED",
        value: binding.sourceAggregateId,
      },
      {
        factId: "catalog.goal-bound.binding.sourceRef",
        label: "PRD source ref",
        rows: [
          { k: "SOURCE", v: "POST /goals/read" },
          { k: "binding.sourceRef", v: binding.sourceRef },
        ],
        truthClass: "DAEMON_VERIFIED",
        value: binding.sourceRef,
      },
    ]);
  });

  it("uses the catalog entry truth class for every projected fact and retires known title", () => {
    const data = deriveGoalCatalog(catalog([{
      binding: {
        byteLength: 57,
        contentSha256: "8f1c6f6427e2f52f2fd26066a328d591eb039bbd495f509026edf52256c75bb6",
        sourceAggregateId: "document-source:project-alpha:8f1c6f64:source-alpha",
        sourceRef: "source-alpha",
      },
      brief: { instructions: "Use the exact attached PRD.", title: "Bound goal" },
      goalId: "goal-human-approved",
      planningRunRef: "run-human-approved",
      truthClass: "HUMAN_APPROVED",
    }]));

    expect(data.goals[0]?.facts.map((fact) => fact.truthClass)).toStrictEqual(
      Array.from({ length: 7 }, () => "HUMAN_APPROVED"),
    );
    expect(data.goals[0]?.comingOnlineFacts.map((fact) => fact.label)).not.toContain("Goal title");
    expect(data.goals[0]?.facts.every(
      (fact) => fact.rows?.[0]?.k === "SOURCE" && fact.rows[0].v === "POST /goals/read",
    )).toBe(true);
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
