/**
 * THE SIX ACTIVATION RECEIPTS, as the browser reads them: POST /activation/read with EXACTLY
 * `{}`, shaped verbatim into ACTIVATION / REFUSED / ERROR. READS ONLY; exact-key snapshots at
 * every level, the same discipline as live-repository-remote.ts.
 *
 * The daemon measures; this module only decodes. `reason` is carried through UNTOUCHED — the
 * route already scrubs credential values out of it (activation-read.ts, `secretValues`), and
 * paraphrasing here would hide which receipt is missing and why. `signing` is decoded as its
 * OWN shape, never as a seventh member: it carries `trustBoundary: false` and no card may
 * count it as a measured receipt.
 */

const LIVE_ACTIVATION_LAYER = "CONTROL_ROOM_LIVE_ACTIVATION";
const INVALID_RESPONSE_CODE = "ACTIVATION_RESPONSE_INVALID";
const TRANSPORT_FAILED_CODE = "TRANSPORT_REQUEST_FAILED";
const ACTIVATION_READ_PATH = "/activation/read";
const REQUEST_TIMEOUT_MS = 15_000;

/** The six the daemon measures, in card order (apps/daemon/src/bootstrap/activation-receipts.ts). */
export const ACTIVATION_MEMBERS = Object.freeze([
  "repository", "provider", "store", "backup", "distribution", "policy",
] as const);
export type ActivationMember = (typeof ACTIVATION_MEMBERS)[number];

/** The nine keys the daemon's ActivationView carries. */
export const ACTIVATION_FRAME_KEYS = [
  "blocking", "distribution", "measuredAt", "members", "outcome", "repository",
  "schemaVersion", "signing", "store",
] as const;
const RECEIPT_KEYS = ["code", "hash", "layer", "measured", "member", "reason", "ref"] as const;
const SIGNING_KEYS = ["measured", "member", "reason", "ref", "trustBoundary"] as const;

export interface ActivationReceiptView {
  /** The stable refusal code, or null when the member is measured. */
  readonly code: string | null;
  readonly hash: string | null;
  /** The boundary that answered, or null when the member is measured. */
  readonly layer: string | null;
  readonly measured: boolean;
  readonly member: ActivationMember;
  /** The daemon's own words. Rendered verbatim, as TEXT, never as markup. */
  readonly reason: string;
  readonly ref: string | null;
}

/** Required by core's roster, NOT a trust boundary in this release (owner decision 2026-09-04). */
export interface ActivationSigningView {
  readonly measured: false;
  readonly member: "signing";
  readonly reason: string;
  readonly ref: string;
  readonly trustBoundary: false;
}

export interface ActivationDistributionView { readonly kind: string; readonly root: string }
export interface ActivationRepositoryView { readonly headSha: string; readonly toplevel: string }

export type ActivationReadOutcome =
  | {
    readonly status: "ACTIVATION";
    /** Members a READ can see are missing. `backup` is never here: it is deferred, not absent. */
    readonly blocking: readonly ActivationMember[];
    readonly distribution: ActivationDistributionView | null;
    readonly measuredAt: string;
    readonly members: readonly ActivationReceiptView[];
    readonly repository: ActivationRepositoryView | null;
    readonly schemaVersion: string;
    readonly signing: ActivationSigningView;
    readonly store: { readonly storePath: string } | null;
  }
  | { readonly status: "REFUSED"; readonly code: string; readonly layer: string }
  | { readonly status: "ERROR"; readonly code: string; readonly layer: string };

const refused = (code: string, layer: string): ActivationReadOutcome =>
  Object.freeze({ code, layer, status: "REFUSED" as const });
const errored = (code: string, layer: string): ActivationReadOutcome =>
  Object.freeze({ code, layer, status: "ERROR" as const });
const invalidResponse = (): ActivationReadOutcome => errored(INVALID_RESPONSE_CODE, LIVE_ACTIVATION_LAYER);

/** An own-enumerable EXACT-key snapshot (copied verbatim from live-repository-remote.ts). */
function exactDataRecord(value: unknown, expectedKeys: readonly string[]): Readonly<Record<string, unknown>> | null {
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

function refusalFrom(response: unknown): ActivationReadOutcome | null {
  const listener = exactDataRecord(response, ["code", "layer"]);
  if (listener !== null && typeof listener.code === "string" && typeof listener.layer === "string") {
    return refused(listener.code, listener.layer);
  }
  const route = exactDataRecord(response, ["code", "layer", "outcome"]);
  if (route !== null && route.outcome === "REFUSED" && typeof route.code === "string" && typeof route.layer === "string") {
    return refused(route.code, route.layer);
  }
  const port = exactDataRecord(response, ["httpStatus", "ok", "outcome", "refusal", "stage"]);
  if (port !== null && port.ok === false && port.outcome === "PORT_REFUSED" && typeof port.stage === "string") {
    const portCode = typeof port.refusal === "object" && port.refusal !== null
      ? Object.getOwnPropertyDescriptor(port.refusal, "code") : undefined;
    if (portCode !== undefined && "value" in portCode && typeof portCode.value === "string") {
      return refused(portCode.value, port.stage);
    }
  }
  const http = exactDataRecord(response, ["error", "httpStatus", "ok", "outcome", "stage"]);
  if (http === null || http.ok !== false || http.outcome !== "REFUSED" || typeof http.stage !== "string") return null;
  const runtimeError = typeof http.error === "object" && http.error !== null
    ? Object.getOwnPropertyDescriptor(http.error, "code") : undefined;
  return runtimeError !== undefined && "value" in runtimeError && typeof runtimeError.value === "string"
    ? refused(runtimeError.value, http.stage) : null;
}

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const nullableNonEmpty = (value: unknown): value is string | null => value === null || nonEmptyString(value);
const isMember = (value: unknown): value is ActivationMember =>
  typeof value === "string" && (ACTIVATION_MEMBERS as readonly string[]).includes(value);

/**
 * One receipt. A MEASURED row must carry no code and no layer, and an UNMEASURED row must
 * carry both: a frame that claimed a measurement while naming the boundary that refused it is
 * malformed, and defaulting either half would let a missing receipt render as measured.
 */
function receiptOf(value: unknown): ActivationReceiptView | null {
  const record = exactDataRecord(value, RECEIPT_KEYS);
  if (record === null || typeof record.measured !== "boolean" || !isMember(record.member)
    || typeof record.reason !== "string" || !nullableNonEmpty(record.hash)
    || !nullableNonEmpty(record.ref)) return null;
  if (record.measured) {
    if (record.code !== null || record.layer !== null) return null;
  } else if (!nonEmptyString(record.code) || !nonEmptyString(record.layer)) return null;
  return Object.freeze({
    code: record.code as string | null, hash: record.hash, layer: record.layer as string | null,
    measured: record.measured, member: record.member, reason: record.reason, ref: record.ref,
  });
}

/** Signing, decoded on its own terms: never measured, never a trust boundary. */
function signingOf(value: unknown): ActivationSigningView | null {
  const record = exactDataRecord(value, SIGNING_KEYS);
  if (record === null || record.measured !== false || record.member !== "signing"
    || record.trustBoundary !== false || typeof record.reason !== "string"
    || !nonEmptyString(record.ref)) return null;
  return Object.freeze({
    measured: false as const, member: "signing" as const, reason: record.reason,
    ref: record.ref, trustBoundary: false as const,
  });
}

function blockingOf(value: unknown): readonly ActivationMember[] | null {
  if (!Array.isArray(value) || !value.every(isMember)) return null;
  return Object.freeze([...(value as readonly ActivationMember[])]);
}

/**
 * A member may appear AT MOST ONCE: a card keys its rows and testids by member name, so a
 * repeat renders two elements claiming to be one receipt — and if they disagreed about
 * `measured`, the operator would be shown both.
 */
function membersOf(value: unknown): readonly ActivationReceiptView[] | null {
  if (!Array.isArray(value) || value.length > ACTIVATION_MEMBERS.length) return null;
  const rows: ActivationReceiptView[] = [];
  const seen = new Set<ActivationMember>();
  for (const raw of value) {
    const row = receiptOf(raw);
    if (row === null || seen.has(row.member)) return null;
    seen.add(row.member);
    rows.push(row);
  }
  return Object.freeze(rows);
}

/** A nullable sub-record: absent is a STATE (nothing measured yet), a drifted shape is not. */
function optionalRecord<T>(
  value: unknown, keys: readonly string[], shape: (record: Readonly<Record<string, unknown>>) => T | null,
): T | null | undefined {
  if (value === null) return null;
  const record = exactDataRecord(value, keys);
  return record === null ? undefined : (shape(record) ?? undefined);
}

const distributionOf = (value: unknown): ActivationDistributionView | null | undefined =>
  optionalRecord(value, ["kind", "root"], (record) =>
    nonEmptyString(record.kind) && nonEmptyString(record.root)
      ? Object.freeze({ kind: record.kind, root: record.root }) : null);

const repositoryOf = (value: unknown): ActivationRepositoryView | null | undefined =>
  optionalRecord(value, ["headSha", "toplevel"], (record) =>
    nonEmptyString(record.headSha) && nonEmptyString(record.toplevel)
      ? Object.freeze({ headSha: record.headSha, toplevel: record.toplevel }) : null);

const storeOf = (value: unknown): { readonly storePath: string } | null | undefined =>
  optionalRecord(value, ["storePath"], (record) =>
    nonEmptyString(record.storePath) ? Object.freeze({ storePath: record.storePath }) : null);

/** Maps only an exact daemon ACTIVATION frame; every other answer is REFUSED or ERROR. PURE. */
export function mapActivationAnswer(status: number, response: unknown): ActivationReadOutcome {
  const refusal = refusalFrom(response);
  if (refusal !== null) return refusal;
  if (status !== 200) return invalidResponse();
  const record = exactDataRecord(response, ACTIVATION_FRAME_KEYS);
  if (record === null || record.outcome !== "ACTIVATION" || !nonEmptyString(record.measuredAt)
    || !nonEmptyString(record.schemaVersion)) return invalidResponse();
  const blocking = blockingOf(record.blocking);
  const members = membersOf(record.members);
  const signing = signingOf(record.signing);
  const distribution = distributionOf(record.distribution);
  const repository = repositoryOf(record.repository);
  const store = storeOf(record.store);
  if (blocking === null || members === null || signing === null
    || distribution === undefined || repository === undefined || store === undefined) return invalidResponse();
  return Object.freeze({
    blocking, distribution, measuredAt: record.measuredAt, members, repository,
    schemaVersion: record.schemaVersion, signing, status: "ACTIVATION" as const, store,
  });
}

/** POSTs exactly `{}` and maps the reply; `post` is injectable for tests. */
export async function readActivation(
  headers: Readonly<Record<string, string>>, post?: (body: string) => Promise<Response>,
): Promise<ActivationReadOutcome> {
  const send = post ?? ((body: string): Promise<Response> => fetch(ACTIVATION_READ_PATH, {
    body, headers, method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  let response: Response;
  try {
    response = await send("{}");
  } catch {
    return errored(TRANSPORT_FAILED_CODE, LIVE_ACTIVATION_LAYER);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return invalidResponse();
  }
  return mapActivationAnswer(response.status, body);
}
