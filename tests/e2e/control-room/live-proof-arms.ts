/**
 * The arms `live-proof-prd.spec.ts` drives the epic-final live proof with.
 *
 * SPLIT OUT FOR THE FILE CAP, not for reuse: the drive is one long journey and the project rail
 * caps a source file at 400 physical lines, so the reusable halves live here and the spec keeps
 * only the narrative. Nothing here decides anything -- every function either asks the daemon a
 * question or performs one operator/browser act and hands back what the daemon said.
 *
 * EVERY READ GOES TO THE DAEMON, NEVER TO A CARD. The whole point of this row's DoD 1 is that
 * the transcript quotes measurements; a helper that reported what the UI believed would make
 * each of them unfalsifiable.
 */
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { readWireProtocolVersion } from "./daemon-ports.js";
import type { DaemonLane } from "./daemon-ports.js";

const PAIRING_BUDGET_MS = 90_000;
const PAIRING_LABEL = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u;

export const sleep = (ms: number): Promise<void> =>
  new Promise((done) => { setTimeout(done, ms); });

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * One transcript line per artefact.
 *
 * The row comment is assembled from these lines verbatim, so the format is load-bearing: a
 * stable prefix makes the whole transcript greppable out of a Playwright run, and JSON keeps
 * the daemon's own words intact instead of paraphrasing them into prose.
 */
export const record = (label: string, value: unknown): void => {
  console.info(`[live-proof] ${label} ${JSON.stringify(value)}`);
};

export interface Answer {
  readonly body: unknown;
  readonly status: number;
  readonly text: string;
}

/**
 * Asks the daemon on a NAMED credential.
 *
 * The credential is a parameter and not a default because this drive deliberately dispatches on
 * two different seats -- the configured operator, and a durable HUMAN standing in for the paired
 * browser -- and the difference between their answers is the measurement in
 * `live-proof-prd.spec.ts`'s boundary arm. A helper that silently used one of them would make
 * that arm vacuous.
 */
export async function ask(
  lane: DaemonLane, path: string, body: unknown, credential: string,
): Promise<Answer> {
  const protocolVersion = await readWireProtocolVersion(lane.repoRoot);
  const response = await fetch(`${lane.baseUrl}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-moe-csrf": lane.csrfToken,
      "x-moe-protocol-version": protocolVersion ?? "",
      "x-moe-session-credential": credential,
    },
    method: "POST",
  });
  const text = await response.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { body: parsed, status: response.status, text };
}

/** The same question on the lane's CONFIGURED OPERATOR wire. */
export const askDaemon = (lane: DaemonLane, path: string, body: unknown): Promise<Answer> =>
  ask(lane, path, body, lane.credential);

/**
 * The operator's real pairing ritual, transcribed from `activation-fresh-project.spec.ts:53-69`.
 *
 * The label is READ OFF THE PAGE and written to the daemon's operator stdin, which is the same
 * path a person's keystroke takes. Nothing here approves on the daemon's behalf.
 */
export async function pairBrowser(page: Page, lane: DaemonLane): Promise<void> {
  const approve = lane.approvePairing;
  expect(approve, "the lane must expose an operator channel").not.toBeNull();
  const output = page.getByLabel("Pairing confirmation label");
  await expect(output).toBeVisible({ timeout: 30_000 });
  const label = (await output.textContent())?.trim() ?? "";
  expect(label, "the browser must be shown a real label").toMatch(PAIRING_LABEL);
  approve?.(label);
  const confirm = page.getByRole("button", { name: "I entered this label" });
  const deadline = Date.now() + PAIRING_BUDGET_MS;
  while (Date.now() < deadline) {
    if (await output.count() === 0) return;
    await confirm.click({ timeout: 5_000 }).catch(() => undefined);
    await sleep(1_000);
  }
  await expect(output, "the pairing card must close").toHaveCount(0, { timeout: 10_000 });
}

/** Every COMMITTED decision kind the daemon reports on its own affordance surface. */
export function committedKinds(surface: unknown): readonly string[] {
  if (!isRecord(surface) || !Array.isArray(surface["steps"])) return [];
  return (surface["steps"] as readonly unknown[])
    .filter((step): step is Readonly<Record<string, unknown>> =>
      isRecord(step) && step["status"] === "COMMITTED")
    .map((step) => String(step["kind"]));
}

/** Every kind the daemon currently OFFERS, deduplicated and sorted for a stable transcript. */
export function offeredKinds(surface: unknown): readonly string[] {
  const offers = isRecord(surface) && Array.isArray(surface["nextAllowedCommands"])
    ? surface["nextAllowedCommands"] as readonly unknown[] : [];
  return [...new Set(offers.filter(isRecord).map((row) => String(row["commandKind"])))].sort();
}

/**
 * The daemon's OWN offer for a kind.
 *
 * Every dispatch in this drive spends an offer the daemon minted rather than a command id the
 * spec spelled, so no arm can pass by asserting bytes it authored itself.
 */
export function offerFor(
  surface: unknown, kind: string, target?: string,
): Readonly<Record<string, unknown>> | null {
  const offers = isRecord(surface) && Array.isArray(surface["nextAllowedCommands"])
    ? surface["nextAllowedCommands"] as readonly unknown[] : [];
  const found = offers.find((row) => isRecord(row) && row["commandKind"] === kind
    && (target === undefined || row["targetAggregateId"] === target));
  return isRecord(found) ? found : null;
}

/** A dispatch envelope on the operator wire, with the offer's own ids. */
export function envelope(
  offer: Readonly<Record<string, unknown>>, kind: string, correlationId: string,
  payload: unknown, digest: string, credential: string,
): Readonly<Record<string, unknown>> {
  return {
    commandId: offer["commandId"], commandKind: kind, correlationId,
    expectedVersion: offer["expectedVersion"], payload,
    requestDigest: digest.repeat(64).slice(0, 64),
    schemaVersion: "moe-runtime-command/1",
    sessionCredential: credential, targetAggregateId: offer["targetAggregateId"],
  };
}
