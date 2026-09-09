import type { RunNodeStatus } from "../../live/live-runs.js";

/** Daemon node statuses in a person's words. */
export const STATUS_WORDS: Readonly<Record<RunNodeStatus, string>> = Object.freeze({
  ACCEPTED: "Accepted",
  BLOCKED: "Ledger unreadable",
  DELIVERED: "Delivered, awaiting the verifier",
  ESCALATED: "Escalated",
  ESCALATION_REQUIRED: "Needs escalation",
  IN_PROGRESS: "In progress",
  READY: "Ready for an agent",
  REPLANNED: "Replanned into a successor goal",
  UNATTRIBUTABLE: "Legacy execution needs attribution",
});

export const GOAL_WORDS: Readonly<Record<string, string>> = Object.freeze({
  CANCELLED: "Cancelled", CLOSING: "Closing", COMPLETED: "Done", DRAFT: "Draft",
  EXECUTION_ENABLED: "Active", PLANNING: "Planning", PLAN_REVIEW: "Plan in review",
});

export const RUN_WORDS: Readonly<Record<string, string>> = Object.freeze({
  ACTIVATED: "activated", APPROVED: "approved", CANCELLED: "cancelled", DRAFT: "draft",
  PLANNING: "planning", PLAN_REVIEW: "plan in review", READY: "ready", REJECTED: "rejected",
  SUBMISSION_DRAINING: "submitting",
});
