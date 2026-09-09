import { decodeBoundedJsonBytes } from "@moe/contracts";

/**
 * The exact external contract for a DESIGN REVISION: what an agent seat may submit for one goal
 * between the Gate 1 product-contract approval and the decomposition run, and the closed refusal
 * vocabulary the design aggregate answers with.
 *
 * WHAT A SEAT MAY SAY. Six members and nothing else: the FIVE sections a design is made of — the
 * screens/journey map, the data model, the API surface, the component list and the non-functional
 * decisions — plus the open decisions it leaves to the human. Everything carrying authority (the
 * project, the goal, the profile, the moment, the version) is derived by daemon production code.
 *
 * WHY THE DECODER REFUSES EXTRA KEYS RATHER THAN IGNORING THEM. Silently dropping an unexpected
 * member would let a seat believe it had submitted something load-bearing — a whole section, or a
 * decision it wanted a human to answer — and the loss would only surface much later, as a plan
 * compiled from a partial design. An exact-arity record refuses, so the wire meaning cannot drift.
 *
 * WHY THE LAYER IS DERIVED FROM THE CODE. `designRefusal` takes no layer argument: the closed
 * `DESIGN_CODE_LAYERS` map is the single source, so a call site cannot mint a refusal whose code
 * and layer disagree, and the code roster cannot drift from the layer map. This mirrors
 * `../planning/expansion-request-contracts.ts`, whose header records the same rule.
 *
 * This module reads nothing, writes nothing and mints no authority. Its consumer is
 * `design-store.ts`; the two command kinds that publish it over the wire belong to
 * task-06ac0da1ace64032855affc4ab0c1a4e and are deliberately absent here.
 */

/** The controlled profile every revision on this board is authored against. SERVER-set. */
export const DESIGN_PROFILE = "typescript-web-app/react-node-postgresql" as const;

export const DESIGN_REVISION_VERSION = "moe-design-revision/1" as const;
export const DESIGN_REVISION_EVENT_TYPE = "DesignRevisionSubmitted" as const;
export const DESIGN_AGGREGATE_PREFIX = "design:" as const;

/** Bounded, NUL-free, non-empty text. A NUL byte reaches the store as a malformed id. */
export const MAX_DESIGN_TEXT = 4096;

/** The complete external revision. Sorted, and compared by exact arity. */
export const DESIGN_REVISION_KEYS = Object.freeze([
  "apiSurface", "componentList", "dataModel", "nonFunctional", "openDecisions", "screens",
] as const);

/** The FIVE sections, named apart from `openDecisions` so a dropped one names itself. */
export const DESIGN_SECTION_KEYS = Object.freeze([
  "apiSurface", "componentList", "dataModel", "nonFunctional", "screens",
] as const);

/**
 * A DECLARED SKIP: this goal plans without a design. Sorted, and compared by exact arity like the
 * revision roster, which is what makes a HALF-SKIPPED value unrepresentable rather than merely
 * discouraged — `{skipped, reason, ...six sections}` is eight keys and satisfies neither roster.
 */
export const DESIGN_SKIP_KEYS = Object.freeze(["reason", "skipped"] as const);

export const DESIGN_JOURNEY_KEYS = Object.freeze(["journey", "screens"] as const);
export const DESIGN_SCREEN_KEYS = Object.freeze(["screen", "states"] as const);
export const DESIGN_ENTITY_KEYS = Object.freeze(["entity", "fields", "relations"] as const);
export const DESIGN_ROUTE_KEYS = Object.freeze(["payload", "route"] as const);
export const DESIGN_NON_FUNCTIONAL_KEYS = Object.freeze([
  "accessibility", "auth", "performance",
] as const);

/** Which surface answered a refusal. Closed: a refusal outside this roster is a bug. */
export const DESIGN_LAYERS = Object.freeze(["CONTRACT_AUTHORITY", "LEDGER", "REQUEST"] as const);

export type DesignLayer = (typeof DESIGN_LAYERS)[number];

/**
 * Every refusal this slice can mint, mapped to the layer that mints it. The code roster is
 * DERIVED from these keys below, so the two can never disagree.
 */
export const DESIGN_CODE_LAYERS = Object.freeze({
  /** The goal has no approved Gate 1 product-contract revision to design against. */
  DESIGN_CONTRACT_NOT_APPROVED: "CONTRACT_AUTHORITY",
  /** Stored bytes that this module did not write, or no longer decode. */
  DESIGN_RECORD_MALFORMED: "LEDGER",
  /** A read found no revision on the aggregate. */
  DESIGN_REVISION_ABSENT: "LEDGER",
  /** The store fenced the append on a stale expected version. */
  DESIGN_REVISION_CONFLICT: "LEDGER",
  /** The exact-key section roster refused the submitted revision. */
  DESIGN_SHAPE_INVALID: "REQUEST",
  /** The durable store failed for a reason that is not a fence. */
  DESIGN_STORE_UNAVAILABLE: "LEDGER",
} as const satisfies Readonly<Record<string, DesignLayer>>);

export type DesignCode = keyof typeof DESIGN_CODE_LAYERS;

/** Derived, never restated: the roster IS the layer map's key set. */
export const DESIGN_CODES: readonly DesignCode[] = Object.freeze(
  (Object.keys(DESIGN_CODE_LAYERS) as DesignCode[]).sort(),
);

export type DesignScreen = Readonly<{ screen: string; states: readonly string[] }>;
export type DesignJourney = Readonly<{ journey: string; screens: readonly DesignScreen[] }>;
export type DesignEntity = Readonly<{
  entity: string; fields: readonly string[]; relations: readonly string[];
}>;
export type DesignRoute = Readonly<{ payload: string; route: string }>;
export type DesignNonFunctional = Readonly<{
  accessibility: string; auth: string; performance: string;
}>;

export interface DesignRevision {
  readonly apiSurface: readonly DesignRoute[];
  readonly componentList: readonly string[];
  readonly dataModel: readonly DesignEntity[];
  readonly nonFunctional: DesignNonFunctional;
  readonly openDecisions: readonly string[];
  readonly screens: readonly DesignJourney[];
}

/**
 * The design step, DECLARED SKIPPED rather than omitted — a compiler seat that simply receives no
 * design cannot tell "the operator skipped it" from "the read failed", and will guess.
 *
 * `skipped` is the LITERAL `true`, never a boolean: `skipped: false` would be a lawful revision
 * carrying no design at all, exactly the half-skipped state this shape exists to refuse. A
 * non-skip is expressed by submitting an actual design. `reason` is bounded because a skip is a
 * product decision, and an unexplained one is a decision nobody can review later.
 */
export interface DesignSkip {
  readonly reason: string;
  readonly skipped: true;
}

/** What a design revision slot can hold. Narrow it with `isDesignSkip`, never by hand. */
export type DesignRevisionOrSkip = DesignRevision | DesignSkip;

/**
 * The ONE narrowing two consumer rows share, so neither re-implements it and they cannot drift.
 * It answers on the OWN literal `true`, not on the marker's presence: a hand-cast `skipped: false`
 * is a design that was never drawn, and calling it a skip is the confusion this slice removes.
 */
export function isDesignSkip(value: DesignRevisionOrSkip): value is DesignSkip {
  return Object.hasOwn(value, "skipped")
    && (value as Readonly<Partial<DesignSkip>>).skipped === true;
}

export interface DesignRefusal {
  readonly code: DesignCode;
  readonly layer: DesignLayer;
  readonly ok: false;
  /** The delegated surface's own code, copied verbatim; null when this slice refused alone. */
  readonly sourceCode: string | null;
  /** The delegated surface's own layer, copied verbatim; null when this slice refused alone. */
  readonly sourceLayer: string | null;
}

export type DesignRevisionResult =
  | { readonly ok: true; readonly revision: DesignRevisionOrSkip }
  | DesignRefusal;

export function designRefusal(
  code: DesignCode,
  sourceCode: string | null = null,
  sourceLayer: string | null = null,
): DesignRefusal {
  return Object.freeze({
    code, layer: DESIGN_CODE_LAYERS[code], ok: false as const, sourceCode, sourceLayer,
  });
}

export function isDesignRefusal(value: unknown): value is DesignRefusal {
  return typeof value === "object" && value !== null && "ok" in value
    && (value as { readonly ok: unknown }).ok === false;
}

/** One aggregate per goal. The prefix is structural, so another family's id is unreachable. */
export function designAggregateId(goalId: string): string {
  return `${DESIGN_AGGREGATE_PREFIX}${goalId}`;
}

export function designRevisionEventId(goalId: string, version: number): string {
  return `design-revision-${version}-${goalId}`;
}

export function boundedDesignText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && value.length <= MAX_DESIGN_TEXT && !value.includes("\u0000");
}

/** Exact arity over own enumerable string keys, with no inherited member admitted. */
export function exactDesignRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== "string")) return null;
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property === undefined || !property.enumerable || !("value" in property)) return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

function textList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  if (!value.every((item) => boundedDesignText(item))) return null;
  return Object.freeze([...value] as string[]);
}

function recordList<T>(
  value: unknown, keys: readonly string[], map: (item: Readonly<Record<string, unknown>>) => T | null,
): readonly T[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const out: T[] = [];
  for (const entry of value) {
    const item = exactDesignRecord(entry, keys);
    if (item === null) return null;
    const mapped = map(item);
    if (mapped === null) return null;
    out.push(mapped);
  }
  return Object.freeze(out);
}

function screenOf(item: Readonly<Record<string, unknown>>): DesignScreen | null {
  const states = textList(item["states"]);
  if (states === null || !boundedDesignText(item["screen"])) return null;
  return Object.freeze({ screen: item["screen"], states });
}

function journeys(value: unknown): readonly DesignJourney[] | null {
  return recordList(value, DESIGN_JOURNEY_KEYS, (item) => {
    const screens = recordList(item["screens"], DESIGN_SCREEN_KEYS, screenOf);
    if (screens === null || !boundedDesignText(item["journey"])) return null;
    return Object.freeze({ journey: item["journey"], screens });
  });
}

function entities(value: unknown): readonly DesignEntity[] | null {
  return recordList(value, DESIGN_ENTITY_KEYS, (item) => {
    const fields = textList(item["fields"]);
    const relations = textList(item["relations"]);
    if (fields === null || relations === null || !boundedDesignText(item["entity"])) return null;
    return Object.freeze({ entity: item["entity"], fields, relations });
  });
}

function routes(value: unknown): readonly DesignRoute[] | null {
  return recordList(value, DESIGN_ROUTE_KEYS, (item) =>
    boundedDesignText(item["payload"]) && boundedDesignText(item["route"])
      ? Object.freeze({ payload: item["payload"], route: item["route"] })
      : null);
}

function nonFunctional(value: unknown): DesignNonFunctional | null {
  const item = exactDesignRecord(value, DESIGN_NON_FUNCTIONAL_KEYS);
  if (item === null || !DESIGN_NON_FUNCTIONAL_KEYS.every((k) => boundedDesignText(item[k]))) {
    return null;
  }
  return Object.freeze({
    accessibility: item["accessibility"] as string, auth: item["auth"] as string,
    performance: item["performance"] as string,
  });
}

/**
 * OWN `skipped` marker, never inherited: `"skipped" in value` would walk the prototype chain and
 * re-open the hole `exactDesignRecord` deliberately closes.
 */
function carriesSkipMarker(value: unknown): boolean {
  return typeof value === "object" && value !== null
    && Reflect.ownKeys(value).includes("skipped");
}

/** Exact arity again, so a skip that still carries sections fails the roster rather than a check. */
function decodeSkip(value: unknown): DesignRevisionResult {
  const item = exactDesignRecord(value, DESIGN_SKIP_KEYS);
  if (item === null || item["skipped"] !== true || !boundedDesignText(item["reason"])) {
    return designRefusal("DESIGN_SHAPE_INVALID");
  }
  return Object.freeze({
    ok: true as const,
    revision: Object.freeze({ reason: item["reason"], skipped: true as const }),
  });
}

/**
 * The ONE decode of seat bytes in this slice. It copies every accepted member into a fresh frozen
 * record, so a caller retaining a reference to the input cannot mutate what the daemon persisted.
 *
 * TWO ADMITTED ARITIES, discriminated on the presence of an own `skipped` marker: the two-key skip
 * and the unchanged six-key revision. A seventh REQUIRED key would have made every existing
 * six-key payload refuse and forced every real design to carry `skipped: false` as wire noise.
 */
export function decodeDesignRevision(value: unknown): DesignRevisionResult {
  if (carriesSkipMarker(value)) return decodeSkip(value);
  const item = exactDesignRecord(value, DESIGN_REVISION_KEYS);
  if (item === null) return designRefusal("DESIGN_SHAPE_INVALID");
  const apiSurface = routes(item["apiSurface"]);
  const componentList = textList(item["componentList"]);
  const dataModel = entities(item["dataModel"]);
  const decisions = nonFunctional(item["nonFunctional"]);
  const openDecisions = textList(item["openDecisions"]);
  const screens = journeys(item["screens"]);
  if (apiSurface === null || componentList === null || dataModel === null || decisions === null
    || openDecisions === null || screens === null) {
    return designRefusal("DESIGN_SHAPE_INVALID");
  }
  return Object.freeze({
    ok: true as const,
    revision: Object.freeze({
      apiSurface, componentList, dataModel, nonFunctional: decisions, openDecisions, screens,
    }),
  });
}

/** Durable bytes back to a revision. Refuses anything this module did not write. */
export function decodeDesignRevisionBytes(bytes: unknown): DesignRevisionResult {
  const json = decodeBoundedJsonBytes(bytes);
  if (!json.ok) return designRefusal("DESIGN_RECORD_MALFORMED", json.code, "BOUNDED_JSON");
  const decoded = decodeDesignRevision(json.value);
  return decoded.ok ? decoded : designRefusal("DESIGN_RECORD_MALFORMED");
}
