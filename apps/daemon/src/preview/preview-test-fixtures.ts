import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE FIXTURE PRODUCT the preview runner is driven against: a real workspace on disk with a
 * real `package.json`, and — where an arm needs one — a real http server that really binds a
 * real port and really serves html. Nothing here is a stub of the product; the only injected
 * seams are the clock, the timeouts and the browser.
 *
 * WHY A REAL SERVER RATHER THAN A FAKE. Two of this row's DoD clauses cannot be satisfied by a
 * fake: a screenshot must DECODE as a PNG (a fake serves nothing for the browser to paint), and
 * the child must be GONE by pid afterwards (a fake has no pid). A fixture that only pretended to
 * listen would let both arms pass while the capability did not exist.
 *
 * THE PATHS ARE REALPATH'D. Windows hands out 8.3 short names for `%TEMP%` and node's
 * `realpathSync` and `realpathSync.native` disagree about them, so a path compared against a
 * child's `cwd` must be canonicalised once, here, or an assertion fails on the name rather than
 * on the behaviour.
 */

const created: string[] = [];

export interface FixtureWorkspaceInput {
  /** Extra files to write, path relative to the workspace root. */
  readonly files?: Readonly<Record<string, string>>;
  readonly scripts: Readonly<Record<string, string>>;
}

/** A throwaway workspace with the given scripts. Removed by `cleanupFixtureWorkspaces`. */
export function fixtureWorkspace(input: FixtureWorkspaceInput): string {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "moe-preview-")));
  created.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture-product", private: true, scripts: input.scripts }, null, 2),
    "utf8",
  );
  for (const [path, content] of Object.entries(input.files ?? {})) {
    writeFileSync(join(root, path), content, "utf8");
  }
  return root;
}

export function cleanupFixtureWorkspaces(): void {
  while (created.length > 0) {
    const root = created.pop();
    if (root === undefined) continue;
    // A child that outlived its arm can still hold a handle here; a failed cleanup must not
    // mask the assertion that actually matters.
    try { rmSync(root, { force: true, recursive: true }); } catch { /* best effort */ }
  }
}

/**
 * A server that binds an EPHEMERAL port and prints the origin Vite-style, so the runner's
 * stdout detection is exercised against the same shape a real dev server prints. It serves one
 * html document per path, with the path in the title, so a screenshot of `/checkout` is
 * distinguishable from one of `/`.
 */
export const LISTENING_SERVER = `
import { createServer } from "node:http";
const server = createServer((request, response) => {
  const path = request.url ?? "/";
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    "<!doctype html><html><head><title>fixture " + path + "</title></head>" +
    "<body style=\\"background:#204060;width:800px;height:600px\\">" +
    "<h1 style=\\"color:white;font-size:64px\\">" + path + "</h1></body></html>",
  );
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log("  ->  Local:   http://127.0.0.1:" + address.port + "/");
});
`;

/**
 * A product that STARTS and never LISTENS. This is the PREVIEW_START_TIMEOUT fixture: the
 * process is healthy, it is doing work, it simply never becomes answerable — which is exactly
 * the process that would otherwise hold a port forever.
 */
export const SILENT_SERVER = `
console.log("building the product, this will take a while");
setInterval(() => { console.log("still building 42 modules in 1200ms"); }, 50);
`;

/**
 * A product that BINDS A PORT and never ANNOUNCES it — the harder timeout fixture, and the one
 * the leak drill needs.
 *
 * `SILENT_SERVER` alone is not a discriminator for the timeout path's cleanup: it holds no port,
 * and it writes to stdout on a timer, so destroying the parent's pipe ends gives it EPIPE and it
 * dies of its own accord. Measured — with the whole cleanup path stubbed to a no-op, the
 * `SILENT_SERVER` arm still passed. This one cannot die that way: it never writes after startup,
 * and it holds a real listening socket, so "the port is free afterwards" is only true if
 * something actually killed it.
 *
 * The port is written to `port.txt` rather than stdout, so the runner's detection never sees it
 * while the test does.
 */
export const SILENT_BOUND_SERVER = `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const server = createServer((request, response) => { response.end("ok"); });
server.listen(0, "127.0.0.1", () => {
  writeFileSync(new URL("./port.txt", import.meta.url), String(server.address().port), "utf8");
});
`;

/** The port `SILENT_BOUND_SERVER` bound, once it has written it, or null while it has not. */
export async function awaitFixturePort(portFile: string, polls = 200): Promise<number | null> {
  for (let remaining = polls; remaining > 0; remaining -= 1) {
    try {
      const text = readFileSync(portFile, "utf8").trim();
      if (/^[0-9]+$/u.test(text)) return Number(text);
    } catch { /* not written yet */ }
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  return null;
}

/** Polls a pid out of the OS table to a budget, the way `tests/e2e/foundation/orphan-reap.ts` does. */
export async function awaitPidGone(
  pid: number, alive: (target: number) => boolean, polls = 200,
): Promise<boolean> {
  for (let remaining = polls; remaining > 0; remaining -= 1) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  return !alive(pid);
}
