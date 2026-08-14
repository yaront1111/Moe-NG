/**
 * The four real ports the JetBrains host supplies to the thin adapter. This is
 * the only place in the package that touches the operating system.
 *
 * Two rules bind every function here.
 *
 * 1. EVERY FAULT BECOMES AN EVIDENCE ARM. A port that throws escapes into the
 *    IDE's event loop, and the adapter then has to invent a layer for it — see
 *    ../index.ts:76-87. Each port catches its own faults and answers with the
 *    arm that states what was actually observed.
 * 2. NO DETAIL CARRIES A SECRET OR A HOST PATH. Details reach logs and IDE
 *    notifications, so they carry a sanitized reason token and nothing else. The
 *    endpoint travels in its own field, where the contract expects it.
 *
 * Nothing is discovered from ambient state: every port takes its configuration
 * explicitly, so a test and a shipped plugin exercise the same code path.
 */

import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type {
  ControlRoomOpenEvidence,
  DaemonDiscoveryEvidence,
  DaemonStartEvidence,
} from "@moe/ide-adapter-contract";
import type { DistributionManifest } from "@moe/contracts";

import { codeOf } from "./jetbrains-host-port-detail.js";

/** Opens a target with the host OS. Injected: this package never shells out to a browser. */
export type BrowserOpener = (target: string) => Promise<void>;

export interface DaemonStartOptions {
  readonly args: readonly string[];
  readonly command: string;
  readonly confirmIntervalMs: number;
  readonly confirmTimeoutMs: number;
  readonly endpoint: string;
}

const MANIFEST_SUFFIX = ".json";

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * DISTRIBUTION DISCOVERY. Reads the installed manifest documents, in a
 * deterministic order.
 *
 * EMPTY ON ANY FAULT, NEVER PARTIAL. A partial set silently drops the component
 * that went missing, and the gate — which refuses on the component SET — would
 * then admit a distribution on the strength of the parts that happened to be
 * readable. An empty set refuses with COMPONENT_SET_INCOMPLETE, which is true.
 *
 * Shape is deliberately NOT validated here. admitDistribution owns exact-shape
 * admission; re-deciding it here would be a second implementation of the same
 * rule, which is the fork this package's boundary exists to prevent.
 */
export async function readInstalledDistributions(
  installRoot: string,
): Promise<readonly DistributionManifest[]> {
  try {
    const entries = await readdir(installRoot);
    const documents = entries.filter((entry) => entry.endsWith(MANIFEST_SUFFIX)).sort();
    const manifests: DistributionManifest[] = [];
    for (const document of documents) {
      const text = await readFile(join(installRoot, document), "utf8");
      const parsed: unknown = JSON.parse(text);
      manifests.push(parsed as DistributionManifest);
    }
    return Object.freeze(manifests);
  } catch {
    return Object.freeze([]);
  }
}

/**
 * DAEMON DISCOVERY. Reachability only.
 *
 * ANY HTTP STATUS IS LISTENING, 401 AND 403 INCLUDED. This probe runs before a
 * session exists, so it carries no credential and cannot be authorized; an
 * authenticated refusal is positive proof something is answering on that port.
 * Reading it as a refusal would start a second daemon beside a healthy one.
 */
export async function probeDaemon(
  endpoint: string,
  timeoutMs: number,
): Promise<DaemonDiscoveryEvidence> {
  try {
    await fetch(endpoint, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { endpoint, status: "LISTENING" };
  } catch (error) {
    const code = codeOf(error);
    if (code === "ECONNREFUSED") return { status: "NOT_LISTENING" };
    return { detail: `the daemon probe did not complete (${code})`, status: "UNDETERMINED" };
  }
}

type Launch =
  | { readonly code: string; readonly ok: false }
  | { readonly ok: true };

/**
 * Detached, with no inherited stdio: a daemon must outlive the IDE that started
 * it, and holding its pipes would keep the editor's process tree alive too.
 * `spawn` and `error` are mutually exclusive, so exactly one settles this.
 */
const launchDetached = (command: string, args: readonly string[]): Promise<Launch> =>
  new Promise((resolve) => {
    try {
      const child = spawn(command, [...args], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", (error: unknown) => resolve({ code: codeOf(error), ok: false }));
      child.once("spawn", () => {
        child.unref();
        resolve({ ok: true });
      });
    } catch (error) {
      resolve({ code: codeOf(error), ok: false });
    }
  });

/**
 * DAEMON START. A spawned process is not a running daemon, so this re-probes
 * until the endpoint answers.
 *
 * THE LOOP IS BOUNDED, AND THE PROBE INSIDE IT IS CLAMPED TO THE REMAINING TIME.
 * An unreachable daemon otherwise freezes the IDE thread that called this, and a
 * probe allowed to outrun the deadline would defeat the bound from the inside.
 */
export async function startDaemon(options: DaemonStartOptions): Promise<DaemonStartEvidence> {
  const launch = await launchDetached(options.command, options.args);
  if (!launch.ok) {
    return { detail: `the daemon could not be launched (${launch.code})`, status: "REFUSED" };
  }

  const deadline = performance.now() + options.confirmTimeoutMs;
  for (;;) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    const evidence = await probeDaemon(options.endpoint, Math.ceil(Math.min(remaining, 1_000)));
    if (evidence.status === "LISTENING" && evidence.endpoint !== null) {
      return { endpoint: evidence.endpoint, status: "LISTENING_CONFIRMED" };
    }
    const left = deadline - performance.now();
    if (left <= 0) break;
    await delay(Math.min(options.confirmIntervalMs, left));
  }
  return {
    detail: "the daemon was launched but never confirmed listening within its bound",
    status: "LAUNCHED_UNCONFIRMED",
  };
}

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    // stat THROWS on a missing path rather than returning a falsy stat, so this
    // catch is the absent case, not an unexpected one.
    return false;
  }
};

type OpenAttempt = "OPENED" | "TIMED_OUT" | { readonly failure: unknown };

/**
 * Bounds the OS opener. Handing a browser launch an unbounded await freezes the
 * IDE thread that called it just as surely as an unbounded confirm loop would,
 * and this one cannot be cancelled — so its promise always keeps a handler,
 * otherwise abandoning it at the bound resurfaces later as an unhandled
 * rejection with no owner.
 */
const openWithin = (
  opener: BrowserOpener,
  assetPath: string,
  timeoutMs: number,
): Promise<OpenAttempt> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve("TIMED_OUT"), timeoutMs);
    void opener(assetPath).then(
      () => {
        clearTimeout(timer);
        resolve("OPENED");
      },
      (failure: unknown) => {
        clearTimeout(timer);
        resolve({ failure });
      },
    );
  });

/**
 * CONTROL ROOM OPEN. Assets are checked before the opener is reached, so a
 * missing installation never launches anything.
 *
 * embedded is ALWAYS "UNAVAILABLE": this host renders nothing at all, and the
 * standalone control room stays the only UI. Reporting embedded "OPENED" would
 * claim a surface that does not exist.
 */
export async function openControlRoom(
  assetPath: string,
  opener: BrowserOpener,
  openTimeoutMs: number,
): Promise<ControlRoomOpenEvidence> {
  if (!(await isFile(assetPath))) {
    return { assets: "ABSENT", detail: "the control room assets are not installed" };
  }
  const present = { assets: "PRESENT", embedded: "UNAVAILABLE" } as const;
  const attempt = await openWithin(opener, assetPath, openTimeoutMs);
  if (attempt === "OPENED") {
    const detail = "the control room was opened in the default browser";
    return { ...present, browser: { detail, status: "OPENED" } };
  }
  if (attempt === "TIMED_OUT") {
    // UNDETERMINED, not REFUSED: the opener may yet succeed. Claiming a refusal
    // would let a caller retry against a browser that is already opening.
    const detail = "the browser did not answer within its bound";
    return { ...present, browser: { detail, status: "UNDETERMINED" } };
  }
  const detail = `the browser refused to open (${codeOf(attempt.failure)})`;
  return { ...present, browser: { detail, status: "REFUSED" } };
}
