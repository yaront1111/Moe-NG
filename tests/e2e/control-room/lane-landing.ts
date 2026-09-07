/**
 * A REAL LANDING, DRIVEN THROUGH THE REAL WRAPPER, for the deploy lane only.
 *
 * WHY THIS EXISTS. `repository.publish`'s last check refuses PUBLISH_GOAL_NOT_INTEGRATED while
 * the goal's execution-bearing nodes have no COMMITTED landing receipt
 * (`publication-goal-integration.ts:24`, `receipts.length === 0`), and `deployment.deploy`'s
 * prerequisite table (`bootstrap-sequence.ts:55`) reads a COMMITTED `repository.publish`
 * DECISION. So the deploy lane cannot reach the fake docker double until something LANDS.
 *
 * NOTHING IS SEEDED. The receipt is written by `node-lander.ts` running inside a real
 * `agent-wrapper-main.ts`, over the real delivery coordinator: baseline, seat, verifier,
 * landing. `seedLandingReceipt` in the daemon's own fixtures writes a literal sha and a
 * `D:/fixture-workspace` path, and a publish measured against that would be fabricated
 * authority - the exact thing DoD 2/3 forbid. Here the sha is git's.
 *
 * ONE THING IS A DOUBLE, AND IT IS THE SAME ONE `wrapper-lane.ts` DOUBLES: the seat. A real
 * provider seat cannot be asked to produce a specific edit on cue, and this lane is not
 * certifying provider behaviour - it needs a node whose files DIFFER from the staffing
 * baseline so the lander has something to commit. Everything downstream of the seat's exit is
 * the shipped wrapper.
 *
 * TEARDOWN IS OWNED HERE. The wrapper is killed in a `finally` on every exit path including the
 * refusing ones (epic rail 4), and its pid is returned so the caller's teardown assertion can
 * prove it. A leaked wrapper would keep staffing against a store the lane is about to delete.
 */
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { SqliteEventStore } from "@moe/store";

import { activeCompiledGraphs, createCompiledNodeSource } from "../../../apps/daemon/src/orchestrator/compiled-node-source.js";
import { legacyCompiledNodeKeys } from "../../../apps/daemon/src/orchestrator/compiled-node-identity.js";
import { killTree } from "./daemon-children.js";
import { laneWorkspaceIdentity } from "./daemon-ports.js";
import type { DaemonLane, LaneScratch } from "./daemon-ports.js";
import { LANDED_PATH } from "./lane-landing-contract.js";
import { submitLaneRound } from "./lane-review-round.js";
import { WRAPPER_INTERVAL_MS, resolveLaneScratch, startWrapper, wrapperEnv } from "./wrapper-lane.js";

export { LANDED_PATH } from "./lane-landing-contract.js";

/** Baseline, seat spawn, a verifier run and a commit, at a 500 ms wrapper interval. */
export const LANDING_BUDGET_MS = 180_000;

/**
 * How long the lane waits for the seat double to write its one file.
 *
 * The seat is spawned on the wrapper's first pass and writes before it exits, so this is
 * generous by an order of magnitude; it exists so a seat that never runs is reported as
 * SEAT_NEVER_WROTE with the wrapper's own transcript, rather than waiting out the whole
 * landing budget and blaming the lander for a staffing failure.
 */
const SEAT_WRITE_BUDGET_MS = 60_000;

/**
 * Staffing tries per unmoved item, raised from the wrapper's default of 3.
 *
 * `repository-delivery-coordinator.ts:141-146` returns the reservation to RESERVED whenever the
 * seat exits while `readRepositoryDeliveryFacts` still says READY, and `agent-wrapper.ts:363`
 * charges an attempt for every staffing that did not move the item. The lane's round is
 * recorded from OUT OF PROCESS the moment the seat's file appears, so one or two of those
 * passes are spent before the node reaches SUBMITTED. Three is not enough headroom for that
 * handshake on a loaded box; the item still exhausts, so a genuinely stuck node cannot spin.
 */
const LANDING_STAFFING_ATTEMPTS = 20;

/**
 * TWO, so no single item can starve the one that has to land.
 *
 * `daemon-store-foundation-composition.ts:407` merges the operator's spec dir with the durable
 * graph's sealed execution nodes, and the board also carries `policy.validate`. `retireSpecNode`
 * removes the bare-key node, but a surface read that raced the removal, or any other READY item,
 * would hold the single seat while the compiled node waited. At two they proceed independently.
 */
const LANDING_MAX_AGENTS = 2;

/** What `createLaneScratch` writes as the seeded node's `test`. Exits 0 without touching disk. */
const LANE_NODE_TEST_COMMAND = "node --eval \"process.exit(0)\"";

/**
 * Retires the seeded SPEC node, which the shipped seed needs and the landing must not keep.
 *
 * THE SPEC NODE AND THE COMPILED NODE SHARE ONE KEY. The seed compiles its graph FROM the spec,
 * so `graph.content.snapshot.nodes[0].nodeKey` IS `scratch.nodeRef`. `compiled-node-identity.ts`
 * then calls that key LEGACY the moment anything executes under its BARE form - a
 * `wrapper-staffing/<sha256(node.deliver@<key>)>` aggregate is enough - and a legacy key is
 * dropped from `publication-goal-integration.ts:21`'s ref set AND quarantined out of
 * `createCompiledNodeSource` by `nodesBlockedByIdentity`. Measured on this lane: with the spec
 * node present the wrapper staffs the bare key, the compiled node answers NODE_BRIEF_MISSING,
 * and the publish refuses PUBLISH_GOAL_NOT_INTEGRATED against a ref set that is empty.
 *
 * So the file is removed AFTER the seed has run and BEFORE the wrapper starts. Both readers are
 * lazy (`daemon-store-foundation-composition.ts:404` builds its loader per call), so the daemon
 * stops offering the bare node on the same read. Nothing else on the lane is touched: the
 * directory stays, and every other spec keeps its spec node because they never call this.
 */
function retireSpecNode(scratch: LaneScratch): void {
  for (const name of readdirSync(scratch.nodeSpecsDir)) {
    if (name.endsWith(".json")) rmSync(join(scratch.nodeSpecsDir, name), { force: true });
  }
}

/**
 * The node ref a landing receipt must carry to COUNT, taken from the production source.
 *
 * `publication-goal-integration.ts:21` builds its ref set with `compiledExecutionRef`, so a
 * receipt filed under the seeded spec's BARE key (`node-e2e-<tag>`) is invisible to it and the
 * publish refuses PUBLISH_GOAL_NOT_INTEGRATED with a real landing sitting in the store -
 * measured on this lane at 01:1xZ. This asks `createCompiledNodeSource` for the answer, which
 * is the same call `daemon-store-foundation-composition.ts:397` makes, rather than recomputing
 * the ref here: a private copy of that hash would agree with itself and with nothing else.
 *
 * `workspace`/`testCommand` are null for the same reason the composition passes them null -
 * listing needs no host facts.
 */
export function laneCompiledNodeRef(scratch: LaneScratch): string | null {
  const store = SqliteEventStore.openForProject(scratch.storePath, scratch.projectId);
  try {
    return createCompiledNodeSource({
      projectId: scratch.projectId, store, testCommand: null, workspace: null,
    }).nodes()[0]?.nodeRef ?? null;
  } finally { store.close(); }
}

/**
 * Why the list above was empty, for a refusal that names a cause instead of an absence.
 *
 * `createCompiledNodeSource` swallows every read failure by design ("a degraded read lists
 * nothing rather than throwing the surface down"), so an empty list is silent about whether the
 * graph is missing, has no execution-bearing node, or had its key QUARANTINED as legacy. That
 * last one is the failure this lane actually hit, and it is invisible without this.
 */
export function laneCompiledNodeDiagnosis(scratch: LaneScratch): string {
  const store = SqliteEventStore.openForProject(scratch.storePath, scratch.projectId);
  try {
    const graphs = activeCompiledGraphs(store, scratch.projectId);
    const bearing = graphs.flatMap((graph) => graph.content.snapshot.nodes
      .filter((node) => node.executionBearing).map((node) => node.nodeKey));
    let legacy: string;
    try { legacy = [...legacyCompiledNodeKeys(store, scratch.projectId, graphs)].join(",") || "(none)"; }
    catch (error) { legacy = `unreadable: ${String(error)}`; }
    return `graphs=${String(graphs.length)} bearing=${bearing.join(",") || "(none)"} legacy=${legacy}`;
  } catch (error) { return `diagnosis unavailable: ${String(error)}`;
  } finally { store.close(); }
}

/** The lander's own words for a landing that produced a commit. */
// The closing bracket is ESCAPED. Under the `u` flag a lone `]` is a SyntaxError ("Lone
// quantifier brackets"), thrown at IMPORT, so an unescaped one takes every spec that imports
// this module down with it and `test:e2e:browser` finds no tests at all.
const COMMITTED_LINE = /^\[lander\] (\S+): COMMITTED /mu;

export interface LaneLanded {
  readonly ok: true;
  /** The workspace head AFTER the landing, read back from git rather than parsed from a log. */
  readonly sha: string;
  /** The wrapper's pid, for the caller's post-teardown orphan assertion. */
  readonly wrapperPid: number | null;
}

export interface LaneLandingRefused {
  readonly ok: false;
  /** The wrapper's own transcript. Its `[lander]`/`[verifier]` lines ARE the diagnosis. */
  readonly detail: string;
  readonly wrapperPid: number | null;
}

/**
 * Writes the landing seat double into `dir` and says which form this platform can run.
 *
 * THREE FILES FOR THE SAME REASON `wrapper-lane.ts` WRITES THREE: `agent-spawn-invocation.ts`
 * runs a win32 seat THROUGH cmd.exe as a command LINE, so the command has to be a `.cmd`; on
 * posix the spawner passes argv directly, so a `.sh` is the executable form. Both delegate to
 * one `.js` so the platforms cannot drift.
 *
 * The seat exits 0 - a landing needs an ACCEPTED node, and the wrapper classifies the exit
 * rather than asking the seat what happened. It ignores every argument the spawner appends,
 * because those are the provider CLI's own flags.
 *
 * IT DOES NOT REPORT ITS ROUND, and that is why `landLaneNode` records one: a real seat submits
 * its round over the MCP host the wrapper stands up, which a two-line script cannot reach. The
 * round only moves the node to SUBMITTED - `node-verifier.ts` then runs the node's own `test`
 * command before the daemon accepts anything, so the seat's word is not what earns the landing.
 */
export function landingSeatDouble(dir: string, workspace: string): { command: string } {
  const jsPath = join(dir, "landing-seat.js");
  const cmdPath = join(dir, "landing-seat.cmd");
  const shPath = join(dir, "landing-seat.sh");
  const target = JSON.stringify(join(workspace, LANDED_PATH));
  writeFileSync(jsPath,
    `require("node:fs").writeFileSync(${target}, "landed at " + new Date().toISOString() + "\\n");\n`
    + "process.exit(0);\n", "utf8");
  writeFileSync(cmdPath,
    `@echo off\r\n"${process.execPath}" "%~dp0landing-seat.js"\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
  writeFileSync(shPath,
    `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/landing-seat.js"\n`, "utf8");
  chmodSync(shPath, 0o755);
  return { command: process.platform === "win32" ? cmdPath : shPath };
}

/**
 * Runs the real wrapper against the lane's board until the lander commits, then stops it.
 *
 * Returns the workspace head AFTER the landing: the publish approval must name a sha the
 * landing receipt's commit is an ANCESTOR of (`publicationGoalIntegrated` shells out to
 * `git merge-base --is-ancestor`), and the landing commit IS that head.
 */
export async function landLaneNode(lane: DaemonLane): Promise<LaneLanded | LaneLandingRefused> {
  const scratch = resolveLaneScratch(lane);
  if (scratch === null) {
    return { detail: "the lane's scratch directory could not be resolved", ok: false, wrapperPid: null };
  }
  retireSpecNode(scratch);
  const seat = landingSeatDouble(scratch.root, scratch.workspace);
  const tracked: ChildProcess[] = [];
  const watched = startWrapper(lane.repoRoot, {
    ...wrapperEnv(scratch, seat.command, WRAPPER_INTERVAL_MS, true),
    MOE_WRAPPER_MAX_AGENTS: String(LANDING_MAX_AGENTS),
    MOE_WRAPPER_MAX_ITEM_ATTEMPTS: String(LANDING_STAFFING_ATTEMPTS),
    // WITHOUT THIS THE COMPILED NODE HAS NO MISSION AND CANNOT BE DELIVERED.
    // `agent-wrapper-main.ts:117` reads MOE_NODE_WORKSPACE and builds NO compiled node source
    // when it is empty, and `wrapper-node-missions.ts:20` refuses on principle to let a spec
    // file supply a mission for a `node:v1:` ref. `wrapperEnv` does not carry it (the lane's
    // other wrapper journeys keep git out of their scratch), so the landing lane adds it here
    // - the same variable the daemon is already given, naming the same repository.
    MOE_NODE_WORKSPACE: scratch.workspace,
    // THE DEFAULT IS "pnpm test" (`agent-wrapper-main.ts:121`), which on this repository is the
    // whole root suite - minutes of wall clock inside a lane budget measured in seconds. This is
    // the SAME command the seeded spec node carried, so the verifier's work is unchanged in
    // kind; only the node it is attached to moved from the spec to the compiled graph.
    MOE_NODE_TEST_COMMAND: LANE_NODE_TEST_COMMAND,
  }, tracked);
  const wrapperPid = watched.child.pid ?? null;
  const refuse = (detail: string): LaneLandingRefused =>
    ({ detail: `${detail}
${watched.transcript().slice(-1400)}`, ok: false, wrapperPid });
  try {
    // THE SEAT'S FILE IS THE SIGNAL, not a fixed sleep: it is the same byte the round's
    // SUBMITTED_BYTES digest is taken over, so a round recorded before it existed would be
    // digesting a file that is not there.
    const landedFile = join(scratch.workspace, LANDED_PATH);
    const seatDeadline = Date.now() + SEAT_WRITE_BUDGET_MS;
    while (!existsSync(landedFile) && Date.now() < seatDeadline) await delay(250);
    if (!existsSync(landedFile)) return refuse("SEAT_NEVER_WROTE");
    const nodeRef = laneCompiledNodeRef(scratch);
    if (nodeRef === null) {
      return refuse(`NO_COMPILED_EXECUTION_NODE ${laneCompiledNodeDiagnosis(scratch)}`);
    }
    const refused = await submitLaneRound(lane, scratch, nodeRef);
    if (refused !== null) return refuse(refused);
    const committed = await watched.waitFor(COMMITTED_LINE, LANDING_BUDGET_MS);
    if (committed === null) return refuse("LANDING_BUDGET_SPENT");
    // READ BACK FROM GIT, never taken from the log line: the receipt's authority is the commit
    // the repository actually holds, and a transcript is only how the lane learned to look.
    const identity = laneWorkspaceIdentity(scratch.root);
    return identity === null
      ? refuse(`landed but the workspace head is unreadable: ${committed}`)
      : { ok: true, sha: identity.sha, wrapperPid };
  } finally {
    // EVERY EXIT PATH, including the timeout and the throw. The wrapper outliving this call
    // would staff against a store the lane deletes moments later.
    for (const child of [...tracked].reverse()) await killTree(child);
  }
}
