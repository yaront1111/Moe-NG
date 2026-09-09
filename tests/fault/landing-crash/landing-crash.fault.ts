/**
 * DoD 2 - THE DAEMON IS KILLED DURING A LANDING WRITE, AND RECOVERY IS PROVED FROM THE
 * STORE ALONE.
 *
 * The claim is exactly-once: after a crash inside the landing write, the durable ledger
 * carries ONE outcome for that landing - committed once, or refused with a code - never a
 * duplicate and never a loss. A duplicate landing looks fine afterwards, and so does a lost
 * one if you only ask whether the daemon came back up, so nothing here observes that the
 * world "looks fine". It COUNTS ROWS in command_decisions with SQL, and it reads the Git
 * branch with git.
 *
 * WHAT MAKES THIS A REAL CRASH. The child is a real process that runs the production
 * landing pass; the DEVELOPMENT-ONLY knob inside it SIGKILLs that process between the Git
 * commit and the journal completion that records it. Nothing here throws a fake error and
 * calls it a crash: the pass never returns, its terminal line never reaches stdout, and the
 * only thing it leaves behind is the note the knob wrote to fd 2 before the signal.
 *
 * WHAT THE RESTART IS. A SECOND process, same store file, same repository, same handle, no
 * arming. It consults production landingJournalGate exactly where node-lander.ts:176 does.
 * The restarted daemon is not told what happened; it works it out from the store.
 *
 * PLATFORM NOTE, stated rather than hidden: Windows has no signals, so a SIGKILLed process
 * is observed here as a nonzero status with a null signal. The discriminator this file
 * relies on is therefore the ABSENCE of the terminal line plus the PRESENCE of the knob's
 * note, which reads identically on every platform.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DELIVERED_PATH,
  cleanupLandingCrashRoots,
  createLandingCrashWorld,
  decisionsOfKind,
  readGit,
  readLandingLedger,
  runLandingPassProcess,
} from "./landing-crash-world.js";
import type { GitReading, LandingCrashWorld, LandingPassRun, LedgerReading } from "./landing-crash-world.js";

/** The knob's own name and note shape. Quoted here because DoD 2 asks for both. */
const KNOB = "MOE_FAULT_INJECT_LANDING";
const ARMED = Object.freeze({ MOE_DEVELOPMENT_ONLY: "1", [KNOB]: "after-commit" });
const NOTE = /^MOE_FAULT_INJECT_LANDING point=after-commit pid=(\d+) at=(\d{4}-\d{2}-\d{2}T[\d:.]+Z)$/mu;

afterAll(cleanupLandingCrashRoots);

describe("a landing that is not interrupted", () => {
  let fixture: LandingCrashWorld;
  let pass: LandingPassRun;
  let ledger: LedgerReading;

  beforeAll(() => {
    fixture = createLandingCrashWorld("control");
    pass = runLandingPassProcess(fixture.world);
    ledger = readLandingLedger(fixture.world.storePath, fixture.ownerDigest);
  });

  it("commits once and journals its completion", () => {
    expect(pass.result).toMatchObject({ branch: "trunk", outcome: "COMMITTED" });
    expect(pass.status).toBe(0);
    expect(decisionsOfKind(ledger, "landing_intent")).toBe(1);
    expect(decisionsOfKind(ledger, "landing_completion")).toBe(1);
  });

  it("leaves the delivered file on the branch, in exactly one landing commit", () => {
    const git = readGit(fixture.root);
    expect(git.subjects).toEqual(["land", "base"]);
    expect(git.filesAtHead).toEqual([DELIVERED_PATH]);
  });

  it("refuses a second pass on the same landing rather than committing twice", () => {
    const again = runLandingPassProcess(fixture.world);
    expect(again.result).toEqual({ code: "REPOSITORY_RECOVERY_REQUIRED", gate: "REPOSITORY_RECOVERY_REQUIRED", outcome: "REFUSED" });
    expect(readGit(fixture.root).subjects).toEqual(["land", "base"]);
    const after = readLandingLedger(fixture.world.storePath, fixture.ownerDigest);
    expect(decisionsOfKind(after, "landing_intent")).toBe(1);
    expect(decisionsOfKind(after, "landing_completion")).toBe(1);
  });
});

describe("the knob refuses to arm outside development mode", () => {
  it("runs the landing to completion and writes no note", () => {
    const fixture = createLandingCrashWorld("fenced");
    // The point IS named. Only the development flag is missing, which is the whole fence.
    const pass = runLandingPassProcess(fixture.world, { [KNOB]: "after-commit" });
    expect(pass.result).toMatchObject({ outcome: "COMMITTED" });
    expect(pass.stderr).not.toContain(KNOB);
    expect(readGit(fixture.root).subjects).toEqual(["land", "base"]);
  });
});

describe("a daemon killed between the git commit and the journal that records it", () => {
  let fixture: LandingCrashWorld;
  let crash: LandingPassRun;
  let restart: LandingPassRun;
  let afterCrashLedger: LedgerReading;
  let afterRestartLedger: LedgerReading;
  let afterCrashGit: GitReading;
  let afterRestartGit: GitReading;

  beforeAll(() => {
    fixture = createLandingCrashWorld("crash");
    crash = runLandingPassProcess(fixture.world, ARMED);
    afterCrashLedger = readLandingLedger(fixture.world.storePath, fixture.ownerDigest);
    afterCrashGit = readGit(fixture.root);
    // THE RESTART. Same store, same repository, same handle, nothing armed, no hand-holding.
    restart = runLandingPassProcess(fixture.world);
    afterRestartLedger = readLandingLedger(fixture.world.storePath, fixture.ownerDigest);
    afterRestartGit = readGit(fixture.root);
  });

  afterAll(() => {
    const note = NOTE.exec(crash.stderr);
    process.stdout.write([
      "",
      "=== DoD 2 TRANSCRIPT: forced crash mid-write ===",
      "knob            " + KNOB + "=after-commit (with MOE_DEVELOPMENT_ONLY=1)",
      "crash note      " + (note === null ? "<absent>" : note[0]),
      "crash exit      status=" + String(crash.status) + " signal=" + String(crash.signal)
        + " platform=" + process.platform + " terminalLine=" + String(crash.result !== null),
      "store           " + fixture.world.storePath,
      "SQL             " + afterCrashLedger.sql.replaceAll("\n", "\n                "),
      "parameters      " + JSON.stringify(afterCrashLedger.parameters),
      "rows AFTER CRASH   " + JSON.stringify(afterCrashLedger.rows),
      "rows AFTER RESTART " + JSON.stringify(afterRestartLedger.rows),
      "restart answer  " + JSON.stringify(restart.result),
      "git after crash    HEAD=" + afterCrashGit.headSha + " log=" + JSON.stringify(afterCrashGit.subjects),
      "git after restart  HEAD=" + afterRestartGit.headSha + " log=" + JSON.stringify(afterRestartGit.subjects),
      "=== end ===",
      "",
    ].join("\n"));
  });

  it("dies inside the write: no terminal line, and the knob's note names the point and the time", () => {
    // A process that returned would have printed its result. This one never got the chance.
    expect(crash.result).toBeNull();
    expect(crash.status).not.toBe(0);
    const note = NOTE.exec(crash.stderr);
    expect(note).not.toBeNull();
    expect(Number(note?.[1])).toBeGreaterThan(0);
    expect(Number.isFinite(Date.parse(note?.[2] ?? ""))).toBe(true);
  });

  it("leaves a durable git effect that no durable record names - the window itself", () => {
    // This is what makes the crash interesting rather than merely early: the commit is real.
    expect(afterCrashGit.subjects).toEqual(["land", "base"]);
    expect(afterCrashGit.filesAtHead).toEqual([DELIVERED_PATH]);
    expect(decisionsOfKind(afterCrashLedger, "landing_intent")).toBe(1);
    expect(decisionsOfKind(afterCrashLedger, "landing_completion")).toBe(0);
    expect(decisionsOfKind(afterCrashLedger, "landing_attempt")).toBe(1);
  });

  it("the restarted daemon refuses with a code, read from the store and nothing else", () => {
    expect(restart.result).toEqual({
      code: "REPOSITORY_RECOVERY_REQUIRED", gate: "REPOSITORY_RECOVERY_REQUIRED", outcome: "REFUSED",
    });
    expect(restart.status).toBe(0);
  });

  it("EXACTLY ONE OUTCOME: the restart adds no row and mints no second commit", () => {
    // Counted, not observed. A duplicated landing would leave the goal looking perfectly fine.
    expect(afterRestartLedger.rows).toEqual(afterCrashLedger.rows);
    expect(decisionsOfKind(afterRestartLedger, "landing_intent")).toBe(1);
    expect(decisionsOfKind(afterRestartLedger, "landing_completion")).toBe(0);
    expect(decisionsOfKind(afterRestartLedger, "landing_attempt")).toBe(1);
    // Never lost: the commit the crash left behind is still the branch tip, unchanged.
    expect(afterRestartGit.headSha).toBe(afterCrashGit.headSha);
    // Never duplicated: still one landing commit on top of the base.
    expect(afterRestartGit.subjects).toEqual(["land", "base"]);
  });

  it("every decision the landing wrote is a committed effect, on the landing's own aggregates", () => {
    expect(afterRestartLedger.rows.length).toBeGreaterThan(0);
    for (const row of afterRestartLedger.rows) {
      expect(row.disposition).toBe("EFFECTS_COMMITTED");
      expect(row.aggregate.startsWith("repository-landing")).toBe(true);
    }
  });
});
