import type { GoalStatus } from "./goal-status.js";

/**
 * THE WORDS AND ANCHORS OF WHERE AN OPENED GOAL STANDS: the stage word for each status
 * goal-status.ts derives, and the page ids its next step links to. The board header
 * (board-header.tsx) renders them; it links to the section that carries the step, it never acts.
 */

export const STAGE_WORDS: Readonly<Record<GoalStatus["stage"], string>> = Object.freeze({
  CLOSED: "Closed",
  CONTRACT: "Contract at Gate 1",
  ESCALATION: "Review exhausted",
  NO_PRD: "No PRD",
  PLAN: "Plan review",
  PLAN_REJECTED: "Plan sent back",
  PREVIEW: "Gate 2: your product is running",
  READY_TO_CLOSE: "Ready to close",
  REPLANNED: "Replanned",
  UNKNOWN: "Reading",
  WORKING: "Agents working",
});

/** The page anchors the opened goal's sections carry; the header links, the page owns the ids. */
export const GOAL_SECTION_IDS = Object.freeze({
  activity: "cr-goal-activity", board: "cr-goal-board", contract: "cr-goal-contract",
  // The anchor the unset-variables card links to. It is an ANCHOR, not a stage: STAGE_WORDS
  // state where the GOAL stands, and unset variables are a fact about an environment rather
  // than a lifecycle position.
  environments: "cr-goal-environments",
  plan: "cr-goal-plan", publish: "cr-goal-publish",
});
