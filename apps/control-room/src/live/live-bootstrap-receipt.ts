/**
 * THE DURABLE BOOTSTRAP RECEIPT, as the browser reads it: POST /repository/bootstrap/read with
 * EXACTLY `{}`, decoded through exact-key snapshots at every level. READS ONLY, and the same
 * discipline as live-activation.ts, from which the snapshot helper is transcribed.
 *
 * THE FOUR STATES ARE DECIDED HERE, not by whichever card renders them, and there are four
 * rather than two. The interesting one is `outcome: "BOOTSTRAPPED"` carrying a NON-NULL
 * `githubRefusal`: the local repository was created, committed and BOUND, and only the GitHub
 * half did not happen. That is a PARTIAL SUCCESS. An operator told "bootstrap failed" there
 * deletes a perfectly good repository, which is the harm this decode exists to prevent.
 *
 * The classification reads the daemon's OWN `outcome` and `githubRefusal` fields. It never
 * infers a refusal from a missing `remoteUrl` - that would be this browser minting an authority
 * the disclosure route (task-53267f86) exists to make unnecessary.
 */

export const BOOTSTRAP_RECEIPT_LAYER = "CONTROL_ROOM_BOOTSTRAP_RECEIPT" as const;
export const BOOTSTRAP_READ_PATH = "/repository/bootstrap/read" as const;
/** The route answered, but not with something this decoder will stand behind. */
export const BOOTSTRAP_READ_UNREADABLE = "BOOTSTRAP_READ_UNREADABLE" as const;
/** Nothing was delivered, or the answer was not JSON: no receipt was read. */
export const BOOTSTRAP_READ_FAILED = "BOOTSTRAP_READ_FAILED" as const;
/** The ledger holds no bootstrap at all. Nothing was attempted, which is NOT a refusal. */
export const BOOTSTRAP_RECEIPT_ABSENT = "BOOTSTRAP_RECEIPT_ABSENT" as const;
const REQUEST_TIMEOUT_MS = 15_000;

/** The eight closed keys of the durable receipt (repository-bootstrap-read.ts:33). */
export const BOOTSTRAP_RECEIPT_KEYS = [
  "decidedAt", "dir", "githubRefusal", "outcome", "refusal", "remoteUrl", "sha", "version",
] as const;
const REFUSAL_KEYS = ["code", "detail", "refusedBy"] as const;
const READ_KEYS = ["outcome", "receipt"] as const;
const UNREADABLE_KEYS = ["outcome", "receipt", "unreadable"] as const;

export interface BootstrapRefusalView {
  readonly code: string;
  readonly detail: string;
  readonly refusedBy: string;
}

export interface BootstrapReceiptView {
  readonly decidedAt: string;
  readonly dir: string;
  /** Non-null WITH `outcome: "BOOTSTRAPPED"` is the partial success, not a failure. */
  readonly githubRefusal: BootstrapRefusalView | null;
  readonly outcome: "BOOTSTRAPPED" | "REFUSED";
  readonly refusal: BootstrapRefusalView | null;
  readonly remoteUrl: string | null;
  readonly sha: string | null;
  readonly version: string;
}

export type BootstrapReceiptState =
  | { readonly receipt: BootstrapReceiptView; readonly state: "FULL_SUCCESS" }
  | {
    readonly githubRefusal: BootstrapRefusalView;
    readonly receipt: BootstrapReceiptView;
    readonly state: "PARTIAL_SUCCESS";
  }
  | {
    readonly receipt: BootstrapReceiptView;
    readonly refusal: BootstrapRefusalView;
    readonly state: "REFUSED";
  }
  | { readonly code: string; readonly layer: string; readonly state: "NO_RECEIPT" };

/** An own-enumerable EXACT-key snapshot (copied verbatim from live-activation.ts:89). */
function exactDataRecord(
  value: unknown, expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) return null;
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

const text = (value: unknown): value is string => typeof value === "string" && value !== "";
const nullableText = (value: unknown): value is string | null => value === null || text(value);

export const noReceipt = (
  code: string, layer: string = BOOTSTRAP_RECEIPT_LAYER,
): BootstrapReceiptState => Object.freeze({ code, layer, state: "NO_RECEIPT" as const });

/** `undefined` means malformed; `null` is the daemon's own "no refusal here". */
function refusalOf(value: unknown): BootstrapRefusalView | null | undefined {
  if (value === null) return null;
  const record = exactDataRecord(value, REFUSAL_KEYS);
  if (record === null || !text(record["code"]) || !text(record["detail"])
    || !text(record["refusedBy"])) return undefined;
  return Object.freeze({
    code: record["code"], detail: record["detail"], refusedBy: record["refusedBy"],
  });
}

export function receiptOf(value: unknown): BootstrapReceiptView | null {
  const record = exactDataRecord(value, BOOTSTRAP_RECEIPT_KEYS);
  if (record === null || !text(record["decidedAt"]) || !text(record["dir"])
    || !text(record["version"]) || !nullableText(record["remoteUrl"])
    || !nullableText(record["sha"])) return null;
  const outcome = record["outcome"];
  if (outcome !== "BOOTSTRAPPED" && outcome !== "REFUSED") return null;
  const refusal = refusalOf(record["refusal"]);
  const githubRefusal = refusalOf(record["githubRefusal"]);
  if (refusal === undefined || githubRefusal === undefined) return null;
  return Object.freeze({
    decidedAt: record["decidedAt"], dir: record["dir"], githubRefusal, outcome, refusal,
    remoteUrl: record["remoteUrl"], sha: record["sha"], version: record["version"],
  });
}

/** The daemon's own two fields decide this. A missing `remoteUrl` decides nothing. */
export function classifyReceipt(receipt: BootstrapReceiptView): BootstrapReceiptState {
  if (receipt.outcome === "REFUSED") {
    return receipt.refusal === null
      ? noReceipt(BOOTSTRAP_READ_UNREADABLE)
      : Object.freeze({ receipt, refusal: receipt.refusal, state: "REFUSED" as const });
  }
  return receipt.githubRefusal === null
    ? Object.freeze({ receipt, state: "FULL_SUCCESS" as const })
    : Object.freeze({
      githubRefusal: receipt.githubRefusal, receipt, state: "PARTIAL_SUCCESS" as const,
    });
}

/** Maps the route's answer. A route refusal is reported at the route's OWN code and layer. */
export function mapBootstrapReadAnswer(status: number, body: unknown): BootstrapReceiptState {
  if (status !== 200) return noReceipt(BOOTSTRAP_READ_FAILED);
  const refused = exactDataRecord(body, ["code", "layer", "outcome"]);
  if (refused !== null && refused["outcome"] === "REFUSED" && text(refused["code"])
    && text(refused["layer"])) return noReceipt(refused["code"], refused["layer"]);
  const view = exactDataRecord(body, READ_KEYS) ?? exactDataRecord(body, UNREADABLE_KEYS);
  if (view === null || view["outcome"] !== "BOOTSTRAP_READ") {
    return noReceipt(BOOTSTRAP_READ_UNREADABLE);
  }
  if (view["receipt"] === null) {
    return noReceipt(
      view["unreadable"] === true ? BOOTSTRAP_READ_UNREADABLE : BOOTSTRAP_RECEIPT_ABSENT,
    );
  }
  const receipt = receiptOf(view["receipt"]);
  return receipt === null ? noReceipt(BOOTSTRAP_READ_UNREADABLE) : classifyReceipt(receipt);
}

/** POSTs exactly `{}` to the disclosure route; `post` is injectable for tests. */
export async function readBootstrapReceipt(
  headers: Readonly<Record<string, string>>, post?: (body: string) => Promise<Response>,
): Promise<BootstrapReceiptState> {
  const send = post ?? ((body: string): Promise<Response> => fetch(BOOTSTRAP_READ_PATH, {
    body, headers, method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  let response: Response;
  try {
    response = await send("{}");
  } catch {
    return noReceipt(BOOTSTRAP_READ_FAILED);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return noReceipt(BOOTSTRAP_READ_UNREADABLE);
  }
  return mapBootstrapReadAnswer(response.status, body);
}
