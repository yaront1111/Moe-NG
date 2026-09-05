import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { SqliteEventStore } from "@moe/store";

import { capturePreviewJourneys } from "./preview-capture.js";
import { resolvePreviewCommand } from "./preview-command-resolution.js";
import type { PreviewCommandPlan, PreviewContractFacts } from "./preview-command-resolution.js";
import { isPreviewRefusal, previewRefusal } from "./preview-contracts.js";
import type { PreviewRefusal } from "./preview-contracts.js";
import { readGoalLandingStatus } from "./preview-goal-landing.js";
import { recordPreviewReceipt } from "./preview-ledger.js";
import { startPreviewProcess } from "./preview-process.js";
import type { PreviewProcessHandle, PreviewProcessOptions } from "./preview-process.js";
import type { PreviewReceiptV1, PreviewScreenshot } from "./preview-receipt-contracts.js";

/**
 * THE PREVIEW RUNNER: start the product a goal built, capture the journeys an operator is about
 * to judge, record what happened, and — whatever happens — stop the process.
 *
 * THE ORDER OF THE GATES IS LOAD-BEARING, because each one is cheaper and more certain than the
 * next and each refusal must name the layer that actually answered:
 *   1. PREVIEW_GOAL_NOT_LANDED @ GOAL_AUTHORITY — is there anything built to look at? Asked
 *      first because it needs no process and no browser, and because previewing a goal one node
 *      short would show a product missing exactly that node's work.
 *   2. PREVIEW_COMMAND_MISSING @ RUNNER — does anything know how to serve it?
 *   3. PREVIEW_START_TIMEOUT @ RUNNER — did it actually become answerable?
 * A refusal at any gate is RECORDED, not merely returned: "an absent landing is not a false one"
 * (landing-receipt-contracts.ts header) transfers directly, and the operator's screen has to be
 * able to say why there is nothing to look at.
 *
 * ALWAYS STOP THE CHILD. Every path out of `runPreview` after the process starts goes through
 * `stopPreview`, including the capture-threw path — a leaked preview holds the port and the next
 * preview cannot bind, which surfaces far from its cause. `stop()` is idempotent, so the
 * decision handler, the deadline and a shutdown hook may all call it.
 */

/**
 * The browser side. Optional so an arm can drive the runner without launching Chromium, and
 * DEFAULTED to the real capture so the shipped composition is the real one — a port whose only
 * implementation lived in a test would make every runner arm a test of the test.
 */
export type PreviewCapturePort = (input: {
  readonly directory: string;
  readonly goalId: string;
  readonly journeys: PreviewCommandPlan["journeys"];
  readonly origin: string;
  readonly sha: string;
  readonly workspace: string;
}) => Promise<readonly PreviewScreenshot[]>;

export interface PreviewRunnerConfig {
  readonly capture?: PreviewCapturePort;
  readonly clock?: () => string;
  /** The approved contract's preview-bearing statements for this goal, or null when it has none. */
  readonly contractFacts?: (goalId: string) => PreviewContractFacts | null;
  readonly process?: PreviewProcessOptions;
  readonly projectId: string;
  /** INJECTED in tests; production reads `<workspace>/package.json`. */
  readonly readScripts?: (workspace: string) => Readonly<Record<string, unknown>> | null;
  readonly store: SqliteEventStore;
}

export interface PreviewRunRequest {
  readonly goalId: string;
  /** The landed revision being previewed. Part of the receipt id and of the capture path. */
  readonly sha: string;
  /** Absolute path to the product's workspace. */
  readonly workspace: string;
}

export interface StartedPreview {
  readonly handle: PreviewProcessHandle;
  readonly receipt: PreviewReceiptV1;
}

export type PreviewRunResult =
  | Readonly<{ readonly ok: true; readonly started: StartedPreview }>
  | Readonly<{ readonly ok: false; readonly receipt: PreviewReceiptV1 | null; readonly refusal: PreviewRefusal }>;

/** The workspace's own scripts, or null when it has no readable manifest. */
function workspaceScripts(workspace: string): Readonly<Record<string, unknown>> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const scripts = (parsed as { readonly scripts?: unknown }).scripts;
  return scripts !== null && typeof scripts === "object"
    ? (scripts as Readonly<Record<string, unknown>>)
    : null;
}

/**
 * A goalId or sha that would escape `.moe-next/previews/<goalId>/<sha>/` is refused rather than
 * joined. A separator or `..` here would put one goal's captures inside another's directory — or
 * outside the project entirely — and the receipt would then advertise them as this run's.
 * Whitespace and control characters are refused for the same reason `preview-capture.ts` refuses
 * them in a journey ref: a NUL can truncate a path inside a syscall rather than failing it.
 */
const UNSAFE_SEGMENT = /[\u0000-\u001f\s/\\<>:"|?*]/u;

function containedSegment(value: string): boolean {
  return value.length > 0 && !value.includes("..") && !UNSAFE_SEGMENT.test(value)
    && value !== "." && value !== "..";
}

/** Stops the child and waits for the pid to leave. Never throws: a stop cannot fail a run. */
export async function stopPreview(handle: PreviewProcessHandle): Promise<void> {
  try {
    await handle.stop();
  } catch { /* best effort by contract; liveness is asserted by pid, not by this call */ }
}

function record(
  config: PreviewRunnerConfig, request: PreviewRunRequest, decidedAt: string,
  fields: {
    readonly code: PreviewReceiptV1["code"];
    readonly pid: number | null;
    readonly screenshots: readonly PreviewScreenshot[];
    readonly url: string | null;
  },
): PreviewReceiptV1 | null {
  const recorded = recordPreviewReceipt(config.store, {
    code: fields.code,
    decidedAt,
    goalId: request.goalId,
    pid: fields.pid,
    projectId: config.projectId,
    screenshots: fields.screenshots,
    sha: request.sha,
    url: fields.url,
  });
  return recorded.ok ? recorded.receipt : null;
}

/**
 * Runs one preview. On success the caller HOLDS the handle and owes it a `stopPreview` on
 * APPROVE, on REJECT and on shutdown; every failure path here has already stopped its own child.
 */
export async function runPreview(
  config: PreviewRunnerConfig, request: PreviewRunRequest,
): Promise<PreviewRunResult> {
  const decidedAt = (config.clock ?? ((): string => new Date().toISOString()))();
  const refuse = (code: Parameters<typeof previewRefusal>[0]): PreviewRunResult => ({
    ok: false,
    receipt: record(config, request, decidedAt, { code, pid: null, screenshots: [], url: null }),
    refusal: previewRefusal(code),
  });

  if (!containedSegment(request.goalId) || !containedSegment(request.sha)) {
    return refuse("PREVIEW_GOAL_NOT_LANDED");
  }
  if (!readGoalLandingStatus(config.store, config.projectId, request.goalId).allLanded) {
    return refuse("PREVIEW_GOAL_NOT_LANDED");
  }

  const facts = config.contractFacts?.(request.goalId) ?? null;
  const scripts = (config.readScripts ?? workspaceScripts)(request.workspace);
  const resolved = resolvePreviewCommand(facts, scripts, (name) => `npm run ${name}`);
  if (isPreviewRefusal(resolved)) return refuse(resolved.code);

  const started = await startPreviewProcess(
    { command: resolved.plan.command, port: resolved.plan.port, workspace: request.workspace },
    config.process ?? {},
  );
  if (isPreviewRefusal(started)) return refuse(started.code);

  const { handle } = started;
  let screenshots: readonly PreviewScreenshot[] = [];
  try {
    screenshots = await (config.capture ?? capturePreviewJourneys)({
      directory: request.workspace,
      goalId: request.goalId,
      journeys: resolved.plan.journeys,
      origin: handle.origin,
      sha: request.sha,
      workspace: request.workspace,
    });
  } catch {
    // A capture that threw leaves a live server behind unless this path stops it too.
    await stopPreview(handle);
    return refuse("PREVIEW_START_TIMEOUT");
  }

  const receipt = record(config, request, decidedAt, {
    code: null, pid: handle.pid, screenshots, url: handle.origin,
  });
  if (receipt === null) {
    // Nothing durable says this preview exists, so nothing durable can be asked to stop it.
    await stopPreview(handle);
    return { ok: false, receipt: null, refusal: previewRefusal("PREVIEW_START_TIMEOUT") };
  }
  return { ok: true, started: { handle, receipt } };
}
