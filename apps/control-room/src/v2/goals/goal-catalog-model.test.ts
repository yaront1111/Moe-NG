import { describe, expect, it } from "vitest";

import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import { deriveGoalCatalog, relativeActivityLabel } from "./goal-catalog-model.js";

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
      goalCountLabel: "Waiting for goals",
      goals: [],
    });
    expect(deriveGoalCatalog(catalog([]))).toMatchObject({
      comingOnlineNote: "This project has no durable goals yet.",
      goalCountLabel: "0 goals",
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

    expect(data.goalCountLabel).toBe("2 goals");
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
      "Could not reach the daemon"],
    [{ connection: "CONNECTED", detail: "GOAL_CATALOG_READ_PROJECT_MISMATCH", goals: [], outcome: "REFUSED" },
      "The goals could not be read"],
    [{ connection: "CONNECTED", detail: "LIVE_GOAL_CATALOG_UNREADABLE", goals: [], outcome: "UNREADABLE" },
      "The goals could not be read"],
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

describe("deriveGoalCatalog with the daemon's PRD coverage", () => {
  const entry = {
    binding: null, brief: { instructions: "build", title: "Build it" }, goalId: "goal-cov",
    planningRunRef: "run-cov", truthClass: "DAEMON_VERIFIED",
  } as const;
  const coverage = (
    verified: number, criteria: number, gate1: "APPROVED" | "PENDING",
  ): DocumentCoverageOutcome => ({
    contracts: [{
      contractId: "contract-1", gate1, plane: "V1", requirements: [], revisionDigest: "d".repeat(64),
      revisionId: "rev-1",
    }],
    document: { byteLength: 10, contentSha256: "b".repeat(64), displayPath: "PRD.md" },
    goals: [{ goalId: "goal-cov", lastActivityAt: "2026-09-02T19:00:00.000Z", lifecycle: "EXECUTION_ENABLED", planningRunRef: "run-cov", title: "Build it" }],
    sections: null,
    status: "COVERAGE",
    totals: { contracts: 1, criteria, goals: 1, planned: 0, requirements: 1, unattributable: 0, verified },
  });

  it("turns the daemon's verified count into the card's progress bar and headline", () => {
    const [card] = deriveGoalCatalog(catalog([entry]), new Map([["goal-cov", coverage(3, 10, "APPROVED")]])).goals;
    expect(card).toMatchObject({
      headline: "3 of 10 acceptance criteria verified \u00b7 contract approved",
      headlineTone: "accent",
      needsYou: false,
      progress: { done: 3, noun: "acceptance criteria verified", total: 10 },
      progressComingOnline: undefined,
      state: "ACTIVE",
    });
  });

  it("marks a fully verified, approved contract as verified and a pending gate as needing you", () => {
    const done = deriveGoalCatalog(catalog([entry]), new Map([["goal-cov", coverage(10, 10, "APPROVED")]])).goals[0];
    expect(done).toMatchObject({
      headline: "All 10 acceptance criteria verified \u00b7 contract approved",
      headlineTone: "verified", needsYou: false, progress: { done: 10, total: 10 },
    });
    const pending = deriveGoalCatalog(catalog([entry]), new Map([["goal-cov", coverage(10, 10, "PENDING")]])).goals[0];
    expect(pending).toMatchObject({
      headline: "10 of 10 acceptance criteria verified \u00b7 Gate 1 pending",
      headlineTone: "accent", needsYou: true,
    });
  });

  it("leaves the card untouched without coverage, or with a refusal, or with no contract", () => {
    const plain = deriveGoalCatalog(catalog([entry])).goals[0];
    expect(plain?.progress).toBeUndefined();
    const refused = deriveGoalCatalog(catalog([entry]), new Map([["goal-cov", {
      code: "DOCUMENT_COVERAGE_READ_CAPABILITY_DENIED", layer: "DOCUMENT_COVERAGE_READ", status: "REFUSED",
    }]])).goals[0];
    expect(refused).toStrictEqual(plain);
    const unbound = deriveGoalCatalog(catalog([entry]), new Map([["goal-cov", {
      code: "DOCUMENT_COVERAGE_READ_GOAL_UNBOUND", layer: "DOCUMENT_COVERAGE_READ", status: "REFUSED",
    }]])).goals[0];
    expect(unbound?.progress).toBeUndefined();
    expect(unbound?.progressComingOnline).toBe("No PRD is bound to this goal.");
    expect(unbound?.progressNote).toBe("No PRD bound to this goal");
    const uncontracted = deriveGoalCatalog(catalog([entry]), new Map([["goal-cov", {
      ...coverage(0, 0, "APPROVED"), contracts: [],
      totals: { contracts: 0, criteria: 0, goals: 1, planned: 0, requirements: 0, unattributable: 0, verified: 0 },
    }]])).goals[0];
    expect(uncontracted?.progress).toBeUndefined();
    expect(uncontracted?.progressComingOnline).toBe("No Product Contract cites this goal PRD yet.");
    expect(uncontracted?.progressNote).toBe("No contract cites the PRD yet");
  });
});

describe("deriveGoalCatalog maps the coverage read's goal lifecycle onto the state pill", () => {
  const entry = {
    binding: null, brief: { instructions: "build", title: "Build it" }, goalId: "goal-cov",
    planningRunRef: "run-cov", truthClass: "DAEMON_VERIFIED",
  } as const;
  const withLifecycle = (lifecycle: string | null): DocumentCoverageOutcome => ({
    contracts: [{
      contractId: "contract-1", gate1: "APPROVED", plane: "V1", requirements: [], revisionDigest: "d".repeat(64),
      revisionId: "rev-1",
    }],
    document: { byteLength: 10, contentSha256: "b".repeat(64), displayPath: "PRD.md" },
    goals: [{ goalId: "goal-cov", lastActivityAt: null, lifecycle, planningRunRef: "run-cov", title: "Build it" }],
    sections: null,
    status: "COVERAGE",
    totals: { contracts: 1, criteria: 2, goals: 1, planned: 0, requirements: 1, unattributable: 0, verified: 2 },
  });
  it.each([
    ["COMPLETED", "DONE"], ["EXECUTION_ENABLED", "ACTIVE"], ["CLOSING", "ACTIVE"],
    ["PLAN_REVIEW", "DRAFT"], ["DRAFT", "DRAFT"], [null, "DRAFT"],
  ])("lifecycle %s renders as %s", (lifecycle, state) => {
    const card = deriveGoalCatalog(catalog([entry]), new Map([["goal-cov", withLifecycle(lifecycle)]])).goals[0];
    expect(card?.state).toBe(state);
  });
});


describe("relativeActivityLabel", () => {
  const NOW = Date.parse("2026-09-02T20:00:00.000Z");
  it("speaks the age of the last decision in the unit a person would use", () => {
    expect(relativeActivityLabel("2026-09-02T19:59:40.000Z", NOW)).toBe("Last activity just now");
    expect(relativeActivityLabel("2026-09-02T19:35:00.000Z", NOW)).toBe("Last activity 25 min ago");
    expect(relativeActivityLabel("2026-09-02T14:00:00.000Z", NOW)).toBe("Last activity 6 h ago");
    expect(relativeActivityLabel("2026-08-30T20:00:00.000Z", NOW)).toBe("Last activity 3 d ago");
    expect(relativeActivityLabel(null, NOW)).toBeUndefined();
    expect(relativeActivityLabel("not a time", NOW)).toBeUndefined();
  });

  it("reaches the card as lastEventLabel from the coverage read's goal row", () => {
    const entry = {
      binding: null, brief: { instructions: "build", title: "Build it" }, goalId: "goal-1",
      planningRunRef: "run-1", truthClass: "DAEMON_VERIFIED",
    } as const;
    const outcome: DocumentCoverageOutcome = {
      contracts: [], document: { byteLength: null, contentSha256: "b".repeat(64), displayPath: null },
      goals: [{ goalId: "goal-1", lastActivityAt: "2026-09-02T19:35:00.000Z", lifecycle: "PLANNING",
        planningRunRef: "run-1", title: "Build it" }],
      sections: null, status: "COVERAGE",
      totals: { contracts: 0, criteria: 0, goals: 1, planned: 0, requirements: 0, unattributable: 0, verified: 0 },
    };
    const card = deriveGoalCatalog(catalog([entry]), new Map([["goal-1", outcome]]), NOW).goals[0];
    expect(card?.lastEventLabel).toBe("Last activity 25 min ago");
  });
});
