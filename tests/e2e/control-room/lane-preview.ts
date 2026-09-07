/**
 * THE PREVIEW HALF OF THE LANE: a real dev server, started by the real daemon, against the real
 * commit `lane-landing.ts` just landed.
 *
 * WHY THIS EXISTS. `preview-approve.spec.ts` used to state two walls as permanent. Wall A (a
 * landed goal is unreachable) fell to `landLaneNode`, which lands through the real wrapper. Wall B
 * (no preview command in the bound workspace) falls HERE: `resolvePreviewCommand`
 * (preview-command-resolution.ts:137) takes the first non-empty `PREVIEW_SCRIPT_ORDER` entry out
 * of `<workspace>/package.json`, and that workspace is the lane's OWN git tree — so committing a
 * scaffold into it before the landing is all it takes.
 *
 * NOTHING IS SEEDED AND NOTHING IS DOUBLED. The daemon resolves the command, spawns the server,
 * probes the port, proves the LISTENER BELONGS TO THE CHILD TREE (preview-listener-owner.ts) and
 * writes the receipt. This module asks, and reads the answer back through production.
 *
 * THE SEAT IS `lane.credential`, NOT A MINTED ONE — measured, and the opposite of what this row's
 * plan assumed. `session-authenticator.ts:98-105` answers `config.operatorPrincipalId` for a
 * request bearing `config.operatorCredential`; the lane hands the daemon
 * `MOE_DAEMON_CREDENTIAL: LANE_CREDENTIAL` (daemon-ports.ts:318) and names no MOE_PRINCIPAL_ID, so
 * LANE_CREDENTIAL IS the configured operator. `mintLaneOperatorSeat` mints `e2e-lane-operator`, a
 * DIFFERENT id, refused by `preview-start-command.ts:85` — which the spec asserts, not works around.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";

import {
  PREVIEW_DECIDE_COMMAND_KIND, PREVIEW_START_COMMAND_KIND,
} from "../../../apps/daemon/src/preview/preview-contracts.js";
import type { PreviewDecision, PreviewFinding } from "../../../apps/daemon/src/preview/preview-contracts.js";
import { previewAggregateId } from "../../../apps/daemon/src/preview/preview-receipt-contracts.js";
import { readWireProtocolVersion } from "./daemon-ports.js";
import type { DaemonLane } from "./daemon-ports.js";

/** A dev server on loopback, plus the daemon's own port probe and listener-ownership walk. */
const PREVIEW_START_BUDGET_MS = 180_000;
const PREVIEW_POLL_MS = 500;

/** What the live drive screenshots, and what a journey capture would find on the page. */
export const PREVIEW_PAGE_MARKER = "MOE LANE PREVIEW IS SERVING";

/**
 * The scaffold, committed INTO the lane's git workspace so the landed sha carries it.
 *
 * `listen(0)` IS REQUIRED, not tidiness: this checkout runs lanes in parallel and a fixed port
 * would have one lane bind what another holds — reported as PREVIEW_START_TIMEOUT half an hour
 * later, nowhere near its cause.
 *
 * THE PRINTED LINE IS THE CONTRACT. `detectPreviewPort` matches an `http(s)://127.0.0.1:<port>`
 * ORIGIN and nothing else, deliberately, so that "compiled 42 modules" is never read as port 42.
 * A server that printed only its port number would never be detected. The runner spawns
 * `npm run dev` (`preview-runner.ts:162`), and this manifest declares exactly one of
 * `PREVIEW_SCRIPT_ORDER`'s three names so which script ran is never ambiguous.
 */
const PREVIEW_SERVER_SOURCE = `const http = require("node:http");
const body = "<!doctype html><html><head><title>Lane preview</title></head>"
  + "<body><h1>${PREVIEW_PAGE_MARKER}</h1></body></html>";
const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write("http://127.0.0.1:" + String(address.port) + "\\n");
});
`;

const PREVIEW_MANIFEST = `${JSON.stringify({
  name: "lane-preview", private: true, scripts: { dev: "node preview-server.js" },
}, null, 2)}\n`;

/**
 * Runs git in the lane's workspace with GIT_* stripped and the identity on the command line.
 *
 * A PRIVATE COPY of `daemon-ports.ts`'s module-private `laneGit`: that file is outside this row's
 * scope and peers edit it in this shared checkout. Same reasoning it states — a GIT_DIR exported
 * by a parent shell would redirect this commit into the developer's own repository.
 */
function previewGit(cwd: string, args: readonly string[]): string {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_")) environment[key] = value;
  }
  environment["GIT_OPTIONAL_LOCKS"] = "0";
  return execFileSync("git", [...args], {
    cwd, encoding: "utf8", env: environment, maxBuffer: 16_384,
    shell: false, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, windowsHide: true,
  }).replace(/\r?\n$/u, "");
}

const GIT_IDENTITY = ["-c", "user.name=Moe", "-c", "user.email=moe@moe.local", "-c", "commit.gpgsign=false"];

/** Writes and COMMITS the scaffold. Call it BEFORE `landLaneNode` so the landed sha carries it. */
export function writePreviewScaffold(workspace: string): string {
  writeFileSync(join(workspace, "package.json"), PREVIEW_MANIFEST, "utf8");
  writeFileSync(join(workspace, "preview-server.js"), PREVIEW_SERVER_SOURCE, "utf8");
  previewGit(workspace, ["add", "--", "package.json", "preview-server.js"]);
  previewGit(workspace, [...GIT_IDENTITY, "commit", "--quiet", "--message", "Lane preview scaffold"]);
  return previewGit(workspace, ["rev-parse", "--verify", "HEAD^{commit}"]);
}

/** Opened per call, closed in a finally: a held store handle blocks the lane's teardown. */
function laneVersion(lane: DaemonLane, aggregateId: string): number {
  const store = SqliteEventStore.openForProject(
    join(dirname(lane.catalogPath), "store.sqlite"), lane.projectId,
  );
  try { return store.getAggregateVersion(aggregateId); } finally { store.close(); }
}

export interface LaneAnswer { readonly body: Record<string, unknown>; readonly status: number }

/** A command answer plus the id it was sent under, so a caller can read the record back. */
export interface LaneCommandAnswer extends LaneAnswer { readonly commandId: string }

/** POSTs one daemon route with the lane's own headers. `credential` names the SEAT to dispatch as. */
export async function lanePost(
  lane: DaemonLane, path: string, body: Record<string, unknown>, credential?: string,
): Promise<LaneAnswer> {
  const seat = credential ?? lane.credential;
  const response = await fetch(`${lane.daemonOrigin}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json", origin: lane.daemonOrigin,
      "x-moe-csrf": lane.csrfToken,
      "x-moe-protocol-version": await readWireProtocolVersion(lane.repoRoot) ?? "",
      "x-moe-session-credential": seat,
    },
    method: "POST",
  });
  let parsed: unknown = null;
  try { parsed = await response.json(); } catch { parsed = null; }
  return { body: (parsed ?? {}) as Record<string, unknown>, status: response.status };
}

/** One envelope. `schemaVersion` is IMPORTED, never a literal: a hand-copied version drifts. */
async function laneCommand(
  lane: DaemonLane, kind: string, aggregateId: string, payload: Record<string, unknown>,
  credential?: string,
): Promise<LaneCommandAnswer> {
  const commandId = `lane-preview-${kind}-${String(Date.now())}`;
  const answer = await lanePost(lane, "/command", {
    commandId,
    commandKind: kind,
    correlationId: "lane-preview",
    expectedVersion: laneVersion(lane, aggregateId),
    payload,
    requestDigest: "d".repeat(64),
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: credential ?? lane.credential,
    targetAggregateId: aggregateId,
  }, credential);
  return { ...answer, commandId };
}

/** The production read of a goal's preview receipt: `{kind: "ABSENT"|"PRESENT"|"REFUSED", ...}`. */
export async function readLanePreview(lane: DaemonLane, goalId: string): Promise<LaneAnswer> {
  return await lanePost(lane, "/preview/read", { goalId });
}

export interface LanePreviewStarted {
  readonly ok: true;
  /** The 64-hex `previewReceiptId` a later `preview.decide` must name. NOT the aggregate id. */
  readonly receiptId: string;
  readonly url: string;
}

export interface LanePreviewRefused {
  /** The daemon's own words: the command answer and the last receipt read, verbatim. */
  readonly detail: string;
  readonly ok: false;
}

/**
 * Asks for a preview and waits until the RECEIPT says STARTED.
 *
 * ACCEPTED IS NOT STARTED. `preview.start` is an async entry (daemon-command-async-entries.ts:287),
 * so the command answer is about the dispatch; the durable fact is the receipt. On timeout this
 * refuses carrying BOTH the command answer and the receipt's own words.
 */
export async function startLanePreview(
  lane: DaemonLane, goalId: string, sha: string, credential?: string,
): Promise<LanePreviewStarted | LanePreviewRefused> {
  // EXACTLY `{goalId, sha}`: `PREVIEW_START_PAYLOAD_KEYS` is enforced by exact arity, and the
  // workspace is SERVER-HELD precisely so a caller cannot name a directory to spawn out of.
  const answer = await laneCommand(
    lane, PREVIEW_START_COMMAND_KIND, previewAggregateId(goalId), { goalId, sha }, credential,
  );
  const said = JSON.stringify(answer.body);
  const deadline = Date.now() + PREVIEW_START_BUDGET_MS;
  let last = "(never read)";
  while (Date.now() < deadline) {
    const read = await readLanePreview(lane, goalId);
    last = JSON.stringify(read.body);
    const preview = read.body["preview"];
    if (read.body["kind"] === "PRESENT" && typeof preview === "object" && preview !== null) {
      const receipt = preview as Record<string, unknown>;
      if (receipt["outcome"] === "STARTED" && typeof receipt["receiptId"] === "string"
        && typeof receipt["url"] === "string") {
        return { ok: true, receiptId: receipt["receiptId"], url: receipt["url"] };
      }
      // A REFUSED receipt is a decided fact, not a slow start: stop and report its own code.
      if (receipt["outcome"] === "REFUSED") return { detail: `START ${said} RECEIPT ${last}`, ok: false };
    }
    await delay(PREVIEW_POLL_MS);
  }
  return { detail: `START ${said} RECEIPT ${last}`, ok: false };
}

/** Commits the operator's verdict. `previewRef` is the RECEIPT id; findings are `{detail, nodeRef}`. */
export async function decideLanePreview(
  lane: DaemonLane, previewRef: string, decision: PreviewDecision,
  findings?: readonly PreviewFinding[], goalId?: string, credential?: string,
): Promise<LaneCommandAnswer> {
  // The version is read FRESH against `preview:<goalId>` because the runner's own receipt commit
  // has already moved that aggregate; a version read before the start would be fenced.
  const aggregateId = previewAggregateId(goalId ?? "");
  const payload: Record<string, unknown> = findings === undefined
    ? { decision, previewRef }
    : { decision, findings: findings.map(({ detail, nodeRef }) => ({ detail, nodeRef })), previewRef };
  return await laneCommand(lane, PREVIEW_DECIDE_COMMAND_KIND, aggregateId, payload, credential);
}

export interface LaneActivityEntry {
  readonly commandKind: string;
  readonly decidedAt: string;
  readonly disposition: string;
  readonly targetAggregateId: string;
  readonly verdict: string | null;
  readonly version: number | null;
}

/**
 * The daemon's own account of what it decided — the read DoD 2 asserts the verdict from.
 *
 * PROJECT SCOPE (`{}`), NOT `{goalRef}`, AND THAT IS MEASURED. `targetsOf` (activity-read.ts:133)
 * scopes a goal read to the goal, its planning run and its compiled execution refs; a
 * `preview.decide` lands on `preview:<goalId>` (preview-daemon-edge.ts:283), which is in none of
 * them, so a goal-scoped read filters the verdict OUT. Callers assert `targetAggregateId` too.
 */
export async function readActivityVerdicts(
  lane: DaemonLane, selector: Record<string, unknown> = {},
): Promise<readonly LaneActivityEntry[]> {
  const read = await lanePost(lane, "/activity/read", selector);
  const entries = read.body["entries"];
  return Array.isArray(entries) ? entries as readonly LaneActivityEntry[] : [];
}
