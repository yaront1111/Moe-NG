/**
 * Child-process primitives for the daemon-backed lane: spawn, read what the child
 * announces, kill the whole tree, and CONFIRM the tree is gone.
 *
 * Split from `daemon-ports.ts` so neither file does two jobs and both stay well
 * inside the per-file cap: this half knows about processes and pipes and nothing
 * about daemons, seeds or dev servers.
 *
 * WINDOWS IS THE REASON THIS FILE EXISTS AS IT IS. `child.kill()` signals the
 * direct child only, so a Node process that itself spawned workers leaves them
 * holding the store file and the bound port; and a kill that "succeeded" is not
 * evidence the process is gone. Both halves are handled here — `taskkill /t /f`
 * for the tree, `tasklist` for the confirmation.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

/**
 * Vite wraps the port DIGITS themselves in SGR escapes, so a pattern matching
 * `localhost:\d+` never sees them. Measured, not guessed: the raw line reads
 * `Local:   ESC[36mhttp://localhost:ESC[1m62850ESC[22m/ESC[39m`.
 */
export const stripAnsi = (text: string): string => text.replace(/\u001B\[[0-9;]*m/gu, "");

export interface Watched {
  readonly child: ChildProcess;
  /** Everything the child said, for a refusal detail that quotes it. */
  readonly transcript: () => string;
  /** The first capture of `pattern`, or null once `budgetMs` is spent. */
  readonly waitFor: (pattern: RegExp, budgetMs: number) => Promise<string | null>;
}

/**
 * Accumulates output and offers it to one pattern at a time.
 *
 * Accumulated rather than matched per chunk because a pipe may split the
 * announcement anywhere, and a watcher inspecting whole chunks would then wait out
 * its whole budget against a child that already answered.
 */
export function watch(child: ChildProcess): Watched {
  let seen = "";
  const listeners = new Set<() => void>();
  const absorb = (chunk: unknown): void => {
    seen += stripAnsi(String(chunk));
    for (const listener of [...listeners]) listener();
  };
  child.stdout?.on("data", absorb);
  child.stderr?.on("data", absorb);
  return {
    child,
    transcript: () => seen,
    waitFor: (pattern, budgetMs) => new Promise<string | null>((done) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (value: string | null): void => {
        listeners.delete(check);
        clearTimeout(timer);
        done(value);
      };
      function check(): void {
        // The capture is the whole point of every pattern here; a match without
        // one is a pattern bug and must not read as a successful parse.
        const found = pattern.exec(seen)?.[1];
        if (found !== undefined) settle(found);
      }
      listeners.add(check);
      timer = setTimeout(() => { settle(null); }, budgetMs);
      // Once immediately: the child may have answered before this call.
      check();
    }),
  };
}

/** Spawns Node with a fixed argv. No shell, so the pid is the process to kill. */
export function spawnNode(
  args: readonly string[], cwd: string, env: Readonly<Record<string, string | undefined>>,
): Watched {
  return watch(spawn(process.execPath, [...args], { cwd, env: { ...env } }));
}

/** Kills the whole tree. An already-dead pid is SUCCESS, not a teardown failure. */
export function killTree(pid: number): Promise<void> {
  return new Promise((done) => {
    const child = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    child.once("error", () => { done(); });
    child.once("close", () => { done(); });
  });
}

/**
 * True while the pid is still listed. `tasklist` prints an INFO line naming no
 * pid when the filter matches nothing, so the pid's own digits are the discriminator.
 *
 * FAILS CLOSED, and that is the whole point. A probe that cannot run — no
 * `tasklist` on this host, for instance — knows NOTHING about the process, and
 * answering "not alive" there would turn the orphan check into a guarantee that
 * silently holds everywhere it cannot be checked. Unknown is reported as ALIVE, so
 * an unverifiable teardown is a loud E2E_TEARDOWN_ORPHAN instead of a quiet pass.
 */
function isAlive(pid: number): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn("tasklist", ["/FI", `PID eq ${String(pid)}`, "/NH"]);
    let seen = "";
    child.stdout.on("data", (chunk: unknown) => { seen += String(chunk); });
    child.once("error", () => { done(true); });
    child.once("close", (code) => { done(code !== 0 || seen.includes(String(pid))); });
  });
}

/** The pids that outlived teardown. Empty is the only acceptable answer. */
export async function survivingPids(pids: readonly number[]): Promise<readonly number[]> {
  const survivors: number[] = [];
  for (const pid of pids) if (await isAlive(pid)) survivors.push(pid);
  return Object.freeze(survivors);
}

/**
 * An ephemeral port picked by the OS and released, then handed to Vite with
 * `--strictPort` so a collision fails loudly instead of silently serving a
 * different port than the lane believes it owns.
 */
export function freePort(): Promise<number> {
  return new Promise((done, failed) => {
    const probe = createServer();
    probe.once("error", failed);
    probe.listen(0, "127.0.0.1", () => {
      const address: AddressInfo | string | null = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => { failed(new Error("no ephemeral port")); });
        return;
      }
      const { port } = address;
      probe.close(() => { done(port); });
    });
  });
}
