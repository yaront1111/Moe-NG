/**
 * THE PREVIEW RECEIPT, read by the browser: POST /preview/read with EXACTLY `{goalId}` and
 * shape what the daemon says - verbatim - into PREVIEW / ABSENT / REFUSED / ERROR. READS ONLY.
 *
 * ABSENT IS NOT AN ERROR, and keeping the two apart is the whole reason this module has four
 * outcomes instead of three. A goal that has never been previewed answers `kind: "ABSENT"`,
 * and the card is simply not there; a goal whose read FAILED answers REFUSED or ERROR, and
 * the operator is owed a sentence about it. A reader that collapsed them would make "no
 * preview yet" - the ordinary case - render as a fault.
 *
 * THE SHAPE IS THE DAEMON'S (preview-read.ts `PreviewProjection`), decoded with EXACT-KEY
 * snapshots at every level. `pid`, `projectId` and `version` are withheld by the route on
 * purpose, so admitting them here would accept a frame the daemon never sends. An unknown key
 * REFUSES rather than being ignored: that is what stops the daemon widening the projection
 * later without the browser noticing.
 *
 * THE SCREENSHOT URL IS DERIVED, NEVER INTERPOLATED. Every served `path` is project-relative
 * under `.moe-next/previews/<goalId>/<sha>/` by the receipt decoder's own construction, and
 * the capture route serves exactly `<goalId>/<sha>/<file>`. `previewCaptureUrl` re-checks that
 * containment client-side and percent-encodes each segment, so the browser cannot hand the
 * route something that looks like an escape attempt even if a receipt were ever written badly.
 */

const LIVE_PREVIEW_LAYER = "CONTROL_ROOM_LIVE_PREVIEW";
const INVALID_RESPONSE_CODE = "PREVIEW_RESPONSE_INVALID";
const TRANSPORT_FAILED_CODE = "TRANSPORT_REQUEST_FAILED";
const REQUEST_TIMEOUT_MS = 15_000;

export const PREVIEW_READ_PATH = "/preview/read";
export const PREVIEW_CAPTURE_PATH = "/preview/capture";
/** The one statement of the layout, matching `previewCaptureDirectory` in the daemon. */
const PREVIEWS_ROOT = ".moe-next/previews";

/** The two outcomes the receipt decoder allows; STARTED always carries a url, REFUSED never. */
export const PREVIEW_OUTCOMES = ["REFUSED", "STARTED"] as const;
export type PreviewReceiptOutcome = (typeof PREVIEW_OUTCOMES)[number];

export interface PreviewScreenshotView {
  readonly journeyRef: string;
  /** Project-relative, always under `.moe-next/previews/<goalId>/<sha>/`. */
  readonly path: string;
}

/** EXACTLY what `/preview/read` projects - eight keys, no host process id and no version. */
export interface PreviewReceiptView {
  readonly code: string | null;
  readonly decidedAt: string;
  readonly goalId: string;
  readonly outcome: PreviewReceiptOutcome;
  /** The `previewRef` a later `preview.decide` names. */
  readonly receiptId: string;
  readonly screenshots: readonly PreviewScreenshotView[];
  readonly sha: string;
  readonly url: string | null;
}

export type PreviewReadOutcome =
  | { readonly status: "PREVIEW"; readonly preview: PreviewReceiptView }
  | { readonly status: "ABSENT"; readonly goalId: string }
  | { readonly status: "REFUSED" | "ERROR"; readonly code: string; readonly layer: string };

const PROJECTION_KEYS = Object.freeze([
  "code", "decidedAt", "goalId", "outcome", "receiptId", "screenshots", "sha", "url",
]);
const SCREENSHOT_KEYS = Object.freeze(["journeyRef", "path"]);

const refused = (code: string, layer: string): PreviewReadOutcome =>
  Object.freeze({ code, layer, status: "REFUSED" as const });
const invalidResponse = (): PreviewReadOutcome =>
  Object.freeze({ code: INVALID_RESPONSE_CODE, layer: LIVE_PREVIEW_LAYER, status: "ERROR" as const });

const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes(String.fromCharCode(0));
const nullableText = (value: unknown): value is string | null =>
  value === null || text(value);

/** An own-enumerable EXACT-key snapshot; never invokes a getter, never admits an inherited key. */
function exactDataRecord(
  value: unknown, expected: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length
    || keys.some((key) => typeof key !== "string" || !expected.includes(key))) return null;
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    copy[key] = descriptor.value;
  }
  return Object.freeze(copy);
}

/** The three refusal frames this route can put on the wire: listener, authenticate, port. */
function refusalFrom(response: unknown): PreviewReadOutcome | null {
  const listener = exactDataRecord(response, ["code", "layer"]);
  if (listener !== null && text(listener["code"]) && text(listener["layer"])) {
    return refused(listener["code"], listener["layer"]);
  }
  const port = exactDataRecord(response, ["httpStatus", "ok", "outcome", "refusal", "stage"]);
  if (port !== null && port["ok"] === false && port["outcome"] === "PORT_REFUSED"
    && text(port["stage"])) {
    const refusal = exactDataRecord(port["refusal"], ["code"])
      ?? exactDataRecord(port["refusal"], ["code", "detail"])
      ?? exactDataRecord(port["refusal"], ["code", "layer"]);
    if (refusal !== null && text(refusal["code"])) return refused(refusal["code"], port["stage"]);
    return null;
  }
  const http = exactDataRecord(response, ["error", "httpStatus", "ok", "outcome", "stage"]);
  if (http === null || http["ok"] !== false || http["outcome"] !== "REFUSED"
    || !text(http["stage"])) return null;
  const error = exactDataRecord(http["error"], ["code"])
    ?? exactDataRecord(http["error"], ["code", "detail"])
    ?? exactDataRecord(http["error"], ["code", "layer"]);
  return error !== null && text(error["code"]) ? refused(error["code"], http["stage"]) : null;
}

function screenshotOf(value: unknown): PreviewScreenshotView | null {
  const record = exactDataRecord(value, SCREENSHOT_KEYS);
  if (record === null || !text(record["journeyRef"]) || !text(record["path"])) return null;
  return Object.freeze({ journeyRef: record["journeyRef"], path: record["path"] });
}

function screenshotsOf(value: unknown): readonly PreviewScreenshotView[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  if (Reflect.ownKeys(value).length !== value.length + 1) return null;
  const shots: PreviewScreenshotView[] = [];
  for (const entry of value) {
    const shot = screenshotOf(entry);
    if (shot === null) return null;
    shots.push(shot);
  }
  return Object.freeze(shots);
}

function projectionOf(value: unknown): PreviewReceiptView | null {
  const record = exactDataRecord(value, PROJECTION_KEYS);
  if (record === null || !nullableText(record["code"]) || !text(record["decidedAt"])
    || !text(record["goalId"]) || !text(record["receiptId"]) || !text(record["sha"])
    || !nullableText(record["url"])
    || !(PREVIEW_OUTCOMES as readonly unknown[]).includes(record["outcome"])) return null;
  const screenshots = screenshotsOf(record["screenshots"]);
  if (screenshots === null) return null;
  return Object.freeze({
    code: record["code"], decidedAt: record["decidedAt"], goalId: record["goalId"],
    outcome: record["outcome"] as PreviewReceiptOutcome, receiptId: record["receiptId"],
    screenshots, sha: record["sha"], url: record["url"],
  });
}

/** Maps only an exact daemon preview frame; every other answer is REFUSED or ERROR. PURE. */
export function mapPreviewAnswer(status: number, response: unknown): PreviewReadOutcome {
  const refusal = refusalFrom(response);
  if (refusal !== null) return refusal;
  if (status !== 200) return invalidResponse();

  const route = exactDataRecord(response, ["code", "kind", "layer"]);
  if (route !== null && route["kind"] === "REFUSED" && text(route["code"]) && text(route["layer"])) {
    return refused(route["code"], route["layer"]);
  }
  const gone = exactDataRecord(response, ["goalId", "kind"]);
  if (gone !== null && gone["kind"] === "ABSENT" && text(gone["goalId"])) {
    return Object.freeze({ goalId: gone["goalId"], status: "ABSENT" as const });
  }
  const here = exactDataRecord(response, ["kind", "preview"]);
  if (here === null || here["kind"] !== "PRESENT") return invalidResponse();
  const preview = projectionOf(here["preview"]);
  return preview === null
    ? invalidResponse()
    : Object.freeze({ preview, status: "PREVIEW" as const });
}

/**
 * The capture route path for ONE screenshot of ONE receipt, or `null` when the served path is
 * not inside that receipt's own previews directory. The daemon confines the route server-side;
 * this check exists so a browser never REQUESTS an escape, and so a receipt written by a future
 * runner with a different layout fails visibly here rather than 404-ing at the route.
 */
export function previewCaptureUrl(
  preview: Pick<PreviewReceiptView, "goalId" | "sha">, screenshot: PreviewScreenshotView,
): string | null {
  const prefix = `${PREVIEWS_ROOT}/${preview.goalId}/${preview.sha}/`;
  if (!screenshot.path.startsWith(prefix)) return null;
  const file = screenshot.path.slice(prefix.length);
  if (file === "" || file.includes("/") || file.includes("\\") || file.includes("..")) return null;
  const segments = [preview.goalId, preview.sha, file].map((part) => encodeURIComponent(part));
  return `${PREVIEW_CAPTURE_PATH}/${segments.join("/")}`;
}

/** POSTs exactly `{goalId}` and maps the reply; `post` is injectable for tests. */
export async function readPreview(
  goalId: string,
  headers: Readonly<Record<string, string>>,
  post?: (body: string) => Promise<Response>,
): Promise<PreviewReadOutcome> {
  const send = post ?? ((body: string): Promise<Response> => fetch(PREVIEW_READ_PATH, {
    body, headers, method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  let response: Response;
  try {
    response = await send(JSON.stringify({ goalId }));
  } catch {
    return Object.freeze({
      code: TRANSPORT_FAILED_CODE, layer: LIVE_PREVIEW_LAYER, status: "ERROR" as const,
    });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return invalidResponse();
  }
  return mapPreviewAnswer(response.status, body);
}
