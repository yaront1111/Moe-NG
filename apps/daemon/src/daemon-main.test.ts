import { expect, it } from "vitest";

import { DAEMON_ENTRY_LAYER } from "./daemon-entry.js";
import { runDaemonMain } from "./daemon-main.js";

const FIXTURE_PROVIDER = "./src/daemon-entry-fixtures.ts";
/** Loads cleanly but exports no default provider — a different fault from a load failure. */
const NO_DEFAULT_EXPORT = "./src/http/http-contract.ts";

interface Run {
  readonly exitCode: number;
  readonly lines: readonly string[];
  readonly shutdown: (() => Promise<unknown>) | null;
}

/** Shuts down on every exit path, so no run can leave a bound port behind. */
async function main(args: readonly string[]): Promise<Run> {
  const lines: string[] = [];
  let shutdown: (() => Promise<unknown>) | null = null;
  const exitCode = await runDaemonMain(args, {
    log: (line) => lines.push(line),
    onStarted: (stop) => {
      shutdown = stop;
    },
  });
  return { exitCode, lines, shutdown };
}

function expectRefusal(run: Run, code: string): void {
  expect(run.exitCode).toBe(1);
  // The code AND the layer, never merely "it exited non-zero": three layers can
  // refuse a start here, and an operator fixes each one differently.
  expect(run.lines).toContain(`${code} ${DAEMON_ENTRY_LAYER}`);
  expect(run.shutdown).toBeNull();
}

it("refuses when argv names no dependency provider", async () => {
  expectRefusal(await main([]), "DAEMON_ENTRY_NO_DEPENDENCY_PROVIDER");
});

it("refuses a provider module that cannot be loaded, by its own code", async () => {
  expectRefusal(
    await main(["--dependencies=./src/no-such-provider-module.ts"]),
    "DAEMON_ENTRY_PROVIDER_LOAD_FAILED",
  );
});

it("refuses a module that loads but exports no provider, by a DISTINCT code", async () => {
  expectRefusal(await main([`--dependencies=${NO_DEFAULT_EXPORT}`]), "DAEMON_ENTRY_PROVIDER_INVALID");
});

it("starts on an ephemeral loopback port and reports the port actually bound", async () => {
  const run = await main([`--dependencies=${FIXTURE_PROVIDER}`, "--port=0"]);
  try {
    expect(run.exitCode).toBe(0);
    expect(run.lines.join("\n")).toMatch(/listening on http:\/\/127\.0\.0\.1:\d+/);
    // Never a UUID-shaped value: that would be the minted CSRF token in a log.
    expect(run.lines.join("\n")).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
  } finally {
    await run.shutdown?.();
  }
});

it("falls back to an ephemeral port rather than guessing a well-known one", async () => {
  const run = await main([`--dependencies=${FIXTURE_PROVIDER}`, "--port=not-a-number"]);
  try {
    expect(run.exitCode).toBe(0);
    const bound = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(run.lines.join("\n"));
    expect(bound).not.toBeNull();
    expect(Number(bound?.[1])).toBeGreaterThan(0);
  } finally {
    await run.shutdown?.();
  }
});

it("surfaces a non-loopback bind refusal with the LISTENER's own code, unflattened", async () => {
  const run = await main([`--dependencies=${FIXTURE_PROVIDER}`, "--host=0.0.0.0"]);
  expect(run.exitCode).toBe(1);
  expect(run.lines).toContain("LISTENER_NON_LOOPBACK_BIND CONTROL_ROOM_LISTENER");
  expect(run.shutdown).toBeNull();
});
