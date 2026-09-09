/**
 * THE PREVIEW RECEIPT, over HTTP: POST `/preview/read` answers, for one goal, the receipt
 * `readPreviewReceipt` already holds. It PROJECTS a durable fact and derives no authority —
 * `PreviewReceiptV1` already carries the url an operator clicks, the captures they look at,
 * the outcome and the refusal code, so anything this module computed instead of forwarded
 * would be a second opinion about a decision the runner already made.
 *
 * ABSENT IS NOT A REFUSAL, and the difference is the whole point of the envelope below. A goal
 * that has never been previewed answers `kind: "ABSENT"`; a goal whose committed receipt will
 * not decode answers `kind: "REFUSED"` with its code. A card that cannot tell those apart
 * renders an error for the ordinary case — "no preview yet" is not a fault.
 *
 * WHAT THE BROWSER IS NOT TOLD. `pid` is a host process id, `projectId` is the principal's own
 * and `version` is the store's business; none of the three is projected. Every screenshot
 * `path` is PROJECT-RELATIVE by the decoder's own construction (`parseScreenshots` refuses an
 * entry outside `.moe-next/previews/<goalId>/<sha>/`), so the response can carry no absolute
 * filesystem path — the capture route resolves those relative names against a root the browser
 * never sees.
 *
 * THE URL IS RE-JUDGED BEFORE IT IS SERVED, even though the runner wrote it. The consumer
 * renders it as a LINK, so a `javascript:` spelling would be script the operator clicks, and a
 * `http://user:pass@host` one would hand a credential to anything that logs a referrer. Both
 * REFUSE with `PREVIEW_READ_URL_UNSERVABLE` rather than being silently blanked: a card showing
 * no link is indistinguishable from a preview that never started.
 *
 * READ-ONLY. Nothing here writes, deletes, starts or stops anything.
 */
import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { CommandDecisionRecord, SqliteEventStore } from "@moe/store";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { decisionsOf } from "../decision-ledger-memo.js";
import { readPreviewReceipt } from "../preview/preview-ledger.js";
import {
  PREVIEW_RECEIPT_COMMAND_KIND, PREVIEW_RUNNER_PRINCIPAL_ID,
} from "../preview/preview-receipt-contracts.js";
import type { PreviewReceiptV1, PreviewScreenshot } from "../preview/preview-receipt-contracts.js";
import type { PreviewCode } from "../preview/preview-contracts.js";
import { authenticateHttpRequest } from "./http-command-ingress.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";

export const PREVIEW_READ_PATH = "/preview/read" as const;

/** Module-private, and deliberately named `LAYER` rather than `PREVIEW_READ_LAYER`: this is a
 *  route's own answer stamp, not a security-boundary constant, and the boundary roster's
 *  `[A-Z0-9_]+(?:LAYER|LAYERS|BOUNDARIES)` shape is reserved for the latter. Same spelling
 *  discipline as `design-read.ts` and `environments-read.ts`. */
const LAYER = "PREVIEW_READ" as const;

/** Every refusal this route can answer. Closed, so a consumer can switch exhaustively. */
export const PREVIEW_READ_CODES = Object.freeze([
  "PREVIEW_READ_CAPABILITY_DENIED",
  "PREVIEW_READ_RECEIPT_UNREADABLE",
  "PREVIEW_READ_URL_UNSERVABLE",
] as const);

export type PreviewReadCode = (typeof PREVIEW_READ_CODES)[number];

/** The one page of the decision ledger this reader walks, matching the affordance reader's. */
const RECEIPT_LEDGER_PAGE_SIZE = 512;

/** EXACTLY what a preview card is told. `pid`, `projectId` and `version` are withheld. */
export interface PreviewProjection {
  readonly code: PreviewCode | null;
  readonly decidedAt: string;
  readonly goalId: string;
  readonly outcome: PreviewReceiptV1["outcome"];
  /** The `previewRef` a later `preview.decide` names. Not a secret: it is a public digest. */
  readonly receiptId: string;
  /** Project-relative paths under `.moe-next/previews/<goalId>/<sha>/`, never host paths. */
  readonly screenshots: readonly PreviewScreenshot[];
  readonly sha: string;
  readonly url: string | null;
}

export type PreviewReadAnswer =
  | Readonly<{ readonly goalId: string; readonly kind: "ABSENT" }>
  | Readonly<{ readonly kind: "PRESENT"; readonly preview: PreviewProjection }>
  | Readonly<{
    readonly code: PreviewReadCode;
    readonly kind: "REFUSED";
    readonly layer: typeof LAYER;
  }>;

export interface PreviewReadInput {
  readonly goalId: string;
  readonly projectId: string;
}

/** Closed over a store by tests and by the composition sibling; this module opens none. */
export interface PreviewReadPort {
  read(input: PreviewReadInput): PreviewReadAnswer;
}

const refused = (code: PreviewReadCode): PreviewReadAnswer =>
  Object.freeze({ code, kind: "REFUSED" as const, layer: LAYER });

/**
 * A url an operator may be handed as a link. `javascript:`/`data:` are script delivery and
 * embedded userinfo is a credential the browser would forward; neither is servable, and the
 * runner writing one is a fault worth naming rather than hiding behind a blank field.
 */
export function previewUrlIsServable(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:")
    && parsed.username === "" && parsed.password === "";
}

/** Named members only: a key the receipt grows later cannot leak through this projection. */
function projectionOf(receipt: PreviewReceiptV1): PreviewProjection {
  return Object.freeze({
    code: receipt.code,
    decidedAt: receipt.decidedAt,
    goalId: receipt.goalId,
    outcome: receipt.outcome,
    receiptId: receipt.receiptId,
    screenshots: receipt.screenshots,
    sha: receipt.sha,
    url: receipt.url,
  });
}

/**
 * THE PRODUCTION READ, keyed by goal. `readPreviewReceipt` takes a RECEIPT ID and the id is a
 * digest of (projectId, goalId, sha), so a goal-keyed read needs the runner's own committed
 * receipts as its index — the same walk `createPreviewReceiptReader` makes for the affordance
 * surface, and for the same reason: the decision is re-READ through `readPreviewReceipt`, never
 * decoded here, so a record written under another principal, kind or project can never be
 * answered as this goal's preview. A later receipt wins, so the answer follows the newest
 * revision. An unreadable one REFUSES the whole read rather than degrading to ABSENT: "there is
 * no preview" and "the preview cannot be read" are different facts to an operator.
 */
export function readPreviewForGoal(
  store: SqliteEventStore, input: PreviewReadInput,
): PreviewReadAnswer {
  let latest: PreviewReceiptV1 | null = null;
  let decisions: readonly CommandDecisionRecord[];
  try {
    decisions = decisionsOf(store, RECEIPT_LEDGER_PAGE_SIZE);
  } catch {
    return refused("PREVIEW_READ_RECEIPT_UNREADABLE");
  }
  for (const decision of decisions) {
    if (decision.commandKind !== PREVIEW_RECEIPT_COMMAND_KIND
      || decision.effectDisposition !== "EFFECTS_COMMITTED"
      || decision.key.projectId !== input.projectId
      || decision.key.principalId !== PREVIEW_RUNNER_PRINCIPAL_ID) continue;
    const read = readPreviewReceipt(store, input.projectId, decision.key.commandId);
    if (!read.ok) {
      if (read.code === "PREVIEW_RECEIPT_INVALID") return refused("PREVIEW_READ_RECEIPT_UNREADABLE");
      continue;
    }
    if (read.receipt.goalId === input.goalId) latest = read.receipt;
  }
  if (latest === null) return Object.freeze({ goalId: input.goalId, kind: "ABSENT" as const });
  if (latest.url !== null && !previewUrlIsServable(latest.url)) {
    return refused("PREVIEW_READ_URL_UNSERVABLE");
  }
  return Object.freeze({ kind: "PRESENT" as const, preview: projectionOf(latest) });
}

/** The port the listener is composed with. One statement of the read, shared by both callers. */
export function createPreviewReadPort(store: SqliteEventStore): PreviewReadPort {
  return Object.freeze({
    read: (input: PreviewReadInput): PreviewReadAnswer => readPreviewForGoal(store, input),
  });
}

/**
 * Own enumerable keys are EXACTLY `{goalId}`. A body naming a projectId is an unknown key, not
 * an override: the project comes from the authenticated principal and never from the wire.
 */
export function previewReadBodyOf(body: unknown): { readonly goalId: string } | null {
  const decoded = decodeBoundedJsonBytes(body);
  if (!decoded.ok) return null;
  const value: unknown = decoded.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "goalId") return null;
  const goalId = record["goalId"];
  return typeof goalId === "string" && goalId.length > 0 ? { goalId } : null;
}

export type PreviewReadDispatch =
  | {
    readonly body: PreviewReadAnswer | HttpPortRefused | HttpRefused;
    readonly httpStatus: number;
    readonly kind: "REPLY";
  }
  | {
    readonly code: "LISTENER_PREVIEW_REQUEST_INVALID" | "LISTENER_PREVIEW_UNAVAILABLE";
    readonly kind: "LISTENER_REFUSAL";
  };

export function handlePreviewReadRequest(
  dependencies: {
    readonly authenticator: Authenticator;
    readonly previewReads?: PreviewReadPort | undefined;
  },
  request: {
    readonly body: unknown;
    readonly credential: string | null;
    readonly protocolVersion: unknown;
  },
): PreviewReadDispatch {
  const access = authenticateHttpRequest(
    dependencies.authenticator, request.credential, request.protocolVersion,
  );
  if (!access.ok) {
    return Object.freeze({ body: access, httpStatus: access.httpStatus, kind: "REPLY" });
  }
  if (!access.principal.capabilities.includes(CAPABILITIES.GOAL)) {
    return Object.freeze({
      body: refused("PREVIEW_READ_CAPABILITY_DENIED"), httpStatus: 200, kind: "REPLY",
    });
  }
  const port = dependencies.previewReads;
  if (port === undefined) {
    return Object.freeze({ code: "LISTENER_PREVIEW_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
  }
  const decoded = previewReadBodyOf(request.body);
  if (decoded === null) {
    return Object.freeze({ code: "LISTENER_PREVIEW_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
  }
  return Object.freeze({
    body: port.read({ goalId: decoded.goalId, projectId: access.principal.projectId }),
    httpStatus: 200,
    kind: "REPLY",
  });
}
