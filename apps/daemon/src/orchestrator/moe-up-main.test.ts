import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  MOE_UP_DAEMON_EXITED_BEFORE_LISTENING,
  MOE_UP_DAEMON_ORIGIN_TIMEOUT,
  MOE_UP_STORE_DIR_UNWRITABLE,
  MOE_UP_WRAPPER_START_FAILED,
  runMoeUp,
} from "./moe-up-main.js";
import {
  CONTROL_ROOM_BUNDLE_CANDIDATES, NODE_TRANSFORM_TYPES_FLAG, browserOpenDisabled,
  controlRoomAssetRoot, createProcessSpawn, launchEntryPaths,
} from "./moe-up-spawn.js";
import type { LaunchChildProcess, LaunchSpawn } from "./moe-up-spawn.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const GOOD_ENV = { ANTHROPIC_API_KEY: "sk-test" } as const;

interface SpawnRecord {
  readonly argv: readonly string[];
  readonly child: FakeChild;
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

class FakeChild implements LaunchChildProcess {
  public killCount = 0;
  public readonly pid = 4242;
  private exited = false;
  private readonly exits: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  private readonly stdoutListeners: ((chunk: Buffer | string) => void)[] = [];

  public readonly stderr = { on: (): unknown => this.stderr };
  public readonly stdout = {
    on: (_event: "data", listener: (chunk: Buffer | string) => void): unknown => {
      this.stdoutListeners.push(listener);
      return this.stdout;
    },
  };

  /** A real kill is followed by a real exit; a fake that never exits would let
   * a launcher that forgets to await its children read as passing. */
  public kill(): boolean {
    this.killCount += 1;
    if (this.exited) return false;
    setImmediate(() => { this.exit(null, "SIGTERM"); });
    return true;
  }

  public once(
    _event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown {
    this.exits.push(listener);
    return this;
  }

  /** Drive the child from the test the way a real one drives itself. */
  public say(line: string): void {
    for (const listener of this.stdoutListeners) listener(Buffer.from(`${line}\n`));
  }

  public exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exits.splice(0)) listener(code, signal);
  }
}

function recordingSpawn(): { readonly calls: SpawnRecord[]; readonly spawn: LaunchSpawn } {
  const calls: SpawnRecord[] = [];
  const spawn: LaunchSpawn = (command, argv, options) => {
    const child = new FakeChild();
    calls.push({ argv: [...argv], child, command, cwd: options.cwd, env: options.env });
    return child;
  };
  return { calls, spawn };
}

const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
};

const ORIGIN = "http://127.0.0.1:51234";

interface Harness {
  readonly calls: SpawnRecord[];
  readonly lines: string[];
  readonly result: Promise<number>;
  readonly signal: () => void;
}

const tempRoots: string[] = [];

/**
 * A repo root with NO built control room, so a case that pins the no-hosting
 * shape cannot flip on whether this checkout happens to have run a Vite build
 * (`apps/control-room/dist` is gitignored and present on a developer machine).
 */
function bareRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "moe-up-bare-"));
  tempRoots.push(root);
  return root;
}

/** A repo root laid out like the packaged artifact: `<root>/control-room/index.html`. */
function hostedRoot(): { readonly bundle: string; readonly root: string } {
  const root = mkdtempSync(join(tmpdir(), "moe-up-hosted-"));
  tempRoots.push(root);
  const bundle = join(root, "control-room");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, "index.html"), "<!doctype html><title>moe</title>\n");
  return { bundle, root };
}

function start(
  env: Readonly<Record<string, string | undefined>>,
  extra: { readonly originTimeoutMs?: number; readonly repoRoot?: string } = {},
): Harness {
  const { calls, spawn } = recordingSpawn();
  const lines: string[] = [];
  let signal = (): void => { throw new Error("no signal handler registered"); };
  const storeRoot = mkdtempSync(join(tmpdir(), "moe-up-"));
  tempRoots.push(storeRoot);
  const result = runMoeUp({
    env: { ...env, MOE_STORE_PATH: join(storeRoot, "store.sqlite") },
    log: (line) => lines.push(line),
    onSignal: (handler) => { signal = handler; },
    repoRoot: REPO_ROOT,
    spawn,
    ...extra,
  });
  return { calls, lines, result, signal: () => { signal(); } };
}

afterEach(() => { tempRoots.length = 0; });

describe("runMoeUp refuses before it spawns", () => {
  it("names the missing variable and starts no child at all", async () => {
    const harness = start({});
    expect(await harness.result).toBe(1);
    expect(harness.calls).toHaveLength(0);
    expect(harness.lines.join(String.fromCharCode(10))).toContain(
      "MOE_UP_ENV_MISSING: CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY",
    );
  });
});

describe("runMoeUp daemon argv", () => {
  it("runs the daemon entry through node with an explicit dependency provider", async () => {
    const harness = start(GOOD_ENV);
    await settle();
    const daemon = harness.calls[0];
    expect(daemon?.command).toBe(process.execPath);
    expect(daemon?.argv[0]).toBe(NODE_TRANSFORM_TYPES_FLAG);
    expect(daemon?.argv[1]?.replaceAll("\\", "/")).toContain("apps/daemon/src/daemon-main.ts");
    expect(daemon?.argv[2]?.replaceAll("\\", "/"))
      .toMatch(/^--dependencies=.*apps\/daemon\/src\/daemon-store-dependencies\.ts$/u);
    harness.calls[0]?.child.exit(0);
    await harness.result;
  });

  it("passes NO --port, so the daemon keeps its deliberate ephemeral bind", async () => {
    const harness = start(GOOD_ENV, { repoRoot: bareRoot() });
    await settle();
    expect(harness.calls[0]?.argv.filter((entry) => entry.startsWith("--port"))).toEqual([]);
    expect(harness.calls[0]?.argv).toHaveLength(3);
    harness.calls[0]?.child.exit(0);
    await harness.result;
  });

  it("passes --asset-root ONLY when a built control room is present, proven by its index.html", async () => {
    const { bundle, root } = hostedRoot();
    const hosted = start(GOOD_ENV, { repoRoot: root });
    await settle();
    // The daemon's own flag, the bundle directory itself, and nothing else new:
    // the daemon still proves the root before it binds.
    expect(hosted.calls[0]?.argv).toHaveLength(4);
    expect(hosted.calls[0]?.argv[3]).toBe(`--asset-root=${bundle}`);
    hosted.calls[0]?.child.exit(0);
    await hosted.result;

    const bare = start(GOOD_ENV, { repoRoot: bareRoot() });
    await settle();
    expect(bare.calls[0]?.argv.filter((entry) => entry.startsWith("--asset-root"))).toEqual([]);
    bare.calls[0]?.child.exit(0);
    await bare.result;
  });

  it("hands the child the resolved store trio", async () => {
    const harness = start(GOOD_ENV);
    await settle();
    const env = harness.calls[0]?.env ?? {};
    expect(env["MOE_PROJECT_ID"]).toBe("moe-next-dev");
    expect(env["MOE_DAEMON_CREDENTIAL"]).toMatch(/^[0-9a-f]{64}$/u);
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-test");
    harness.calls[0]?.child.exit(0);
    await harness.result;
  });
});

describe("runMoeUp origin handshake", () => {
  it("prints the bound origin and the two-process recipe when nothing is hosted, then starts the wrapper", async () => {
    const harness = start(GOOD_ENV, { repoRoot: bareRoot() });
    await settle();
    expect(harness.calls).toHaveLength(1);

    harness.calls[0]?.child.say(`listening on ${ORIGIN}`);
    await settle();

    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[1]?.command).toBe(process.execPath);
    expect(harness.calls[1]?.argv[0]).toBe(NODE_TRANSFORM_TYPES_FLAG);
    expect(harness.calls[1]?.argv[1]?.replaceAll("\\", "/"))
      .toContain("apps/daemon/src/orchestrator/agent-wrapper-main.ts");
    expect(harness.calls[1]?.argv).toHaveLength(2);

    const printed = harness.lines.join("\n");
    // The line the packaged smoke reads, verbatim.
    expect(harness.lines).toContain(`moe up: daemon listening on ${ORIGIN}`);
    // The hint names the override the control room's vite config actually reads,
    // and says nothing about a hosted board because there is none.
    expect(printed).toContain("MOE_DAEMON_ORIGIN");
    expect(printed).not.toContain("hosted by the daemon");

    harness.calls[0]?.child.exit(0);
    await harness.result;
  });

  it("prints ONE URL to open and no dev-server recipe when the daemon hosts the bundle", async () => {
    const { bundle, root } = hostedRoot();
    const harness = start(GOOD_ENV, { repoRoot: root });
    await settle();
    harness.calls[0]?.child.say(`listening on ${ORIGIN}`);
    await settle();

    const printed = harness.lines.join("\n");
    expect(harness.lines).toContain(`moe up: daemon listening on ${ORIGIN}`);
    // The daemon's own origin - the literal loopback IP it printed, which is the
    // only Host its static route accepts - and the bundle it was handed.
    expect(printed).toContain(`open ${ORIGIN}/`);
    expect(printed).toContain(bundle);
    expect(printed).not.toContain("MOE_DAEMON_ORIGIN");
    expect(printed).not.toContain("pnpm dev");
    expect(printed).not.toContain("localhost");

    harness.calls[0]?.child.exit(0);
    await harness.result;
  });

  it("refuses by name when the daemon dies before it ever announces an origin", async () => {
    const harness = start(GOOD_ENV);
    await settle();
    harness.calls[0]?.child.exit(7);
    expect(await harness.result).toBe(7);
    expect(harness.calls).toHaveLength(1);
    expect(harness.lines.join("\n")).toContain(MOE_UP_DAEMON_EXITED_BEFORE_LISTENING);
  });

  it("refuses by name when the origin never arrives, instead of hanging forever", async () => {
    const harness = start(GOOD_ENV, { originTimeoutMs: 5 });
    expect(await harness.result).toBe(1);
    expect(harness.lines.join("\n")).toContain(MOE_UP_DAEMON_ORIGIN_TIMEOUT);
    expect(harness.calls[0]?.child.killCount).toBe(1);
    expect(harness.calls).toHaveLength(1);
  });
});

describe("runMoeUp pairing handshake", () => {
  function startWithOpener(
    repoRoot: string,
  ): { calls: SpawnRecord[]; lines: string[]; opened: string[]; result: Promise<number> } {
    const { calls, spawn } = recordingSpawn();
    const lines: string[] = [];
    const opened: string[] = [];
    const storeRoot = mkdtempSync(join(tmpdir(), "moe-up-pair-"));
    tempRoots.push(storeRoot);
    const result = runMoeUp({
      env: { ...GOOD_ENV, MOE_STORE_PATH: join(storeRoot, "store.sqlite") },
      log: (line) => lines.push(line),
      onSignal: () => undefined,
      openUrl: (url) => opened.push(url),
      repoRoot,
      spawn,
    });
    return { calls, lines, opened, result };
  }

  it("announces the #pair URL and opens it when the daemon prints a pairing token", async () => {
    const { root } = hostedRoot();
    const harness = startWithOpener(root);
    await settle();
    // The daemon prints the token BEFORE the origin, so both land in one buffer.
    harness.calls[0]?.child.say("pairing token tok-XYZ");
    harness.calls[0]?.child.say(`listening on ${ORIGIN}`);
    await settle();

    const pairUrl = `${ORIGIN}/#pair=tok-XYZ`;
    expect(harness.lines.join("\n")).toContain(`open ${pairUrl}`);
    expect(harness.opened).toEqual([pairUrl]);
    // The verbatim smoke line still leads.
    expect(harness.lines).toContain(`moe up: daemon listening on ${ORIGIN}`);

    harness.calls[0]?.child.exit(0);
    await harness.result;
  });

  it("opens no browser and prints no #pair fragment when nothing is hosted", async () => {
    const harness = startWithOpener(bareRoot());
    await settle();
    harness.calls[0]?.child.say(`listening on ${ORIGIN}`);
    await settle();

    expect(harness.opened).toEqual([]);
    expect(harness.lines.join("\n")).not.toContain("#pair=");

    harness.calls[0]?.child.exit(0);
    await harness.result;
  });
});

describe("moe up browser gating", () => {
  it("suppresses the browser on MOE_UP_NO_BROWSER or --no-open, and opens otherwise", () => {
    expect(browserOpenDisabled({ MOE_UP_NO_BROWSER: "1" }, [])).toBe(true);
    expect(browserOpenDisabled({}, ["--no-open"])).toBe(true);
    // An empty value is not set: the switch must carry a value to disable.
    expect(browserOpenDisabled({ MOE_UP_NO_BROWSER: "" }, [])).toBe(false);
    expect(browserOpenDisabled({}, [])).toBe(false);
  });
});

describe("runMoeUp teardown", () => {
  it("kills the wrapper when the daemon dies", async () => {
    const harness = start(GOOD_ENV);
    await settle();
    harness.calls[0]?.child.say(`listening on ${ORIGIN}`);
    await settle();
    harness.calls[0]?.child.exit(3);
    expect(await harness.result).toBe(3);
    expect(harness.calls[1]?.child.killCount).toBe(1);
  });

  it("kills the daemon when the wrapper dies", async () => {
    const harness = start(GOOD_ENV);
    await settle();
    harness.calls[0]?.child.say(`listening on ${ORIGIN}`);
    await settle();
    harness.calls[1]?.child.exit(0);
    expect(await harness.result).toBe(0);
    expect(harness.calls[0]?.child.killCount).toBe(1);
  });

  it("kills both children once on ctrl-c, and a second ctrl-c kills nothing twice", async () => {
    const harness = start(GOOD_ENV);
    await settle();
    harness.calls[0]?.child.say(`listening on ${ORIGIN}`);
    await settle();

    harness.signal();
    harness.signal();

    expect(await harness.result).toBe(0);
    // Exactly once each: the second interrupt must find the latch already thrown.
    expect(harness.calls[0]?.child.killCount).toBe(1);
    expect(harness.calls[1]?.child.killCount).toBe(1);
  });
});

describe("moe up control-room bundle discovery", () => {
  it("tries the checkout's Vite output, then the packaged layout, and nothing else", () => {
    expect(CONTROL_ROOM_BUNDLE_CANDIDATES.map((segments) => segments.join("/")))
      .toEqual(["apps/control-room/dist", "control-room"]);
  });

  it("finds a bundle in either layout, proven by a regular index.html, and null otherwise", () => {
    const dev = mkdtempSync(join(tmpdir(), "moe-up-dev-"));
    tempRoots.push(dev);
    mkdirSync(join(dev, "apps", "control-room", "dist"), { recursive: true });
    writeFileSync(join(dev, "apps", "control-room", "dist", "index.html"), "<!doctype html>\n");
    expect(controlRoomAssetRoot(dev)).toBe(join(dev, "apps", "control-room", "dist"));

    const packaged = hostedRoot();
    expect(controlRoomAssetRoot(packaged.root)).toBe(packaged.bundle);

    // No bundle, the ordinary development state: null, never a guessed directory.
    expect(controlRoomAssetRoot(bareRoot())).toBeNull();

    // A directory named index.html is not a bundle; neither is a dist directory
    // without one. The daemon would refuse both, so the launcher does not ask.
    const hollow = bareRoot();
    mkdirSync(join(hollow, "apps", "control-room", "dist", "index.html"), { recursive: true });
    mkdirSync(join(hollow, "control-room"), { recursive: true });
    expect(controlRoomAssetRoot(hollow)).toBeNull();
  });
});

describe("moe up production wiring", () => {
  it("resolves both entries and the dependency provider to files that exist", () => {
    const paths = launchEntryPaths(REPO_ROOT);
    for (const path of [paths.daemonEntry, paths.dependencies, paths.wrapperEntry]) {
      expect(existsSync(path)).toBe(true);
    }
  });

  it("really spawns through node with a spaced path and no shell, end to end", async () => {
    const root = mkdtempSync(join(tmpdir(), "moe up real-"));
    tempRoots.push(root);
    const stubs = join(root, "apps", "daemon", "src");
    mkdirSync(join(stubs, "orchestrator"), { recursive: true });
    writeFileSync(
      join(stubs, "daemon-main.ts"),
      `process.stdout.write("listening on ${ORIGIN}\\n");\nsetTimeout(() => {}, 60000);\n`,
    );
    writeFileSync(join(stubs, "daemon-store-dependencies.ts"), "export default {};\n");
    writeFileSync(
      join(stubs, "orchestrator", "agent-wrapper-main.ts"),
      "process.stdout.write(\"stub wrapper pass\\n\");\n",
    );

    const lines: string[] = [];
    const code = await runMoeUp({
      env: { ...GOOD_ENV, MOE_STORE_PATH: join(root, "store.sqlite") },
      log: (line) => lines.push(line),
      onSignal: () => undefined,
      originTimeoutMs: 30_000,
      repoRoot: root,
      spawn: createProcessSpawn(),
    });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain(ORIGIN);
  }, 30_000);
});

describe("moe up entrypoint wiring", () => {
  const readJson = (...segments: string[]): { readonly [key: string]: unknown } =>
    JSON.parse(readFileSync(join(REPO_ROOT, ...segments), "utf8")) as Record<string, unknown>;

  it("wires the documented root script to the launcher that exists on disk", () => {
    const scripts = readJson("package.json")["scripts"] as Record<string, string>;
    // tsc never reads a package.json string, so without this the one documented
    // command can rot to a dead path while every other gate stays green.
    const target = scripts["start"]?.split(" ").at(-1);
    expect(scripts["start"]?.split(" ")[0]).toBe("node");
    expect(target).toBeDefined();
    expect(target?.endsWith("orchestrator/moe-up-main.ts")).toBe(true);
    expect(existsSync(join(REPO_ROOT, target as string))).toBe(true);
  });

  it("wires the moe-up bin beside the daemon's other entries, at a real file", () => {
    const bin = readJson("apps", "daemon", "package.json")["bin"] as Record<string, string>;
    // `moe` and `moe-wrapper` were added by task-3ac5c237 (the packaged Windows
    // artifact): `moe start` composes THIS launcher, and `moe-wrapper` publishes
    // the wrapper entry the launcher spawns.
    expect(Object.keys(bin).toSorted())
      .toEqual(["moe", "moe-daemon", "moe-mcp-http", "moe-mcp-stdio", "moe-up", "moe-wrapper"]);
    expect(bin["moe-up"]).toBe("./src/orchestrator/moe-up-main.ts");
    expect(existsSync(join(REPO_ROOT, "apps", "daemon", bin["moe-up"] as string))).toBe(true);
    for (const entry of Object.values(bin)) {
      expect(existsSync(join(REPO_ROOT, "apps", "daemon", entry))).toBe(true);
    }
  });
});

/**
 * Why the launcher passes `--experimental-transform-types`, proven from BOTH
 * sides against the real wrapper entry rather than asserted in a comment. The
 * negative control is the point: if a peer removes the parameter property from
 * `agent-spawn-contract.ts`, the first test reddens and tells the next worker
 * the flag can be dropped, instead of it living on forever unexamined.
 */
describe("moe up transform-types flag", () => {
  const loadWrapperEntry = (argv: readonly string[]): { code: number | null; text: string } => {
    const probe = spawnSync(process.execPath, [...argv], {
      cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000,
    });
    return { code: probe.status, text: `${probe.stdout ?? ""}${probe.stderr ?? ""}` };
  };
  const entry = launchEntryPaths(REPO_ROOT).wrapperEntry;
  // `import()` loads the graph without running main (import.meta.main is false).
  const importOnly = `import(${JSON.stringify(pathToFileURL(entry).href)}).then(() => {})`;

  it("cannot load the wrapper entry under plain strip-only node", () => {
    const { text } = loadWrapperEntry(["-e", importOnly]);
    expect(text).toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
  }, 60_000);

  it("loads the same entry once the launcher's flag is passed", () => {
    const { text } = loadWrapperEntry([NODE_TRANSFORM_TYPES_FLAG, "-e", importOnly]);
    expect(text).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
  }, 60_000);
});

describe("runMoeUp error paths leave nothing running", () => {
  it("refuses by name when the dev store directory cannot be created", async () => {
    const root = mkdtempSync(join(tmpdir(), "moe-up-nodir-"));
    tempRoots.push(root);
    const blocker = join(root, "not-a-directory");
    writeFileSync(blocker, "a file where a directory would have to be\n");
    const { calls, spawn } = recordingSpawn();
    const lines: string[] = [];
    const code = await runMoeUp({
      env: { ...GOOD_ENV, MOE_STORE_PATH: join(blocker, "nested", "store.sqlite") },
      log: (line) => lines.push(line),
      onSignal: () => undefined,
      repoRoot: root,
      spawn,
    });
    // A crash is not a refusal: an unwritable store must name a code, not throw
    // a raw ENOTDIR stack out of the launcher.
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain(MOE_UP_STORE_DIR_UNWRITABLE);
    expect(calls).toHaveLength(0);
  });

  it("tears the daemon down when the wrapper fails to start, instead of orphaning it", async () => {
    const children: FakeChild[] = [];
    const lines: string[] = [];
    const storeRoot = mkdtempSync(join(tmpdir(), "moe-up-nowrap-"));
    tempRoots.push(storeRoot);
    const spawn: LaunchSpawn = (_command, argv) => {
      // Only the daemon starts; the wrapper's spawn blows up the way a missing
      // interpreter or an exhausted process table would.
      if (argv.includes(launchEntryPaths(REPO_ROOT).wrapperEntry)) {
        throw new Error("EAGAIN: could not fork");
      }
      const child = new FakeChild();
      children.push(child);
      return child;
    };
    const result = runMoeUp({
      env: { ...GOOD_ENV, MOE_STORE_PATH: join(storeRoot, "store.sqlite") },
      log: (line) => lines.push(line),
      onSignal: () => undefined,
      repoRoot: REPO_ROOT,
      spawn,
    });
    await settle();
    children[0]?.say(`listening on ${ORIGIN}`);

    expect(await result).toBe(1);
    expect(lines.join("\n")).toContain(MOE_UP_WRAPPER_START_FAILED);
    expect(children).toHaveLength(1);
    expect(children[0]?.killCount).toBe(1);
  });
});
