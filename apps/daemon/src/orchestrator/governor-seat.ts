import { spawnSync } from "node:child_process";

import { GOVERNANCE_TEXT_MAX_LENGTH, validGovernanceDecision }
  from "../review/governance-decision-ledger.js";
import type { GovernanceDecisionInput } from "../review/governance-decision-ledger.js";
import type { GovernanceAdvisor, GovernanceBrief, GovernanceAnswer }
  from "../review/governance-escalation-decider.js";

/**
 * The seat that actually answers an exhausted review.
 *
 * WHY A PROCESS AND NOT A HEURISTIC. The questions that exhaust a review are product questions —
 * "should this field hold one value or several?" — and the only honest answers come from reading
 * the product record. Nothing in the daemon can do that, and a daemon that guessed would be
 * inventing product decisions nobody authored. So governance asks a model, in a process, exactly
 * as the verifier runs a recipe in a process.
 *
 * WHY IT IS MODELLED ON THE VERIFIER AND NOT ON A SEAT. A staffed seat returns a pid; its answer
 * would have to come back through a claim, a session and the command surface — and the one
 * command that matters here is reserved to `daemon:governor`, which no minted session may hold.
 * A one-shot process that prints its answer needs none of that: no claim, no credential, no
 * repository hold, and nothing it can commit on its own.
 *
 * IT CANNOT INVENT ITS WAY PAST THE GATE. Every path that does not produce a well-formed,
 * fully-sourced answer returns null, and null means the node is handed to the human with its
 * work untouched — never retried on a guess, and never retired. A dead
 * process, a timeout, a missing fence, unparsable JSON, a citation naming nothing or a decision
 * reasoning nothing all land in the same place. Governance answering wrongly is a worse failure
 * than governance not answering, so every ambiguity resolves to not answering.
 *
 * THE PRD DECIDES FIRST. The prompt says so, and the record proves it: an answer claiming
 * `PRD_CITED` must name where it read it, and one claiming `GOVERNANCE_DECIDED` must say why the
 * record was silent. `validGovernanceDecision` enforces both, here, before anything is spent.
 */

export const GOVERNANCE_FENCE_BEGIN = "BEGIN GOVERNANCE DECISION" as const;
export const GOVERNANCE_FENCE_END = "END GOVERNANCE DECISION" as const;

/** Bounds on what is handed to a model and what is read back. */
const MAX_QUESTIONS = 8;
const MAX_DETAIL_CHARS = 2_000;
const MAX_OUTPUT_CHARS = 200_000;
const DEFAULT_TIMEOUT_MS = 300_000;

export interface GovernorRunResult {
  readonly output: string;
  readonly ok: boolean;
}

/** Runs one prompt and returns what it printed. Injected so tests never spawn a model. */
export type GovernorRunner = (prompt: string) => GovernorRunResult;

export interface GovernorSeatConfig {
  /**
   * Background the seat may cite: the product record, as the project states it. Called with the
   * brief so a host can supply only what the questions name. Absent means the seat answers from
   * the findings alone, and will usually have to record GOVERNANCE_DECIDED rather than cite.
   */
  readonly documents?: (brief: GovernanceBrief) => string;
  readonly log: (line: string) => void;
  readonly run: GovernorRunner;
}

/**
 * What the seat is asked. The question text is the finding's own words, so the seat answers what
 * review actually objected to rather than a paraphrase of it.
 */
export function governorPrompt(brief: GovernanceBrief, documents: string): string {
  const questions = brief.questions.slice(0, MAX_QUESTIONS).map((question, index) =>
    [
      `${String(index + 1)}. [${question.severity}] ${question.findingId}`,
      question.criterionId === null ? null : `   Criterion: ${question.criterionId}`,
      `   ${question.detail.slice(0, MAX_DETAIL_CHARS)}`,
    ].filter((line) => line !== null).join("\n")).join("\n\n");
  return [
    "You are the governor for this project. A node's code review is exhausted: it reported the",
    "questions below and cannot answer them itself, and until they are answered the work stops.",
    "Answer them so the work can continue.",
    "",
    "THE PRODUCT RECORD DECIDES FIRST. If the approved record already answers a question, your",
    "job is to locate that answer, not to make one: record PRD_CITED and name exactly where you",
    "read it. Only when the record is genuinely silent do you decide yourself: record",
    "GOVERNANCE_DECIDED and say why. Never cite a source that does not answer the question, and",
    "never leave a decision unreasoned. If you cannot answer a question honestly, omit it.",
    "",
    "Your answer is recorded durably and the node acts on it. Do not waive any approved",
    "requirement, criterion or check; answer the open question and nothing wider.",
    "",
    `NODE: ${brief.subjectRef}`,
    "",
    "OPEN QUESTIONS:",
    questions,
    ...(documents.trim().length === 0 ? [] : ["", "PRODUCT RECORD:", documents]),
    "",
    "Reply with nothing but this block:",
    GOVERNANCE_FENCE_BEGIN,
    "{",
    '  "guidance": "the instructions the node will act on, under 4000 characters",',
    '  "decisions": [',
    '    { "findingId": "...", "answer": "...", "basis": "PRD_CITED" | "GOVERNANCE_DECIDED",',
    '      "citation": "where the record answers it, or null", "rationale": "why, or empty when cited" }',
    "  ]",
    "}",
    GOVERNANCE_FENCE_END,
  ].join("\n");
}

function fencedJson(output: string): unknown {
  // The LAST block, not the first: a model that restates the requested shape before answering
  // would otherwise have the template — whose decisions list is empty — parsed as its answer.
  // Taking the first begin and the last end instead would swallow both blocks and the prose
  // between them, which parses as nothing at all.
  const begin = output.lastIndexOf(GOVERNANCE_FENCE_BEGIN);
  const end = begin === -1 ? -1 : output.indexOf(GOVERNANCE_FENCE_END, begin);
  if (begin === -1 || end === -1 || end <= begin) return null;
  const body = output.slice(begin + GOVERNANCE_FENCE_BEGIN.length, end).trim();
  try { return JSON.parse(body); } catch { return null; }
}

const text = (value: unknown): string => typeof value === "string" ? value : "";

/**
 * One reported decision, bound to the brief. The seat names WHICH question it answered and
 * nothing else about the binding: the node, the review version and the question text come from
 * the brief the daemon built, so a seat cannot record an answer against another node or claim a
 * question review never asked.
 */
function decisionOf(
  value: unknown, brief: GovernanceBrief,
): GovernanceDecisionInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const reported = value as Record<string, unknown>;
  const asked = brief.questions.find((question) => question.findingId === reported["findingId"]);
  if (asked === undefined) return null;
  const basis = reported["basis"];
  if (basis !== "PRD_CITED" && basis !== "GOVERNANCE_DECIDED") return null;
  const citation = reported["citation"];
  const input: GovernanceDecisionInput = {
    answer: text(reported["answer"]),
    basis,
    citation: basis === "PRD_CITED" ? text(citation) : null,
    criterionId: asked.criterionId,
    findingId: asked.findingId,
    question: asked.detail.slice(0, MAX_DETAIL_CHARS),
    rationale: basis === "PRD_CITED" ? text(reported["rationale"]) : text(reported["rationale"]),
    reviewVersion: brief.reviewVersion,
    subjectRef: brief.subjectRef,
    supersedes: null,
  };
  return validGovernanceDecision(input) ? input : null;
}

export function readGovernorAnswer(
  output: string, brief: GovernanceBrief,
): GovernanceAnswer | null {
  const parsed = fencedJson(output.slice(0, MAX_OUTPUT_CHARS));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;
  const guidance = text(body["guidance"]).trim();
  if (guidance.length === 0 || guidance.length > GOVERNANCE_TEXT_MAX_LENGTH
    || !guidance.isWellFormed()) return null;
  const reported = body["decisions"];
  if (!Array.isArray(reported)) return null;
  const decisions: GovernanceDecisionInput[] = [];
  for (const entry of reported) {
    const decision = decisionOf(entry, brief);
    // One malformed decision voids the answer. A partial answer would fund an attempt while
    // leaving the record claiming fewer decisions than the guidance actually acts on.
    if (decision === null) return null;
    decisions.push(decision);
  }
  return decisions.length === 0 ? null : { decisions, guidance };
}

export function createGovernorSeat(config: GovernorSeatConfig): GovernanceAdvisor {
  return function governorSeat(brief: GovernanceBrief): GovernanceAnswer | null {
    let documents = "";
    try { documents = config.documents?.(brief) ?? ""; } catch { documents = ""; }
    let result: GovernorRunResult;
    try {
      result = config.run(governorPrompt(brief, documents));
    } catch {
      config.log(`[governance] ${brief.subjectRef}: the governor seat could not be run; no answer`);
      return null;
    }
    if (!result.ok) {
      config.log(`[governance] ${brief.subjectRef}: the governor seat failed; no answer`);
      return null;
    }
    const answer = readGovernorAnswer(result.output, brief);
    if (answer === null) {
      config.log(`[governance] ${brief.subjectRef}: the governor seat returned no usable decision; no answer`);
      return null;
    }
    const cited = answer.decisions.filter((decision) => decision.basis === "PRD_CITED").length;
    config.log(`[governance] ${brief.subjectRef}: the governor answered ${String(answer.decisions.length)} question(s), ${String(cited)} from the product record`);
    return answer;
  };
}

/**
 * The default runner: the project's own agent command, one-shot, reading nothing back but what
 * it prints. `claude -p` and `codex exec` are the two print modes this repository already
 * launches; anything else is passed the prompt as its single argument.
 */
export function createProviderGovernorRunner(options: {
  readonly command: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}): GovernorRunner {
  const leaf = options.command.toLowerCase();
  const args = (prompt: string): readonly string[] =>
    leaf.includes("codex") ? ["exec", prompt] : ["-p", prompt];
  return function run(prompt: string): GovernorRunResult {
    // Synchronous on purpose: the wrapper pass is synchronous, and a governor that answered
    // later would race the very pass that is deciding whether to staff the node.
    //
    // `shell: false` is not a detail. The prompt carries a node's own review findings — text
    // this process did not author — and handing that to a shell would make a finding's contents
    // executable. The timeout and the buffer cap bound the other two ways a seat can fail to
    // return: never finishing, and printing without end.
    const result = spawnSync(options.command, [...args(prompt)], {
      cwd: options.cwd,
      encoding: "utf8",
      env: options.environment ?? process.env,
      maxBuffer: 8 * 1_024 * 1_024,
      shell: false,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      windowsHide: true,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    return { ok: result.error === undefined && result.status === 0, output };
  };
}
