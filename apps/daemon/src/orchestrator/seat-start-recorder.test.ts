/**
 * THE VERSION PROBE AND THE SEAT-START RECORDER.
 *
 * The probe runs a REAL child process here, because every interesting failure of a probe is a
 * process failure: a binary that is not there, a child that never exits, output nobody can read.
 * A stubbed `execFile` would prove the code around the probe and nothing about the probe.
 *
 * THE TIMEOUT IS PROVED, NOT ASSERTED. A version probe that hangs hangs the first spawn of a
 * wrapper's life, so an arm here starts a genuinely non-terminating child and requires the probe
 * to answer anyway. `expect(TIMEOUT_MS).toBe(10_000)` would pass against a probe with no timeout
 * wired at all.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { SEAT_FACT_UNMEASURED } from "./seat-start-contracts.js";
import { readSeatStartLedger } from "./seat-start-ledger.js";
import {
  AGENT_VERSION_PROBE_TIMEOUT_MS, createAgentVersionMemo, createSeatStartRecorder,
  probeAgentVersion,
} from "./seat-start-recorder.js";

const PROJECT = "project-1";
const AT = "2026-09-03T09:30:00.000Z";
const sandboxes: string[] = [];
const opened: SqliteEventStore[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "moe-seat-start-recorder-"));
  sandboxes.push(directory);
  return join(directory, "store.db");
}
function storeAt(path: string): SqliteEventStore {
  const store = SqliteEventStore.openForProject(path, PROJECT);
  opened.push(store);
  return store;
}
/** A real, non-terminating executable this host will actually run. */
function hangingCommand(): string {
  const directory = mkdtempSync(join(tmpdir(), "moe-hang-"));
  sandboxes.push(directory);
  if (process.platform === "win32") {
    const script = join(directory, "hang.cmd");
    // `ping -n 600 localhost` blocks for ten minutes without printing a version.
    writeFileSync(script, "@echo off\r\nping -n 600 127.0.0.1 > nul\r\n", "utf8");
    return script;
  }
  const script = join(directory, "hang.sh");
  writeFileSync(script, "#!/bin/sh\nsleep 600\n", "utf8");
  chmodSync(script, 0o755);
  return script;
}
afterEach(() => {
  while (opened.length > 0) opened.pop()?.close();
  while (sandboxes.length > 0) {
    const directory = sandboxes.pop();
    if (directory !== undefined) rmSync(directory, { force: true, recursive: true });
  }
});

describe("probeAgentVersion answers, or answers nothing, but never throws or hangs", () => {
  it("reads a real version from a command that answers one", async () => {
    // `node --version` prints exactly one shaped line, so it stands in for a provider CLI
    // without pinning this arm to whether claude or codex is installed on the runner.
    const stdout = await probeAgentVersion(process.execPath);
    expect(stdout).not.toBeNull();
    expect(stdout ?? "").toMatch(/^v?\d+\.\d+\.\d+/u);
  });

  it("answers null for a binary that is not there, rather than throwing", async () => {
    await expect(probeAgentVersion("moe-definitely-not-a-real-cli-ca28be90")).resolves.toBeNull();
  });

  it("answers null WITHIN THE BOUND for a child that never exits", async () => {
    // The bound is what stops a wrapper hanging on its first spawn. A 600s child answered in
    // under a second is only possible if the timeout is really wired to the spawn.
    const started = Date.now();
    await expect(probeAgentVersion(hangingCommand(), 400)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(20_000);
    // And production's own bound is finite and short enough to matter.
    expect(AGENT_VERSION_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(AGENT_VERSION_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it("answers null for a command the SPAWN layer refuses to quote", async () => {
    // `agentSpawnInvocation` throws SPAWN_ARGUMENT_UNQUOTABLE rather than let cmd.exe
    // reinterpret a command. The probe must degrade, not propagate: a hostile PATH entry
    // cannot be allowed to take down the wrapper's spawn path.
    await expect(probeAgentVersion('claude" & whoami')).resolves.toBeNull();
  });
});

describe("createAgentVersionMemo probes once per COMMAND, never once per seat", () => {
  it("shares one reading across many seats and keeps providers apart", async () => {
    const calls: string[] = [];
    const memo = createAgentVersionMemo(async (command) => {
      calls.push(command);
      return command === "codex" ? "codex-cli 0.153.4\n" : "2.1.263 (Claude Code)\n";
    });
    // Ten seats, started at once, on two providers.
    const answers = await Promise.all([
      ...Array.from({ length: 5 }, () => memo("claude")),
      ...Array.from({ length: 5 }, () => memo("codex")),
    ]);
    expect(answers.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => "2.1.263 (Claude Code)"));
    expect(answers.slice(5)).toEqual(Array.from({ length: 5 }, () => "codex-cli 0.153.4"));
    // TWO child processes for ten seats: one per distinct command, and never one per spawn.
    expect(calls).toEqual(["claude", "codex"]);
  });

  it("memoises a FAILED reading too, and states the unknown for it", async () => {
    // Retrying a missing binary on every spawn is the hot-path cost the memo exists to avoid,
    // and the answer would not change.
    let calls = 0;
    const memo = createAgentVersionMemo(async () => { calls += 1; return null; });
    expect(await memo("gone")).toBe(SEAT_FACT_UNMEASURED);
    expect(await memo("gone")).toBe(SEAT_FACT_UNMEASURED);
    expect(calls).toBe(1);
  });

  it("states the unknown when the probe REJECTS instead of answering null", async () => {
    const memo = createAgentVersionMemo(async () => { throw new Error("spawn exploded"); });
    expect(await memo("claude")).toBe(SEAT_FACT_UNMEASURED);
  });
});

describe("createSeatStartRecorder writes what the seat was started with", () => {
  const recorder = (store: SqliteEventStore, probe: (command: string) => Promise<string | null>,
    log: (line: string) => void = () => undefined) =>
    createSeatStartRecorder({ clock: () => AT, log, probe, projectId: PROJECT, store });

  it("records the provider NAME and the shaped version for a spawned seat", async () => {
    const store = storeAt(databasePath());
    await recorder(store, async () => "2.1.263 (Claude Code)\n")
      .record({ provider: "claude", sessionId: "sess-a" });
    expect(readSeatStartLedger(store, PROJECT).get("sess-a"))
      .toEqual({ agentVersion: "2.1.263 (Claude Code)", provider: "claude", startedAt: AT });
  });

  it("names a KNOWN provider by its roster leaf when the command is a path", async () => {
    // The same rule `/sessions/read` uses for its project-scoped disclosure, so the per-seat
    // member and the frame member can never disagree about what to call one command.
    const store = storeAt(databasePath());
    await recorder(store, async () => "codex-cli 0.153.4\n")
      .record({ provider: "C:\\tools\\codex.exe", sessionId: "sess-path" });
    expect(readSeatStartLedger(store, PROJECT).get("sess-path")?.provider).toBe("codex");
  });

  it("keeps an OFF-ROSTER command VERBATIM rather than inventing a provider identity", async () => {
    const store = storeAt(databasePath());
    await recorder(store, async () => "gemini 1.2.3\n")
      .record({ provider: "gemini", sessionId: "sess-gemini" });
    expect(readSeatStartLedger(store, PROJECT).get("sess-gemini")?.provider).toBe("gemini");
  });

  it("writes the STATED UNKNOWN version when the probe answers nothing", async () => {
    // DoD-4: never an empty string, never a plausible default, never the daemon's own version.
    const store = storeAt(databasePath());
    await recorder(store, async () => null).record({ provider: "claude", sessionId: "sess-mute" });
    const facts = readSeatStartLedger(store, PROJECT).get("sess-mute");
    expect(facts?.agentVersion).toBe("UNKNOWN");
    expect(facts?.agentVersion).toBe(SEAT_FACT_UNMEASURED);
    // The provider is still known: the two members degrade independently.
    expect(facts?.provider).toBe("claude");
  });

  it("writes NOTHING at all — not a half-record — when the seat names no command", async () => {
    // A seat spawned through the spawner's own chain has nothing to attribute a version to.
    // No row means the read publishes the SAME unknown it publishes for a pre-ledger session.
    const store = storeAt(databasePath());
    const seats = recorder(store, async () => "1.2.3\n");
    await seats.record({ sessionId: "sess-none" });
    await seats.record({ provider: "   ", sessionId: "sess-blank" });
    await seats.record({ provider: "", sessionId: "sess-empty" });
    // An OFF-ROSTER command too long to publish verbatim is not TRUNCATED into a name either:
    // no row beats a path clipped into something that reads like a provider nobody configured.
    await seats.record({ provider: `/opt/${"deep/".repeat(40)}gemini`, sessionId: "sess-long" });
    expect(readSeatStartLedger(store, PROJECT).size).toBe(0);
    // A KNOWN provider at a deep path is a DIFFERENT case and IS recorded: `providerFor` reads
    // its roster leaf, so the length of the path never reaches the record.
    await seats.record({ provider: `C:\\${"deep\\".repeat(40)}claude.exe`, sessionId: "sess-deep" });
    expect(readSeatStartLedger(store, PROJECT).get("sess-deep")?.provider).toBe("claude");
  });

  it("never throws and never blocks a spawn when the LEDGER refuses", async () => {
    const store = storeAt(databasePath());
    store.close();
    opened.splice(opened.indexOf(store), 1);
    const lines: string[] = [];
    // A closed store makes every write throw. The recorder must swallow it and say so.
    await expect(recorder(store, async () => "1.2.3\n", (line) => { lines.push(line); })
      .record({ provider: "claude", sessionId: "sess-doomed" })).resolves.toBeUndefined();
    expect(lines.join("\n")).toContain("[wrapper] seat start not recorded:");
  });

  it("is REPLAY-SAFE across two wrapper processes recording the same seat", async () => {
    const path = databasePath();
    const first = storeAt(path);
    const second = storeAt(path);
    await recorder(first, async () => "1.2.3\n").record({ provider: "claude", sessionId: "sess-race" });
    await recorder(second, async () => "9.9.9\n").record({ provider: "claude", sessionId: "sess-race" });
    // One seat, one note, and it is the FIRST writer's — a later writer never overwrites a
    // reading with a different one for the same instant.
    const ledger = readSeatStartLedger(first, PROJECT);
    expect(ledger.size).toBe(1);
    expect(ledger.get("sess-race")?.agentVersion).toBe("1.2.3");
  });
});
