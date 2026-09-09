/**
 * THE LANDING SEAT DOUBLE AS A PROCESS, at the seam where the reported bug lives.
 *
 * WHY THESE ARMS EXIST. `landLaneNode`'s only signal that the code node was delivered is the
 * one file its seat double writes. Measured at HEAD 7fe37943 the double read NO stdin and ran
 * identically for EVERY staffed mission, so a `policy.validate` seat wrote the CODE node's
 * landing file; and it wrote `new Date().toISOString()`, so a restaff rewrote those bytes after
 * `lane-review-round.ts` had digested them as SUBMITTED_BYTES. Both faces were measured on 17
 * fresh lanes: 17/17 landed, 0/17 ended with a clean workspace.
 *
 * A real lane costs ~9 s and a browser worker; these arms cost seconds and no daemon, because
 * they spawn the generated child directly and feed it the mission the production spawner feeds
 * it (`agent-spawner.ts:400` writes `request.mission` to stdin, then ends it).
 *
 * THE MISSION TEXT IS THE PRODUCTION TEXT, imported rather than approximated: an arm written
 * against a hand-typed copy would keep passing after `codeMission` changed its opening clause,
 * which is precisely the string the discriminator matches on.
 *
 * `.test.ts`, not `.spec.ts`: `playwright.config.ts` matches `*.spec.ts` only and the root
 * `vitest.config.ts` include already carries `tests/**\/*.test.ts`, so these run in the node
 * lane with no config change on either side.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agentSpawnInvocation }
  from "../../../apps/daemon/src/orchestrator/agent-spawn-invocation.js";
import { codeMission, mission }
  from "../../../apps/daemon/src/orchestrator/agent-mission-text.js";
import { LANDED_PATH, committedLine, landedSeatBytes, landingSeatDouble } from "./lane-landing.js";

const TARGET = "node:v1:target-node-ref";
const OTHER = "node:v1:some-other-node-ref";
const WORK_ITEM = "work-item-landing-arms";
const EXPIRES = "2026-09-08T23:59:59.000Z";
const PROJECT = "proj-landing-arms";
/** A file the seat has no business touching, in the same directory it writes into. */
const FOREIGN = "foreign.txt";
const FOREIGN_BYTES = "written by a peer row, never by the seat\n";

let dir = "";
let workspace = "";

/** The production mission for a code node, exactly as the wrapper would build it. */
function codeMissionFor(nodeRef: string): string {
  return codeMission(WORK_ITEM, nodeRef, EXPIRES, {
    instructions: "Deliver the node.", test: "node --eval \"process.exit(0)\"",
    title: "Landing arms node", workspace,
  }, { accept: null, submit: null }, PROJECT, null);
}

/** The production mission for a non-code work item; `policy.validate` is what the lane staffs. */
function policyMission(kind = "policy.validate"): string {
  return mission(WORK_ITEM, kind, EXPIRES, null, PROJECT);
}

/**
 * Spawns the seat THROUGH the production invocation seam, so the win32 `.cmd` bridge is
 * exercised as `agent-spawn-invocation.ts` exercises it (a command LINE under `shell: true`)
 * rather than as a path this test happens to know how to run.
 */
function runSeat(input: string, nodeRef = TARGET): { status: number | null; stderr: string } {
  const seat = landingSeatDouble(dir, workspace, nodeRef);
  const invocation = agentSpawnInvocation(seat.command, []);
  const run = spawnSync(invocation.file, [...invocation.args], {
    encoding: "utf8", input, shell: invocation.shell,
  });
  return { status: run.status, stderr: run.stderr };
}

/** The landing file's bytes, or null when it does not exist. Never created by reading. */
function landed(): string | null {
  try {
    return readFileSync(join(workspace, LANDED_PATH), "utf8");
  } catch { return null; }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "moe-landing-seat-"));
  workspace = mkdtempSync(join(tmpdir(), "moe-landing-ws-"));
  writeFileSync(join(workspace, FOREIGN), FOREIGN_BYTES, "utf8");
});

afterEach(() => {
  for (const path of [dir, workspace]) {
    try {
      rmSync(path, { force: true, recursive: true });
    } catch {
      // A few kilobytes left in TEMP is never a reason to red a green run.
    }
  }
});

describe("the target code node's mission", () => {
  it("writes exactly the seat's bytes and exits 0", () => {
    const run = runSeat(codeMissionFor(TARGET));
    expect(run.status, run.stderr).toBe(0);
    expect(landed()).toBe(landedSeatBytes(TARGET));
    expect(readFileSync(join(workspace, FOREIGN), "utf8")).toBe(FOREIGN_BYTES);
  });

  it("is BYTE-STABLE across a restaff, so a digest taken between the two still holds", () => {
    expect(runSeat(codeMissionFor(TARGET)).status).toBe(0);
    const first = landed();
    expect(runSeat(codeMissionFor(TARGET)).status).toBe(0);
    // The reported failure in one assertion: at HEAD these differed by an ISO timestamp, so
    // `lane-review-round.ts`'s SUBMITTED_BYTES digest named bytes the workspace no longer held.
    expect(landed()).toBe(first);
    expect(landed()).toBe(landedSeatBytes(TARGET));
    expect(landed()?.length).toBe(landedSeatBytes(TARGET).length);
  });

  it("carries the target ref, so two nodes cannot share one file's bytes", () => {
    expect(landedSeatBytes(TARGET)).not.toBe(landedSeatBytes(OTHER));
    expect(landedSeatBytes(TARGET)).toContain(TARGET);
  });
});

describe("a mission that is not this node's claim", () => {
  it("writes NOTHING for policy.validate and still exits 0", () => {
    const run = runSeat(policyMission());
    expect(run.status, run.stderr).toBe(0);
    expect(landed(), "a policy seat must not satisfy a code node's landing signal").toBeNull();
    expect(readFileSync(join(workspace, FOREIGN), "utf8")).toBe(FOREIGN_BYTES);
  });

  it("leaves an ALREADY-WRITTEN landing byte-identical when policy staffs after the code seat", () => {
    expect(runSeat(codeMissionFor(TARGET)).status).toBe(0);
    const before = landed();
    expect(before).toBe(landedSeatBytes(TARGET));
    expect(runSeat(policyMission()).status).toBe(0);
    expect(landed()).toBe(before);
  });

  it("writes NOTHING for a DIFFERENT code node's mission", () => {
    const run = runSeat(codeMissionFor(OTHER));
    expect(run.status, run.stderr).toBe(0);
    expect(landed()).toBeNull();
  });

  it("writes NOTHING when the ref is merely MENTIONED without the claim clause", () => {
    // An over-broad match would reintroduce the bug in a shape the arms above cannot see: any
    // mission may quote a ref in a hint or a diagnostic without holding the claim on it.
    const run = runSeat(`Diagnostic: the blocked node is "${TARGET}" and its item is ${WORK_ITEM}.`);
    expect(run.status, run.stderr).toBe(0);
    expect(landed()).toBeNull();
  });

  it("writes NOTHING on empty stdin and on stdin closed with no write, exiting 0 for both", () => {
    expect(runSeat("").status).toBe(0);
    expect(landed()).toBeNull();
    const seat = landingSeatDouble(dir, workspace, TARGET);
    const invocation = agentSpawnInvocation(seat.command, []);
    const closed = spawnSync(invocation.file, [...invocation.args], {
      encoding: "utf8", shell: invocation.shell, stdio: ["pipe", "pipe", "pipe"],
    });
    expect(closed.status, closed.stderr).toBe(0);
    expect(landed()).toBeNull();
  });
});

describe("the seat under contention and under failure", () => {
  it("leaves exactly the target's bytes when the target and a policy seat run at once", async () => {
    const seat = landingSeatDouble(dir, workspace, TARGET);
    const invocation = agentSpawnInvocation(seat.command, []);
    // REAL concurrency: `spawnSync` would serialise the two and prove nothing about contention.
    const both = await Promise.all([codeMissionFor(TARGET), policyMission()].map(
      (input) => new Promise<number | null>((done) => {
        const child = spawn(invocation.file, [...invocation.args], { shell: invocation.shell });
        child.on("close", (code) => { done(code); });
        child.stdin.on("error", () => { /* the child may exit before the pipe drains */ });
        child.stdin.end(input);
      }),
    ));
    expect(both).toEqual([0, 0]);
    expect(landed()).toBe(landedSeatBytes(TARGET));
    expect(readFileSync(join(workspace, FOREIGN), "utf8")).toBe(FOREIGN_BYTES);
  });

  it("SURFACES a genuine IO failure instead of exiting 0 on a write it never made", () => {
    // The target path is occupied by a DIRECTORY, so `writeFileSync` cannot succeed. A seat that
    // swallowed this would report a landing the workspace does not hold.
    mkdirSync(join(workspace, LANDED_PATH));
    const run = runSeat(codeMissionFor(TARGET));
    expect(run.status, "a failed write is a FAILED seat").not.toBe(0);
    expect(run.stderr).toContain("SEAT_WRITE_FAILED");
    expect(landed()).toBeNull();
  });
});

describe("the lander line the lane waits on", () => {
  /** Exactly what `repository-delivery-runtime.ts:91` prints. */
  const landerLine = (ref: string, outcome: string): string =>
    `[lander] ${ref}: ${outcome} (detail text)`;

  it("matches the TARGET's COMMITTED line and captures its ref", () => {
    const found = committedLine(TARGET).exec(landerLine(TARGET, "COMMITTED"));
    // `watch()` settles on capture group 1 and treats a missing one as a pattern bug, so the
    // group has to be present as well as correct.
    expect(found?.[1]).toBe(TARGET);
  });

  it("does NOT match another node's COMMITTED line, so the lane keeps waiting", () => {
    const transcript = [landerLine(OTHER, "COMMITTED"), landerLine(TARGET, "BASELINE_RECORDED"),
      `[lander] ${WORK_ITEM}: COMMITTED (a work item is not a code node)`].join("\n");
    expect(committedLine(TARGET).exec(transcript)).toBeNull();
    // And it still finds the target once the target's own line arrives.
    expect(committedLine(TARGET).exec(`${transcript}\n${landerLine(TARGET, "COMMITTED")}`)?.[1])
      .toBe(TARGET);
  });

  it("does not credit the target's REFUSED line, and reads the ref as literal text", () => {
    expect(committedLine(TARGET).exec(landerLine(TARGET, "REFUSED"))).toBeNull();
    // A ref carrying regex metacharacters must match itself, never act as a pattern.
    const awkward = "node:v1:a.b+c(d)";
    expect(committedLine(awkward).exec(landerLine(awkward, "COMMITTED"))?.[1]).toBe(awkward);
    expect(committedLine(awkward).exec(landerLine("node:v1:aXbXcd", "COMMITTED"))).toBeNull();
  });
});

describe("the three-file bridge", () => {
  it("writes the .js, the .cmd and the .sh, and each delegates to the one .js", () => {
    const seat = landingSeatDouble(dir, workspace, TARGET);
    expect(readdirSync(dir).map((name) => basename(name)).sort())
      .toEqual(["landing-seat.cmd", "landing-seat.js", "landing-seat.sh"]);
    const cmd = readFileSync(join(dir, "landing-seat.cmd"), "utf8");
    const sh = readFileSync(join(dir, "landing-seat.sh"), "utf8");
    expect(cmd).toContain("%~dp0landing-seat.js");
    expect(cmd.startsWith("@echo off\r\n"), "cmd.exe reads CRLF").toBe(true);
    expect(sh.startsWith("#!/bin/sh\n")).toBe(true);
    expect(sh).toContain('"$(dirname "$0")/landing-seat.js"');
    expect(seat.command).toBe(join(dir,
      process.platform === "win32" ? "landing-seat.cmd" : "landing-seat.sh"));
  });

  it("carries the mission through THIS platform's executable form, cmd.exe included", () => {
    // The one link the fix could get right on posix and silently no-op on win32: the mission is
    // piped to a command LINE that cmd.exe hands to node. A seat that reads nothing writes
    // nothing, which surfaces as SEAT_NEVER_WROTE rather than as a loud error.
    const seat = landingSeatDouble(dir, workspace, TARGET);
    const invocation = agentSpawnInvocation(seat.command, []);
    expect(invocation.shell).toBe(process.platform === "win32");
    expect(invocation.file).toContain(process.platform === "win32"
      ? "landing-seat.cmd" : "landing-seat.sh");
    const run = spawnSync(invocation.file, [...invocation.args], {
      encoding: "utf8", input: codeMissionFor(TARGET), shell: invocation.shell,
    });
    expect(run.status, run.stderr).toBe(0);
    expect(landed(), "the mission must reach the .js through this platform's bridge")
      .toBe(landedSeatBytes(TARGET));
  });
});
