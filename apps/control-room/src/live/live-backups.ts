/**
 * THE BACKUPS READ CLIENT: POST `/backups/read` with an EXACTLY-EMPTY body, shaped verbatim into
 * a list of backups or a refusal at its own layer. READ ONLY, exact-key snapshots at every
 * level (the discipline of live-deployments-health.ts).
 *
 * IT DERIVES NOTHING, AND `restoreProof` IS THE REASON THIS MATTERS. The daemon answers one of
 * PROVEN, FAILED or NOT_CHECKED per backup, computed from the durable restore-proof record on
 * the serving side, and this client copies it across untouched. There is no default, no `??`
 * and no fallback below: a value this module cannot read refuses the whole frame rather than
 * becoming a plausible one. NOT_CHECKED is a real and common state - writing a backup is cheap
 * and restore-checking one is not - and rendering it as PROVEN is the single failure this whole
 * surface exists to prevent, so it is never manufactured here.
 *
 * ABSENT IS NULL AND ONLY NULL. `sha256` and `checkedAt` are null EXACTLY when the daemon holds
 * no digest and no instant. An empty string or a zero is NOT admitted as "absent": it refuses,
 * because a consumer that accepted `""` could not tell a backup with no proof from one whose
 * digest failed to travel.
 *
 * EXACT-KEY MEANS REFUSED, NOT IGNORED. A frame carrying a key this client does not expect - or
 * missing one it does - is rejected rather than silently narrowed, which is what makes a
 * daemon-side shape change red this client's tests instead of reaching production as a blank
 * where a restore-proof state used to be.
 */

const LAYER = "CONTROL_ROOM_BACKUPS";
const INVALID_RESPONSE_CODE = "BACKUPS_RESPONSE_INVALID";
const TRANSPORT_FAILED_CODE = "TRANSPORT_REQUEST_FAILED";
const REQUEST_TIMEOUT_MS = 15_000;

export const BACKUPS_READ_PATH = "/backups/read";

/** The DAEMON's own verdict per backup. This client never computes a member of this union. */
export type BackupRestoreProof = "FAILED" | "NOT_CHECKED" | "PROVEN";

/**
 * One backup, as an operator reads it. `ref` is the artifact BASENAME the daemon serves and
 * never the directory it lives in; the serving side refuses to carry anything else, and this
 * client adds no path of its own (epic rail 3).
 */
export interface BackupView {
  /** When the restore-proof state was last determined, or null when it never was. */
  readonly checkedAt: string | null;
  readonly environment: string;
  readonly ref: string;
  readonly restoreProof: BackupRestoreProof;
  /** The verified digest, or null. Never "" and never 0 - see the module note. */
  readonly sha256: string | null;
}

export interface BackupsFrameView {
  readonly backups: readonly BackupView[];
  readonly status: "BACKUPS";
}

export type BackupsOutcome =
  | BackupsFrameView
  | { readonly status: "ERROR"; readonly code: string; readonly layer: string }
  | { readonly status: "REFUSED"; readonly code: string; readonly layer: string };

type Failure = { readonly status: "ERROR"; readonly code: string; readonly layer: string };
type Refusal = { readonly status: "REFUSED"; readonly code: string; readonly layer: string };

const refused = (code: string, layer: string): Refusal =>
  Object.freeze({ code, layer, status: "REFUSED" as const });
const errored = (code: string, layer: string): Failure =>
  Object.freeze({ code, layer, status: "ERROR" as const });
/**
 * ONE invalid-response code for every malformation. An extra key and a missing key are the same
 * mistake from this client's side - the frame is not the shape it was promised - and minting a
 * per-shape code would be a second vocabulary the daemon does not share. What distinguishes the
 * two cases is not the code but the OUTCOME: both fail CLOSED, and neither leaves a partial
 * frame or a single decoded backup behind. The tests assert that, not the code twice.
 */
const invalidResponse = (): Failure => errored(INVALID_RESPONSE_CODE, LAYER);

/** An own-enumerable EXACT-key snapshot (copied verbatim from live-deployments-health.ts). */
function exactDataRecord(
  value: unknown, expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) return null;
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
/**
 * ABSENT OR PRESENT, never "present but empty". `""` is refused rather than read as null: the
 * daemon writes null for absent and a real digest otherwise, so an empty string is a frame this
 * client cannot account for, and quietly folding it into "absent" is how a digest that failed to
 * travel would render identically to one that was never taken.
 */
const nullableText = (value: unknown): value is string | null => value === null || text(value);

/**
 * The most backups this client will accept in one frame. The daemon evicts to 200 per
 * environment and refuses its own read past 20000 rows, so anything longer than that guard
 * cannot be a real answer. This is a crash guard, not a copy of the daemon's policy: the list
 * renders one element per row and an unbounded array is a render that never returns.
 */
const MAX_BACKUPS = 20_000;

/**
 * The three refusal envelopes this route can answer with, each verified at its mint site:
 * `{code, layer}` is the listener's (`refuseRequest`, carrying LISTENER_BACKUPS_*),
 * `{code, layer, outcome}` is the route's own (BACKUPS_READ_*), and `{code, layer, ok:false}` is
 * the restore-proof STORE's, which travels verbatim with its own DAEMON_INGRESS layer. Omitting
 * the third is how a store refusal would arrive as a generic invalid response with its cause
 * erased, and an operator would be told the frame was malformed when the record was unreadable.
 *
 * The authenticator's own refusals are five-key and are deliberately NOT matched here, exactly
 * as in live-deployments-health.ts: they carry a nested RuntimeError rather than a code and a
 * layer, and admitting them would mean decoding a second shape family for no gain.
 */
function refusalFrom(response: unknown): Refusal | null {
  const listener = exactDataRecord(response, ["code", "layer"]);
  if (listener !== null && text(listener.code) && text(listener.layer)) {
    return refused(listener.code, listener.layer);
  }
  const route = exactDataRecord(response, ["code", "layer", "outcome"]);
  if (route !== null && route.outcome === "REFUSED" && text(route.code) && text(route.layer)) {
    return refused(route.code, route.layer);
  }
  const store = exactDataRecord(response, ["code", "layer", "ok"]);
  if (store !== null && store.ok === false && text(store.code) && text(store.layer)) {
    return refused(store.code, store.layer);
  }
  return null;
}

/**
 * ONE BACKUP ROW. Null means UNREADABLE ONLY - there is no such thing as an absent element of
 * an array - so the caller refuses the WHOLE frame on a null rather than dropping the row.
 * Skipping a malformed row silently would shorten the list without saying so, and a shorter
 * list reads as "these are all the backups", which is the same class of lie as a false PROVEN.
 *
 * The absent-versus-malformed distinction lives one level down, on `sha256` and `checkedAt`:
 * `nullableText` admits null and refuses `""`, so an unreadable digest can never arrive here
 * wearing the shape of an absent one.
 */
function backupOf(value: unknown): BackupView | null {
  const row = exactDataRecord(value, [
    "checkedAt", "environment", "ref", "restoreProof", "sha256",
  ]);
  if (row === null || !text(row.environment) || !text(row.ref)) return null;
  if (!nullableText(row.checkedAt) || !nullableText(row.sha256)) return null;
  if (row.restoreProof !== "FAILED" && row.restoreProof !== "NOT_CHECKED"
    && row.restoreProof !== "PROVEN") return null;
  return Object.freeze({
    checkedAt: row.checkedAt,
    environment: row.environment,
    ref: row.ref,
    restoreProof: row.restoreProof,
    sha256: row.sha256,
  });
}

/**
 * A MALFORMED FRAME YIELDS NO BACKUPS AT ALL. Every exit below returns `invalidResponse()`,
 * whose value is built from module constants and carries nothing off the wire, so a decode that
 * fails leaks neither a partial list nor any bytes the caller sent (epic rail 3).
 */
export function mapBackupsAnswer(status: number, body: unknown): BackupsOutcome {
  const refusal = refusalFrom(body);
  if (refusal !== null) return refusal;
  const row = exactDataRecord(body, ["backups", "ok"]);
  if (status !== 200 || row === null || row.ok !== true) return invalidResponse();
  if (!Array.isArray(row.backups) || row.backups.length > MAX_BACKUPS) return invalidResponse();
  const backups: BackupView[] = [];
  for (const raw of row.backups as readonly unknown[]) {
    const backup = backupOf(raw);
    if (backup === null) return invalidResponse();
    backups.push(backup);
  }
  return Object.freeze({ backups: Object.freeze(backups), status: "BACKUPS" as const });
}

/**
 * POSTs an EXACTLY-EMPTY object to the backups read; `send` is injectable for tests. The body
 * carries no filter on purpose: the route serves the authenticated principal's project and
 * refuses any own key, so a filter added here would be refused rather than honoured.
 */
export async function readBackups(
  headers: Readonly<Record<string, string>>,
  send?: (body: string) => Promise<Response>,
): Promise<BackupsOutcome> {
  const payload = JSON.stringify({});
  const doSend = send ?? ((body: string): Promise<Response> => fetch(BACKUPS_READ_PATH, {
    body, headers, method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  let response: Response;
  try {
    response = await doSend(payload);
  } catch {
    return errored(TRANSPORT_FAILED_CODE, LAYER);
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return invalidResponse();
  }
  return mapBackupsAnswer(response.status, parsed);
}
