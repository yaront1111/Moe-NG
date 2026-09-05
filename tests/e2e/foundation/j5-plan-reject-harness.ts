/**
 * J5 mechanics: get a source-bound goal to the point where the REAL wrapper will staff a REAL
 * compiler seat, then read back what that seat actually received.
 *
 * WHAT IS REUSED AND WHY. The whole world-and-contract prelude is `multi-node-journey.ts`'s,
 * because it is already the only module that drives the PLANNING lane over real HTTP with the
 * shipped command kinds. What is NOT reused is J4: `j4-replan-harness.ts` drives
 * `qualification.replan`, the NODE-level rejection lane, and has no goal, no contract and no
 * compiler step in it. The step's premise that J4 could be parameterised into this journey does
 * not survive measurement - the two lanes share a daemon and nothing else.
 *
 * WHAT THIS ADDS to the multi-node prelude is the one thing that journey deliberately does NOT
 * do: it submits the decomposition ITSELF over HTTP, so no seat is ever staffed. J5 stops one
 * command short and lets the WRAPPER staff a compiler seat, because the mission that seat
 * receives is the whole subject of this row.
 *
 * NO WALL CLOCK AND NO RANDOM SOURCE: `e2e-harness.test.ts` scans every non-test module in this
 * directory for four needles by plain substring match. Every clock reading arrives as a
 * PARAMETER from the test file, which the scan excludes; scratch uniqueness is `mkdtempSync`'s.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  readDurableLedger, stateOf,
} from "../../../apps/daemon/src/bootstrap/bootstrap-ledger.js";
import { readGraphBody } from "../../../apps/daemon/src/planning/graph-body-record.js";

import { withStore } from "./multi-node-reads.js";
import {
  AGENT_SECRET,
  AGENT_SESSION,
  CONTRACT_ID,
  GOAL_CREATE_COMMAND_ID,
  GOAL_ID,
  HUMAN_SECRET,
  HUMAN_SESSION,
  PRD_TEXT,
  REVISION_ID,
  createMultiNodeScratch,
  revisionDraft,
} from "./multi-node-graph-harness.js";
import type { MultiNodeScratch } from "./multi-node-graph-harness.js";
import {
  IS_WINDOWS,
  REPOSITORY_ROOT,
  runWrapper,
} from "./j1-loop-harness.js";
import type { ProcessRun } from "./j1-loop-harness.js";
import {
  type DaemonWire,
  type Frame,
  type SurfaceView,
  answered,
  asObject,
  command,
  offerFor,
  send,
} from "./multi-node-wire.js";
import {
  CORRELATION_ID,
  mintHumanPrincipal,
  openSession,
  worldPrelude,
} from "./multi-node-world.js";
import type { JourneyClock } from "./multi-node-world.js";

export type { JourneyClock } from "./multi-node-world.js";

const COMPILER_AGENT = "tests/e2e/foundation/j5-compiler-agent.mjs";
/** `approval-activation.ts:180` and `graph-activation-service.ts:236` both commit this type. */
export const ACTIVATION_EVENT_TYPE = "GoalExecutionEnabled";
/** The node keys `j5-compiler-agent.mjs` plans under, before and after reading a rejection. */
export const FIRST_NODE_KEY = "node-first-attempt";
export const SECOND_NODE_KEY = "node-second-attempt";
/** The goal's own operator brief, spelled ONCE so the mission assertion cannot drift from it. */
export const GOAL_BRIEF = "Build the goal the operator described.";

export interface J5Scratch extends MultiNodeScratch {
  /** Where the seat double echoes every mission it is actually handed. */
  readonly missionsDir: string;
}

/**
 * The multi-node scratch plus one directory the seat double writes into.
 *
 * The three node workspaces the multi-node scratch builds are surplus here - J5 never reaches
 * delivery - but taking the scratch whole rather than forking it keeps ONE definition of the
 * project id, the credential, the store path and the specs directory. A second scratch builder
 * that drifted by one literal would produce a plausible world no journey ever asserted about.
 */
export function createJ5Scratch(): J5Scratch {
  const scratch = createMultiNodeScratch();
  const missionsDir = join(scratch.root, "missions");
  mkdirSync(missionsDir);
  return { ...scratch, missionsDir };
}

/**
 * The shim MOE_AGENT_COMMAND points at, carrying the two facts the agent cannot otherwise learn.
 *
 * `agentSpawnInvocation` quotes the COMMAND ITSELF for cmd.exe, so a multi-word
 * MOE_AGENT_COMMAND becomes one quoted token and cannot work; and `agentEnvironment()` scrubs
 * every non-allowlisted key and drops all `MOE_*`, so no env var reaches the agent. The shim is
 * therefore the ONLY channel for `--mission-dir`, exactly as `writeAgentShim` is for `--arm`.
 */
export function writeCompilerShim(scratch: J5Scratch): string {
  const agent = join(REPOSITORY_ROOT, COMPILER_AGENT);
  const flags = `--mission-dir "${scratch.missionsDir}"`;
  if (!IS_WINDOWS) {
    const path = join(scratch.root, "j5-compiler.sh");
    writeFileSync(path, ["#!/bin/sh", `exec node "${agent}" ${flags} "$@"`, ""].join("\n"), {
      encoding: "utf8", mode: 0o755,
    });
    return path;
  }
  const path = join(scratch.root, "j5-compiler.cmd");
  writeFileSync(path, ["@echo off", `node "${agent}" ${flags} %*`, ""].join("\r\n"), "utf8");
  return path;
}

/**
 * One REAL wrapper pass whose seats are all the compiler double.
 *
 * `runWrapper` applies `options.environment` LAST, so overriding MOE_AGENT_COMMAND replaces the
 * shim it would otherwise write while every other wrapper environment fact - the store trio,
 * ONCE mode - stays byte-identical to what every existing arm is handed.
 *
 * THREE SEATS, not one, and this was MEASURED rather than chosen. The seeded world leaves a
 * `plan.propose@run-live-1` step READY beside the goal's compiler step, and a one-seat pass
 * spends its only seat on it: the first run of this journey staffed `plan.propose` and never
 * reached the compiler at all. Widening the pass is the honest fix - the daemon decides which
 * steps are ready, and this journey asserts about ONE of them rather than starving the rest.
 */
export function runCompilerWrapper(scratch: J5Scratch, shim: string): Promise<ProcessRun> {
  return runWrapper(scratch, "complete", {
    environment: { MOE_AGENT_COMMAND: shim, MOE_WRAPPER_MAX_AGENTS: "3", MOE_WRAPPER_ONCE: "1" },
  });
}

/** Every mission a seat actually received, in the order the double echoed them. */
export function echoedMissions(scratch: J5Scratch): readonly string[] {
  return readdirSync(scratch.missionsDir)
    .filter((name) => name.startsWith("mission-") && name.endsWith(".txt"))
    .sort((left, right) => ordinalOf(left) - ordinalOf(right))
    .map((name) => readFileSync(join(scratch.missionsDir, name), "utf8"));
}

/**
 * The missions staffed onto THIS goal's compiler step, discriminated by the command kind the
 * mission states about itself.
 *
 * A pass staffs whatever the daemon says is ready, and the seeded world has an unrelated
 * `plan.propose` step in it. Filtering on the kind rather than on an ordinal keeps the arms
 * about the compiler seat even when the wrapper legitimately staffs something else beside it.
 */
export function compilerMissions(scratch: J5Scratch): readonly string[] {
  return echoedMissions(scratch)
    .filter((mission) => mission.includes("(command kind planning.submit_decomposition)"));
}

/** `mission-10.txt` must sort after `mission-2.txt`; a plain string sort puts it first. */
function ordinalOf(name: string): number {
  return Number(name.slice("mission-".length, -".txt".length));
}

/** The goal's own PRD sha, read off the daemon rather than digested a second time here. */
async function sourceDigest(wire: DaemonWire): Promise<string> {
  const frame = answered(
    "/goals/source/read", "GOAL_SOURCE",
    await wire.post("/goals/source/read", { goalRef: GOAL_ID }),
  );
  const sha = frame["contentSha256"];
  if (typeof sha !== "string") {
    throw new Error(`the goal source states no sha: ${JSON.stringify(frame)}`);
  }
  return sha;
}

/** The Gate 1 card's own read: the pending revision plus the daemon-minted approval template. */
async function gate1Template(wire: DaemonWire): Promise<{ approval: Frame; ref: Frame }> {
  const frame = answered(
    "/product-contract/pending/read", "PENDING",
    await wire.post("/product-contract/pending/read", { goalRef: GOAL_ID }),
  );
  const approval = asObject(frame["approval"]);
  const ref = asObject(frame["ref"]);
  if (approval === null || ref === null) {
    throw new Error(`the pending read withheld the template: ${JSON.stringify(frame)}`);
  }
  return { approval, ref };
}

/**
 * The world, the source-bound goal and the Gate-1-approved contract - everything a compiler seat
 * needs to exist, and nothing it would do itself.
 *
 * This is `sealMultiNodeGraph` STOPPED one command early, on purpose: that journey submits the
 * decomposition over HTTP as the agent, which is precisely the step J5 hands to a real staffed
 * seat instead.
 */
export async function preludeThroughGate1(
  scratch: J5Scratch, wire: DaemonWire, clock: JourneyClock,
): Promise<void> {
  for (const planned of worldPrelude(scratch, clock)) await send(wire, planned);

  await send(wire, command(CORRELATION_ID, {
    commandId: GOAL_CREATE_COMMAND_ID,
    commandKind: "goal.create_with_source",
    payload: {
      instructions: GOAL_BRIEF,
      source: { displayPath: "prd.md", mediaType: "text/markdown", text: PRD_TEXT },
      title: "Three nodes, one goal",
    },
    targetAggregateId: GOAL_ID,
  }));

  await openSession(wire, AGENT_SESSION, AGENT_SECRET);
  await openSession(wire, HUMAN_SESSION, HUMAN_SECRET);
  mintHumanPrincipal(scratch, clock, HUMAN_SESSION);

  await send(wire, command(CORRELATION_ID, {
    commandId: "cmd-j5-propose-revision",
    commandKind: "product_contract.propose_revision",
    payload: { draft: revisionDraft(await sourceDigest(wire)), goalRef: GOAL_ID },
    targetAggregateId: GOAL_ID,
  }), AGENT_SECRET);

  const template = await gate1Template(wire);
  await send(wire, command(CORRELATION_ID, {
    commandId: String(template.approval["commandId"]),
    commandKind: "product_contract.approve_gate_1",
    payload: {
      authentication: {
        issuedAt: clock.nowMs,
        kind: "BEARER",
        requestDigest: template.approval["requestDigest"],
        requestId: template.approval["commandId"],
      },
      contractId: template.ref["contractId"],
      revisionDigest: template.ref["revisionDigest"],
      revisionId: template.ref["revisionId"],
    },
    targetAggregateId: String(asObject(template.approval["affordance"])?.["targetAggregateId"]),
  }), HUMAN_SECRET);
  // Named so a reader knows the gate the seat's own contract read will answer with.
  if (String(template.ref["contractId"]) !== CONTRACT_ID
    || String(template.ref["revisionId"]) !== REVISION_ID) {
    throw new Error(`gate 1 approved an unexpected revision: ${JSON.stringify(template.ref)}`);
  }
}

/**
 * Every `GoalExecutionEnabled` event on the goal aggregate, read straight off the store.
 *
 * This is the ACTIVATION the operator's APPROVE produces, and it is read from the durable event
 * stream rather than from the affordance surface: a surface answers what is offered NEXT, which
 * a run can reach for reasons other than an activation actually having been committed.
 */
export function activationEvents(scratch: J5Scratch): readonly string[] {
  return withStore(scratch, (store) => store.readEvents(GOAL_ID)
    .map((event) => event.eventType)
    .filter((eventType) => eventType === ACTIVATION_EVENT_TYPE));
}

/**
 * The node keys the graph sealed on ONE run, read through the daemon's own body reader.
 *
 * The wrapper's stdout says which key the seat submitted, but stdout is a REPORT: it is right
 * about a submit that the store then refused. The sealed body is the durable answer, and it is
 * what makes "a DIFFERENT decomposition" a fact rather than a log line.
 */
export function sealedNodeKeysOf(scratch: J5Scratch, runId: string): readonly string[] {
  return withStore(scratch, (store) => {
    const run = asObject(stateOf(readDurableLedger(store, scratch.projectId), runId) as never);
    const sealed = asObject(asObject(run?.["state"])?.["sealedHashes"]);
    const hash = sealed?.["graphContentHash"];
    if (typeof hash !== "string") return [];
    const body = readGraphBody(store, scratch.projectId, hash);
    return body.ok
      ? body.content.snapshot.nodes.map((node) => node.nodeKey).sort()
      : [];
  });
}

export interface PlanDecision {
  /** The run the operator decided on - the daemon's own, read off the offer. */
  readonly runId: string;
}

/**
 * THE OPERATOR'S DECISION, over the REAL HTTP wire under the durable HUMAN principal's session.
 *
 * The offer is read off the surface rather than assembled here, so the run identity the operator
 * decides is the daemon's own; a locally derived successor id would be this file's arithmetic.
 */
export async function decidePlan(
  wire: DaemonWire, surface: SurfaceView, decision: "APPROVE" | "REJECT", reason: string | null,
): Promise<PlanDecision> {
  const offer = offerFor(surface, "approval.decide_intent");
  const runId = String(offer["targetAggregateId"]);
  await send(wire, command(CORRELATION_ID, {
    commandId: String(offer["commandId"]),
    commandKind: "approval.decide_intent",
    expectedVersion: Number(offer["expectedVersion"]),
    payload: {
      decision,
      decisionReason: reason,
      dependencyChanges: { additions: [], challenges: [], removals: [] },
      runId,
    },
    targetAggregateId: runId,
  }), HUMAN_SECRET);
  return Object.freeze({ runId });
}
