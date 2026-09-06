/** Browser mirror of design-records.ts/design-contracts.ts; no daemon runtime dependency. */
export interface DesignRevisionView {
  readonly apiSurface: readonly Readonly<{ payload: string; route: string }>[];
  readonly componentList: readonly string[];
  readonly dataModel: readonly Readonly<{ entity: string; fields: readonly string[]; relations: readonly string[] }>[];
  readonly nonFunctional: Readonly<{ accessibility: string; auth: string; performance: string }>;
  readonly openDecisions: readonly string[];
  readonly screens: readonly Readonly<{ journey: string; screens: readonly Readonly<{ screen: string; states: readonly string[] }>[] }>[];
}

export interface DesignRecordView {
  readonly contractRef: Readonly<{ contractId: string; revisionDigest: string; revisionId: string }>;
  readonly goalRef: string;
  readonly profile: string;
  readonly projectId: string;
  readonly revision: DesignRevisionView | Readonly<{ reason: string; skipped: true }>;
  readonly schemaVersion: string;
  readonly submittedAt: string;
  readonly version: number;
}

export type DesignOutcome =
  | { readonly status: "DESIGN"; readonly record: DesignRecordView; readonly versions: readonly number[] }
  | { readonly status: "REFUSED" | "ERROR"; readonly code: string; readonly layer: string };

const DESIGN_RECORD_KEYS = Object.freeze([
  "contractRef", "goalRef", "profile", "projectId", "revision", "schemaVersion", "submittedAt", "version",
]);
const DESIGN_REVISION_KEYS = Object.freeze([
  "apiSurface", "componentList", "dataModel", "nonFunctional", "openDecisions", "screens",
]);
const DESIGN_ENTITY_KEYS = Object.freeze(["entity", "fields", "relations"]);
const LAYER = "CONTROL_ROOM_LIVE_DESIGN";
const invalid = (): DesignOutcome => Object.freeze({ status: "ERROR", code: "DESIGN_RESPONSE_INVALID", layer: LAYER });
const refused = (code: string, layer: string): DesignOutcome => Object.freeze({ status: "REFUSED", code, layer });
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 4096 && !value.includes("\u0000");
const version = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Snapshot descriptors, never invoke getters or admit inherited/extra/non-enumerable keys. */
function exactDataRecord(value: unknown, expected: readonly string[]): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || keys.some((key) => typeof key !== "string" || !expected.includes(key))) return null;
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    copy[key] = descriptor.value;
  }
  return Object.freeze(copy);
}

function list<T>(value: unknown, decode: (item: unknown) => T | null): readonly T[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  if (Reflect.ownKeys(value).length !== value.length + 1) return null;
  const copy: T[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    const item = decode(descriptor.value);
    if (item === null) return null;
    copy.push(item);
  }
  return Object.freeze(copy);
}
const texts = (value: unknown): readonly string[] | null => list(value, (item) => text(item) ? item : null);

function entityOf(value: unknown): DesignRevisionView["dataModel"][number] | null {
  const item = exactDataRecord(value, DESIGN_ENTITY_KEYS);
  if (item === null || !text(item.entity)) return null;
  const fields = texts(item.fields);
  const relations = texts(item.relations);
  return fields === null || relations === null ? null : Object.freeze({ entity: item.entity, fields, relations });
}

function routeOf(value: unknown): DesignRevisionView["apiSurface"][number] | null {
  const item = exactDataRecord(value, ["payload", "route"]);
  return item !== null && text(item.payload) && text(item.route)
    ? Object.freeze({ payload: item.payload, route: item.route }) : null;
}

function journeyOf(value: unknown): DesignRevisionView["screens"][number] | null {
  const item = exactDataRecord(value, ["journey", "screens"]);
  if (item === null || !text(item.journey)) return null;
  const screens = list(item.screens, (value) => {
    const screen = exactDataRecord(value, ["screen", "states"]);
    if (screen === null || !text(screen.screen)) return null;
    const states = texts(screen.states);
    return states === null ? null : Object.freeze({ screen: screen.screen, states });
  });
  return screens === null ? null : Object.freeze({ journey: item.journey, screens });
}

function revisionOf(value: unknown): DesignRecordView["revision"] | null {
  const skip = exactDataRecord(value, ["reason", "skipped"]);
  if (skip !== null && skip.skipped === true && text(skip.reason)) {
    return Object.freeze({ reason: skip.reason, skipped: true });
  }
  const item = exactDataRecord(value, DESIGN_REVISION_KEYS);
  if (item === null) return null;
  const apiSurface = list(item.apiSurface, routeOf);
  const componentList = texts(item.componentList);
  const dataModel = list(item.dataModel, entityOf);
  const decisions = exactDataRecord(item.nonFunctional, ["accessibility", "auth", "performance"]);
  const openDecisions = texts(item.openDecisions);
  const screens = list(item.screens, journeyOf);
  if (apiSurface === null || componentList === null || dataModel === null || decisions === null
    || !text(decisions.accessibility) || !text(decisions.auth) || !text(decisions.performance)
    || openDecisions === null || screens === null) return null;
  const nonFunctional = Object.freeze({ accessibility: decisions.accessibility, auth: decisions.auth, performance: decisions.performance });
  return Object.freeze({ apiSurface, componentList, dataModel, nonFunctional, openDecisions, screens });
}

function recordOf(value: unknown): DesignRecordView | null {
  const item = exactDataRecord(value, DESIGN_RECORD_KEYS);
  if (item === null || !text(item.goalRef) || !text(item.projectId) || !text(item.submittedAt)
    || !version(item.version) || item.profile !== "typescript-web-app/react-node-postgresql"
    || item.schemaVersion !== "moe-design-revision/1") return null;
  const ref = exactDataRecord(item.contractRef, ["contractId", "revisionDigest", "revisionId"]);
  if (ref === null || !text(ref.contractId) || !text(ref.revisionDigest) || !text(ref.revisionId)) return null;
  const revision = revisionOf(item.revision);
  if (revision === null) return null;
  return Object.freeze({
    contractRef: Object.freeze({ contractId: ref.contractId, revisionDigest: ref.revisionDigest, revisionId: ref.revisionId }),
    goalRef: item.goalRef, profile: item.profile, projectId: item.projectId, revision,
    schemaVersion: item.schemaVersion, submittedAt: item.submittedAt, version: item.version,
  });
}

function refusalOf(value: unknown): DesignOutcome | null {
  const listener = exactDataRecord(value, ["code", "layer"]);
  if (listener !== null && text(listener.code) && text(listener.layer)) return refused(listener.code, listener.layer);
  const route = exactDataRecord(value, ["code", "layer", "outcome"]);
  if (route !== null && route.outcome === "REFUSED" && text(route.code) && text(route.layer)) return refused(route.code, route.layer);
  const store = exactDataRecord(value, ["code", "layer", "ok", "sourceCode", "sourceLayer"]);
  if (store === null || store.ok !== false || !text(store.code) || !text(store.layer)) return null;
  const sources = (store.sourceCode === null && store.sourceLayer === null)
    || (text(store.sourceCode) && text(store.sourceLayer));
  return sources ? refused(store.code, store.layer) : null;
}

/** Only a successful exact wire snapshot can be shown as DESIGN. Pure and total. */
export function mapDesignAnswer(status: number, response: unknown): DesignOutcome {
  try {
    const refusal = refusalOf(response);
    if (refusal !== null) return refusal;
    if (status !== 200) return invalid();
    const body = exactDataRecord(response, ["ok", "record", "versions"]);
    if (body === null || body.ok !== true) return invalid();
    const record = recordOf(body.record);
    const versions = list(body.versions, (item) => version(item) ? item : null);
    if (record === null || versions === null || !versions.includes(record.version)
      || new Set(versions).size !== versions.length) return invalid();
    return Object.freeze({ status: "DESIGN", record, versions });
  } catch {
    return invalid();
  }
}

/** Session headers only; the project is selected by the daemon, never by the request body. */
export async function readDesign(
  headers: Readonly<Record<string, string>>, goalRef: string, post?: (body: string) => Promise<Response>,
  planningRunRef?: string,
): Promise<DesignOutcome> {
  const send = post ?? ((body: string): Promise<Response> => fetch("/design/read", {
    body, headers, method: "POST", signal: AbortSignal.timeout(15_000),
  }));
  let response: Response;
  try {
    response = await send(JSON.stringify({ goalRef, ...(planningRunRef === undefined ? {} : { planningRunRef }) }));
  } catch {
    return Object.freeze({ status: "ERROR", code: "TRANSPORT_REQUEST_FAILED", layer: LAYER });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return invalid();
  }
  return mapDesignAnswer(response.status, body);
}
