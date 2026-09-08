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

/**
 * The lander's own words for a landing that produced a commit BY THIS NODE.
 *
 * `repository-delivery-runtime.ts:91` logs `[lander] <nodeRef>: <outcome> (<detail>)` for every
 * node it reports on, and the lane's board carries more than one item. The old pattern was
 * `(\S+)` - it CAPTURED the ref and the caller discarded it, so any node's COMMITTED line, or a
 * `policy.validate` line that happened to read COMMITTED, released the wait and the lane then
 * returned a head some other delivery had produced. Baking the target ref into the pattern means
 * a foreign line cannot match at all and the wait continues; the capture is the ref itself, so
 * `watch()`'s "a match without a capture is a pattern bug" contract still holds and what comes
 * back is provably the node that was asked for.
 */
export function committedLine(nodeRef: string): RegExp {
  // The closing bracket is ESCAPED. Under the `u` flag a lone `]` is a SyntaxError ("Lone
  // quantifier brackets"), thrown at IMPORT, so an unescaped one takes every spec that imports
  // this module down with it and `test:e2e:browser` finds no tests at all.
  return new RegExp(`^\\[lander\\] (${escapeForPattern(nodeRef)}): COMMITTED `, "mu");
}

/** Every regex metacharacter neutered, so a ref is matched as the literal text it is. */
function escapeForPattern(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

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
 * The exact bytes the seat writes for its target node. DETERMINISTIC BY CONTRACT.
 *
 * `lane-review-round.ts` digests this file as the round's SUBMITTED_BYTES, and the wrapper may
 * staff the item again after that digest was taken. The old body carried
 * `new Date().toISOString()`, so a restaff rewrote the file with DIFFERENT bytes and left the
 * committed landing modified in the workspace - measured 2026-09-08 on 17 fresh lanes as
 * `M landed-by-the-seat.txt` in 17 of 17, with the committed blob (425c2ec) and the worktree
 * blob (e648c1e) 2.9 s apart. A fixed body is still DIFFERENT from the staffing baseline, where
 * the file is absent, so the lander still has something to commit.
 *
 * The ref is IN the bytes, so two nodes sharing one workspace cannot leave each other's landing.
 */
export function landedSeatBytes(nodeRef: string): string {
  return `landed by the seat for ${nodeRef}\n`;
}

/**
 * The clause a staffed mission must carry before this seat will write, taken from PRODUCTION.
 *
 * `agent-mission-text.ts:112` opens EVERY `codeMission` with exactly this sentence, and
 * `mission()` (:294) opens with a different one that names a work item and a command kind and
 * carries no node ref at all. So this clause means "the staffed mission is the durable claim on
 * THIS code node" - not "the text mentions this ref somewhere". The distinction is the whole
 * fix: a hint, a diagnostic or another node's brief may quote a ref without holding its claim,
 * and a bare-substring match would write the landing file for all three.
 */
export function landingSeatClaim(nodeRef: string): string {
  return `You are a moe-next coding agent. You hold the durable claim on code node "${nodeRef}"`;
}

/**
 * Writes the landing seat double into `dir` and says which form this platform can run.
 *
 * IT READS ITS MISSION. `agent-spawner.ts:400` writes `request.mission` to the seat's stdin and
 * ends it, and the wrapper staffs EVERY ready item through the same command - the lane's board
 * also carries `policy.validate`. A seat that ignored stdin therefore wrote the CODE node's
 * landing file on behalf of a mission that never delivered the node, satisfying `landLaneNode`'s
 * `existsSync` signal for the wrong seat. So the child reads stdin to completion and writes ONLY
 * when the mission carries `landingSeatClaim(nodeRef)`. Anything else - a policy mission, another
 * node's mission, a mission that merely quotes the ref, empty stdin, a closed pipe - writes
 * nothing and exits 0, which the lane then reports as SEAT_NEVER_WROTE rather than as a landing.
 *
 * A FAILED WRITE IS A FAILED SEAT: the write is guarded and a real IO error is printed as
 * SEAT_WRITE_FAILED with a nonzero exit, never swallowed into a 0 that claims a landing the
 * workspace does not hold.
 *
 * THREE FILES FOR THE SAME REASON `wrapper-lane.ts` WRITES THREE: `agent-spawn-invocation.ts`
 * runs a win32 seat THROUGH cmd.exe as a command LINE, so the command has to be a `.cmd`; on
 * posix the spawner passes argv directly, so a `.sh` is the executable form. Both delegate to
 * one `.js` so the platforms cannot drift, and cmd.exe passes its own stdin straight through.
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
export function landingSeatDouble(
  dir: string, workspace: string, nodeRef: string,
): { command: string } {
  const jsPath = join(dir, "landing-seat.js");
  const cmdPath = join(dir, "landing-seat.cmd");
  const shPath = join(dir, "landing-seat.sh");
  const target = JSON.stringify(join(workspace, LANDED_PATH));
  const claim = JSON.stringify(landingSeatClaim(nodeRef));
  const bytes = JSON.stringify(landedSeatBytes(nodeRef));
  writeFileSync(jsPath, [
    "const chunks = [];",
    // A seat that cannot read its mission has no claim to act on, so it writes nothing.
    'process.stdin.on("error", function () { process.exit(0); });',
    'process.stdin.on("data", function (chunk) { chunks.push(chunk); });',
    'process.stdin.on("end", function () {',
    `  if (Buffer.concat(chunks).toString("utf8").indexOf(${claim}) === -1) process.exit(0);`,
    `  try { require("node:fs").writeFileSync(${target}, ${bytes}); }`,
    "  catch (error) {",
    '    process.stderr.write("SEAT_WRITE_FAILED " + String(error) + "\\n");',
    "    process.exit(1);",
    "  }",
    "  process.exit(0);",
    "});",
    "",
  ].join("\n"), "utf8");
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
  // RESOLVED BEFORE ANYTHING IS SPAWNED. It needs no wrapper - `retireSpecNode` has run, so the
  // compiled source already answers - and the seat double cannot build its discriminator without
  // it. Resolving it AFTER the wait (as this did) meant the file that released the wait could
  // have been written by any seat at all, which is defect 1.
  const nodeRef = laneCompiledNodeRef(scratch);
  if (nodeRef === null) {
    return { detail: `NO_COMPILED_EXECUTION_NODE ${laneCompiledNodeDiagnosis(scratch)}`,
      ok: false, wrapperPid: null };
  }
  const seat = landingSeatDouble(scratch.root, scratch.workspace, nodeRef);
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
  // IDEMPOTENT, because it is called twice on the happy path and once on every other. The
  // `finally` teardown has to stay - it is what covers the refusing and the THROWING paths
  // (epic rail 4) - so the early stop cannot be a move, only an addition that the second call
  // then no-ops rather than re-killing an already-dead child.
  let stopped = false;
  const stopTracked = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const child of [...tracked].reverse()) await killTree(child);
  };
  try {
    // THE SEAT'S FILE IS THE SIGNAL, not a fixed sleep: it is the same byte the round's
    // SUBMITTED_BYTES digest is taken over, so a round recorded before it existed would be
    // digesting a file that is not there.
    const landedFile = join(scratch.workspace, LANDED_PATH);
    const seatDeadline = Date.now() + SEAT_WRITE_BUDGET_MS;
    while (!existsSync(landedFile) && Date.now() < seatDeadline) await delay(250);
    if (!existsSync(landedFile)) return refuse("SEAT_NEVER_WROTE");
    const refused = await submitLaneRound(lane, scratch, nodeRef);
    if (refused !== null) return refuse(refused);
    // THE TARGET'S landing, not the first one anyone announces. A foreign COMMITTED line no
    // longer matches, so the wait runs on and a genuine miss still surfaces as
    // LANDING_BUDGET_SPENT with the transcript, which is the diagnosable failure - never a
    // silent pass on another node's commit.
    const committed = await watched.waitFor(committedLine(nodeRef), LANDING_BUDGET_MS);
    if (committed === null) return refuse("LANDING_BUDGET_SPENT");
    // THE WRAPPER IS STOPPED BEFORE GIT IS OBSERVED. `laneWorkspaceIdentity` used to run while
    // the wrapper was still taking passes, so a pass that was mid-baseline or mid-verify during
    // the read is what a caller saw as BASELINE_WORKSPACE_DIRTY and as a workspace that would
    // not come back clean. Nothing owned by this lane is still writing after this line.
    await stopTracked();
    // READ BACK FROM GIT, never taken from the log line: the receipt's authority is the commit
    // the repository actually holds, and a transcript is only how the lane learned to look.
    const identity = laneWorkspaceIdentity(scratch.root);
    return identity === null
      ? refuse(`landed but the workspace head is unreadable: ${committed}`)
      : { ok: true, sha: identity.sha, wrapperPid };
  } finally {
    // EVERY EXIT PATH, including the timeout and the throw. The wrapper outliving this call
    // would staff against a store the lane deletes moments later.
    await stopTracked();
  }
}
