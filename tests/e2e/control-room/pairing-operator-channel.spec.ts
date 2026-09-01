import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { expect, test } from "@playwright/test";

import { runMoeUp } from "../../../apps/daemon/src/orchestrator/moe-up-main.js";
import { createProcessSpawn } from "../../../apps/daemon/src/orchestrator/moe-up-spawn.js";
import type {
  LaunchChildProcess, LaunchSpawn,
} from "../../../apps/daemon/src/orchestrator/moe-up-spawn.js";
import { killTree, spawnNode, survivingChildren } from "./daemon-children.js";
import { createLaneScratch, daemonEnv, repoRoot } from "./daemon-scratch.js";
import type { LaneScratch } from "./daemon-scratch.js";

/**
 * task-ea0106d7: a browser could request pairing that NOTHING could approve.
 *
 * Proven here from OUTSIDE, against real processes, because every half of the
 * chain can be green alone and still be a no-op in production: the launcher
 * carries one line filter (`suppressDaemonLine`) and the daemon carries another
 * (`CONFIRMATION_LABEL`), and a prompt that survives one is still invisible if
 * the other eats it. No production file is edited by this spec.
 *
 * J1 is the UNUSABLE-PRODUCT case: stdin is a pipe, so `moe-up-main.ts`'s
 * `process.stdin.isTTY === true` test fails, `--operator-stdin` is never passed,
 * and the daemon has no channel any label could arrive on. The browser must be
 * TOLD that, from a daemon-stated response header, instead of being shown a code
 * nothing can approve.
 *
 * J2 is the interactive case. A test process has no pty, so the launcher is
 * driven IN PROCESS through its own injection seams - a `operatorInput` stream
 * and `options.spawn` - while it spawns the REAL daemon child over the real
 * private `--operator-stdin` pipe. Only the agent wrapper is stood in for: it
 * binds an MCP port and spawns agents, neither of which pairing touches.
 */

const BUILD_MS = 240_000;
const DAEMON_READY_MS = 90_000;
/** `PAIRING_APPROVAL_TTL_MS` is 60_000; this outlives it with settle room. */
const EXPIRY_WAIT_MS = 63_000;
const LAUNCHER_ORIGIN = /moe up: daemon listening on (http:\/\/127\.0\.0\.1:\d+)/u;
const LABEL_SHAPE = /[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/u;
/** The same surfaces `prd-to-approval.spec.ts:74` refuses, kept spelled alike. */
const SECRET_TOKENS = /pairing token|#pair=|requestId|confirmationLabel|sessionCredential/iu;

const PROMPT_LINE
  = "A browser wants to pair. Type the code shown in that browser here, then press Enter.";
const NO_TERMINAL_PROMPT_LINE = "A browser wants to pair, but this daemon has no operator terminal."
  + " Stop it and run pnpm start from a terminal window.";
const NO_TERMINAL_COPY = "Moe was started without a terminal it can listen on."
  + " Stop it and run pnpm start from a terminal window, then reload this page.";
const OPERATOR_CHANNEL_HEADER = "x-moe-operator-channel";

/**
 * The three outcomes a typed line can have, spelled out rather than imported:
 * `describePairingOutcome` composes them at runtime, and importing the layer
 * constant would make a rename invisible to this file.
 *
 * Listed in EXECUTION order, because J2 iterates this roster rather than naming
 * its members: a deleted member shrinks the loop, and the executed count is
 * asserted against the roster's own length as well as against a pinned 3.
 */
const OPERATOR_OUTCOME_LINES: readonly { readonly key: string; readonly line: string }[]
  = Object.freeze([
    Object.freeze({
      key: "UNKNOWN",
      line: "That code is not one Moe is waiting for."
        + " PAIRING_CONFIRMATION_UNKNOWN@CONTROL_ROOM_PAIRING_APPROVAL",
    }),
    Object.freeze({ key: "APPROVED", line: "Paired. APPROVED@CONTROL_ROOM_PAIRING_APPROVAL" }),
    Object.freeze({
      key: "EXPIRED",
      line: "That code expired - reload the browser page for a new one."
        + " PAIRING_REQUEST_EXPIRED@CONTROL_ROOM_PAIRING_APPROVAL",
    }),
  ]);

/**
 * Spellings the browser's own font makes plausible. Each is fed at BOTH filters,
 * and the two filters are the ONLY mechanism that can save it at each: an
 * unnormalized launcher never writes the line to the daemon at all, so the
 * daemon's own normalization cannot stand in for it, and vice versa.
 */
const HOSTILE_SPELLINGS = Object.freeze([
  Object.freeze({ key: "UPPERCASE", spell: (label: string): string => label.toUpperCase() }),
  Object.freeze({ key: "TRAILING_SPACE", spell: (label: string): string => `${label} ` }),
] as const);

/** Where a code must never appear. Swept once J1 and J2 have filled every slot. */
const SECRECY_SURFACES = Object.freeze([
  "daemon-stdout", "daemon-stderr", "launcher-log", "daemon-argv", "observed-urls", "j1-page-dom",
] as const);
type SecrecySurface = (typeof SECRECY_SURFACES)[number];

interface Sweep {
  /** The label J2 read from the DOM: J3's needle, and its positive control. */
  label?: string;
  labelWasShown?: boolean;
  surfaces?: Partial<Record<SecrecySurface, string>>;
}

/**
 * The sweep crosses a PROCESS boundary, not just a test boundary: playwright
 * restarts its worker after a failing test, so module state written by J1 is gone
 * by the time J3 runs. Measured, not assumed - J3 first read an empty roster
 * while J2 had demonstrably filled four of its slots.
 */
const SWEEP_PATH = join(tmpdir(), "moe-e2e-pairing-operator-channel-sweep.json");

function readSweep(): Sweep {
  try { return JSON.parse(readFileSync(SWEEP_PATH, "utf8")) as Sweep; }
  catch { return {}; }
}

/** Read-modify-write, so a restarted worker adds to the sweep instead of truncating it. */
function recordSweep(patch: Sweep): void {
  const merged = readSweep();
  writeFileSync(SWEEP_PATH, JSON.stringify({
    ...merged, ...patch,
    surfaces: { ...merged.surfaces, ...patch.surfaces },
  }), "utf8");
}

const swept: Partial<Record<SecrecySurface, string>> = {};
let bundleRoot = "";

function launcherEnv(scratch: LaneScratch): Readonly<Record<string, string | undefined>> {
  return Object.freeze({
    ...daemonEnv(scratch, "SPEED"),
    // `providerFor("node")` is undefined, so the launcher demands no provider
    // credential and its refusal path cannot depend on this host's environment.
    MOE_AGENT_COMMAND: "node",
  });
}

interface InProcessLauncher {
  readonly daemonChild: ChildProcess;
  readonly log: readonly string[];
  readonly origin: string;
  readonly stop: () => Promise<void>;
  readonly write: (text: string) => void;
}

/** Runs the real `runMoeUp` here, with a real daemon child and an inert wrapper. */
async function startLauncher(root: string, scratch: LaneScratch): Promise<InProcessLauncher> {
  const spawnReal = createProcessSpawn();
  const log: string[] = [];
  const operator = new Readable({ read: () => undefined });
  let daemonHandle: ChildProcess | null = null;
  let interrupt: (() => void) | null = null;
  const spawn: LaunchSpawn = (command, argv, options): LaunchChildProcess => {
    if (!argv.some((entry) => entry.endsWith("daemon-main.ts"))) {
      // The wrapper stands in: it owns an MCP port and agent children, and this
      // journey asserts nothing about either. It must not EXIT - a child exit is
      // a teardown trigger in `createFleet` and would kill the daemon under test.
      return spawnReal(command, ["-e", "setInterval(() => undefined, 3_600_000);"], options);
    }
    swept["daemon-argv"] = argv.join(" ");
    const child = spawnReal(command, argv, options);
    daemonHandle = child as unknown as ChildProcess;
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => { out += String(chunk); swept["daemon-stdout"] = out; });
    child.stderr?.on("data", (chunk) => { err += String(chunk); swept["daemon-stderr"] = err; });
    return child;
  };
  const finished = runMoeUp({
    env: launcherEnv(scratch),
    log: (line) => { log.push(line); swept["launcher-log"] = log.join("\n"); },
    onSignal: (handler) => { interrupt = handler; },
    operatorInput: operator,
    repoRoot: root,
    spawn,
  });
  void finished.catch(() => undefined);
  const origin = await waitForLine(log, LAUNCHER_ORIGIN, DAEMON_READY_MS);
  expect(origin, `launcher never announced an origin:\n${log.join("\n")}`).not.toBeNull();
  expect(daemonHandle, "the launcher must have spawned a real daemon child").not.toBeNull();
  const daemonChild = daemonHandle as unknown as ChildProcess;
  expect(daemonChild.pid, "the daemon child must own a pid").toBeGreaterThan(0);
  return {
    daemonChild,
    log,
    origin: origin ?? "",
    stop: async (): Promise<void> => {
      interrupt?.();
      operator.push(null);
      // Swallowed deliberately: `stop` runs from a `finally`, and letting a
      // launcher rejection escape there would replace the assertion that
      // actually failed with a teardown error nobody can attribute.
      await finished.catch(() => undefined);
    },
    write: (text): void => { operator.push(text); },
  };
}

/** The first capture of `pattern` across collected lines, or null once spent. */
function waitForLine(
  lines: readonly string[], pattern: RegExp, budgetMs: number,
): Promise<string | null> {
  const deadline = Date.now() + budgetMs;
  return new Promise((done) => {
    const timer = setInterval(() => {
      const found = pattern.exec(lines.join("\n"))?.[1];
      if (found !== undefined) { clearInterval(timer); done(found); return; }
      if (Date.now() >= deadline) { clearInterval(timer); done(null); }
    }, 150);
  });
}

const countOf = (log: readonly string[], text: string): number =>
  log.filter((line) => line.includes(text)).length;

/**
 * Waits for the log to hold `wanted` copies of `text`, and answers the count it
 * actually saw. Counting rather than matching presence is load-bearing: a
 * presence check is satisfied by the PREVIOUS arm's line and would let a silently
 * dropped label read as disclosed - the exact defect this row exists to close.
 */
async function awaitLogCount(
  log: readonly string[], text: string, wanted: number, budgetMs = 15_000,
): Promise<number> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const seen = countOf(log, text);
    if (seen >= wanted || Date.now() >= deadline) return seen;
    await new Promise((done) => setTimeout(done, 100));
  }
}

test.beforeAll(async () => {
  test.setTimeout(BUILD_MS + 30_000);
  // A sweep left by an earlier run would let J3 pass on stale surfaces.
  rmSync(SWEEP_PATH, { force: true });
  const root = repoRoot();
  expect(root, "repo root (package.json + pnpm-workspace.yaml)").not.toBeNull();
  if (root === null) return;
  // Cleared VITE_MOE_LIVE_*: a bundle carrying a baked secret is refused by the
  // daemon's static host, and this lane's whole point is a RUNTIME handshake.
  const build = spawnNode(
    [join(root, "apps", "control-room", "node_modules", "vite", "bin", "vite.js"), "build"],
    join(root, "apps", "control-room"),
    { ...process.env, VITE_MOE_LIVE_CREDENTIAL: undefined, VITE_MOE_LIVE_CSRF: undefined },
  );
  const code = await new Promise<number | null>((done) => {
    const timer = setTimeout(() => { done(null); }, BUILD_MS);
    build.child.once("exit", (exit) => { clearTimeout(timer); done(exit); });
  });
  expect(code, `vite build:\n${build.transcript().slice(-800)}`).toBe(0);
  bundleRoot = join(root, "apps", "control-room", "dist");
  expect(existsSync(join(bundleRoot, "index.html")), "the build must emit index.html").toBe(true);
});

test("J1: a non-TTY launch tells the browser no terminal can approve it", async ({ page }) => {
  const root = repoRoot();
  if (root === null) return;
  const scratch = createLaneScratch();
  const children: ChildProcess[] = [];
  try {
    // stdio defaults to pipes, so `process.stdin.isTTY` is NOT true inside the
    // launcher: the real IDE-run-window / piped / service start, unfaked.
    const launcher = spawnNode([
      "--experimental-transform-types",
      join(root, "apps", "daemon", "src", "orchestrator", "moe-up-main.ts"),
    ], root, launcherEnv(scratch));
    children.push(launcher.child);
    const origin = await launcher.waitFor(LAUNCHER_ORIGIN, DAEMON_READY_MS);
    expect(origin, `launcher origin:\n${launcher.transcript().slice(-1200)}`)
      .toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);

    const pairing = page.waitForResponse((res) => res.url().endsWith("/session/pair/request"));
    await page.goto(`${origin as string}/`, { waitUntil: "domcontentloaded" });
    const response = await pairing;
    // The fact is DAEMON-STATED, on an additive header; the frozen JSON body is
    // untouched, so no consumer of the pairing wire learns a new key.
    expect(response.status()).toBe(200);
    expect(response.headers()[OPERATOR_CHANNEL_HEADER]).toBe("false");
    expect(Object.keys(await response.json() as Record<string, unknown>).toSorted())
      .toEqual(["confirmationLabel", "ok", "requestId"]);

    await expect(page.getByText(NO_TERMINAL_COPY)).toBeVisible({ timeout: 20_000 });
    const dom = await page.content();
    swept["j1-page-dom"] = dom;
    // No unapprovable code is presented as actionable: no label, no ritual.
    expect(dom).not.toMatch(LABEL_SHAPE);
    expect(await page.getByRole("button", { name: "I entered this label" }).count()).toBe(0);
    // The launcher's own filter did not eat the diagnostic either.
    expect(launcher.transcript()).toContain(NO_TERMINAL_PROMPT_LINE);
  } finally {
    recordSweep({ surfaces: swept });
    for (const child of [...children].reverse()) await killTree(child);
    expect(await survivingChildren(children), "every child must be reaped").toEqual([]);
    try { rmSync(scratch.root, { force: true, recursive: true }); } catch { /* TEMP litter */ }
  }
});

test("J2: the launcher prompts, relays a hostile spelling, and discloses every outcome",
  async ({ page }) => {
    test.setTimeout(EXPIRY_WAIT_MS + 150_000);
    const root = repoRoot();
    if (root === null) return;
    const scratch = createLaneScratch();
    let launcher: InProcessLauncher | null = null;
    const urls: string[] = [];
    page.on("request", (request) => { urls.push(request.url()); });
    try {
      launcher = await startLauncher(root, scratch);
      expect(bundleRoot, "the daemon must be hosting the built bundle").not.toBe("");
      // (i) Nothing has asked to pair, so nothing prompts. The prompt is timed on
      //     a successful request, not printed at startup where it would be noise.
      expect(countOf(launcher.log, PROMPT_LINE)).toBe(0);

      const pairing = page.waitForResponse((res) => res.url().endsWith("/session/pair/request"));
      await page.goto(`${launcher.origin}/`, { waitUntil: "domcontentloaded" });
      expect((await pairing).headers()[OPERATOR_CHANNEL_HEADER]).toBe("true");

      // (ii) The prompt SURVIVED `suppressDaemonLine` - the censor this row exists
      //      for - and appears exactly once, prefixed by the launcher's own label.
      expect(await awaitLogCount(launcher.log, PROMPT_LINE, 1)).toBe(1);
      expect(launcher.log.some((line) => line === `[daemon] ${PROMPT_LINE}`)).toBe(true);

      const labelOutput = page.getByLabel("Pairing confirmation label");
      await expect(labelOutput).toBeVisible({ timeout: 20_000 });
      const label = (await labelOutput.textContent())?.trim() ?? "";
      expect(label).toMatch(/^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u);
      recordSweep({ label, labelWasShown: (await page.content()).includes(label) });

      // A well-formed label that was never issued: repeatable, and it disturbs no
      // live request, so it is the one arm hostile spellings can be swept over.
      const stranger = "dead-beef-cafe";
      const held = launcher;

      /**
       * UNKNOWN, fed at BOTH filters under every hostile spelling. The two filters
       * DIVERGE by input path: an unnormalized launcher never writes the line to
       * the daemon at all, so the daemon's normalization cannot stand in for it,
       * and a line written straight to the daemon's stdin never meets the
       * launcher's. Each arm has exactly one mechanism that can save it.
       */
      const driveUnknown = async (line: string): Promise<void> => {
        let seen = 0;
        for (const spelling of HOSTILE_SPELLINGS) {
          for (const filter of ["launcher", "daemon"] as const) {
            const typed = `${spelling.spell(stranger)}\n`;
            if (filter === "launcher") held.write(typed);
            else held.daemonChild.stdin?.write(typed);
            seen += 1;
            expect(
              await awaitLogCount(held.log, line, seen),
              `${spelling.key} was dropped unannounced at the ${filter} filter`,
            ).toBe(seen);
          }
        }
        expect(seen).toBe(HOSTILE_SPELLINGS.length * 2);
        // NEGATIVE CONTROL: a leading TAB is discarded by the operator channel
        // itself, so NEITHER filter can normalize it and no line may appear.
        // Without this the arms above would also pass against a system that
        // echoed an outcome for every line it read.
        held.write(`\t${stranger}\n`);
        expect(await awaitLogCount(held.log, line, seen + 1, 3_000)).toBe(seen);
      };

      /** The label is read from the PAGE only, and typed back in the browser's
       *  own uppercase with a trailing space. */
      const driveApproved = async (line: string): Promise<void> => {
        held.write(`${label.toUpperCase()} \n`);
        expect(await awaitLogCount(held.log, line, 1)).toBe(1);
        await page.getByRole("button", { name: "I entered this label" }).click();
        await expect(page.getByLabel("Pairing confirmation label"))
          .toBeHidden({ timeout: 20_000 });
      };

      /** On the daemon's OWN 60s clock: no injected time, no fake TTL. */
      const driveExpired = async (line: string): Promise<void> => {
        await page.reload({ waitUntil: "domcontentloaded" });
        const second = page.getByLabel("Pairing confirmation label");
        await expect(second).toBeVisible({ timeout: 20_000 });
        const stale = (await second.textContent())?.trim() ?? "";
        expect(stale).toMatch(/^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u);
        await new Promise((done) => setTimeout(done, EXPIRY_WAIT_MS));
        held.write(`${stale}\n`);
        expect(await awaitLogCount(held.log, line, 1)).toBe(1);
      };

      // Keyed by string, NOT by the roster's own union: a roster member with no
      // driver must fail loudly instead of type-checking itself out of existence.
      const drivers: Readonly<Record<string, (line: string) => Promise<void>>> = {
        APPROVED: driveApproved, EXPIRED: driveExpired, UNKNOWN: driveUnknown,
      };
      const executed: string[] = [];
      for (const arm of OPERATOR_OUTCOME_LINES) {
        const driver = drivers[arm.key];
        expect(driver, `roster member ${arm.key} has no driver`).toBeDefined();
        await driver?.(arm.line);
        executed.push(arm.key);
      }

      // Deleting a roster member shrinks the loop above, so BOTH the executed
      // count and the pinned length go red; deleting a spelling reds the sweep
      // count inside the UNKNOWN driver.
      expect(executed).toHaveLength(OPERATOR_OUTCOME_LINES.length);
      expect(executed.toSorted()).toEqual(OPERATOR_OUTCOME_LINES.map((arm) => arm.key).toSorted());
      expect(OPERATOR_OUTCOME_LINES).toHaveLength(3);
      expect(HOSTILE_SPELLINGS).toHaveLength(2);
      swept["observed-urls"] = urls.join("\n");
    } finally {
      recordSweep({ surfaces: swept });
      await launcher?.stop();
      if (launcher !== null) {
        expect(await survivingChildren([launcher.daemonChild]), "the daemon must be reaped")
          .toEqual([]);
      }
      try { rmSync(scratch.root, { force: true, recursive: true }); } catch { /* TEMP litter */ }
    }
  });

test("J3: the code reaches the browser and nothing else", () => {
  const sweep = readSweep();
  const surfaces = sweep.surfaces ?? {};
  // Fails closed: an unswept surface is an unproven one, not a passing one.
  expect(Object.keys(surfaces).toSorted()).toEqual([...SECRECY_SURFACES].toSorted());
  expect(SECRECY_SURFACES).toHaveLength(6);
  const label = sweep.label ?? "";
  expect(label, "J2 must have read a real label").toMatch(LABEL_SHAPE);
  // The positive control. Without it every assertion below could pass against a
  // system that never minted a code at all.
  expect(sweep.labelWasShown, "the browser DOM is the one surface that MUST show it").toBe(true);
  for (const surface of SECRECY_SURFACES) {
    const text = surfaces[surface] ?? "";
    expect(text.length, `${surface} was swept but empty`).toBeGreaterThan(0);
    expect(text, `${surface} leaked the pairing code`).not.toContain(label);
    expect(text, `${surface} leaked a pairing code shape`).not.toMatch(LABEL_SHAPE);
    expect(text, `${surface} leaked a pairing secret`).not.toMatch(SECRET_TOKENS);
  }
});
