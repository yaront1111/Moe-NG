/**
 * The immutable vocabulary of ONE supersession preparation generation (task-32c1ba45).
 *
 * WHY THE REQUEST IS SO SMALL. A preparation is entirely a statement about facts the SERVER
 * already holds durably, so the request carries command identity and two selectors and nothing
 * else. `SUPERSESSION_PREPARATION_REQUEST_KEYS` is an EXACT key set: a caller who adds
 * `graphEpoch`, `dispositions`, `funding` or `lifecycle` is refused at the door rather than
 * having the extra field quietly ignored, because "ignored" and "adopted" are one edit apart.
 *
 * WHY ONE BINDING PROJECTS BOTH MEMBERS. The paired reservation and fence must agree on goal,
 * target revision, generation, deadline and captured fact horizon. Encoding those five once in
 * `PreparationGenerationBinding` and spreading the SAME frozen object into both members removes
 * the drift, rather than asking two writers to keep two copies equal.
 *
 * GRAPH IDENTITY, TWO DIFFERENT THINGS. `GraphContent.snapshotIdentity` is STRUCTURAL — it
 * identifies the node/edge shape and says nothing about policy or canonicalizer version.
 * `graphContentHash` comes ONLY from `encodeGraphContent` and is the sole content-bound hash a
 * preparation may cite. Nothing here may substitute the first for the second.
 *
 * NO CLOCK: `deadlineEpochMs` derives from the command's own durable `decidedAt` plus a fixed
 * window, so two replays of the same bytes land on the same deadline.
 */
import { createHash } from "node:crypto";

export const SUPERSESSION_PREPARATION_CODES = Object.freeze([
  "SUPERSESSION_PREPARATION_REQUEST_INVALID", "SUPERSESSION_PREPARATION_TARGET_FOREIGN",
  "SUPERSESSION_PREPARATION_GRAPH_UNAVAILABLE", "SUPERSESSION_PREPARATION_PLAN_UNAVAILABLE",
  "SUPERSESSION_PREPARATION_BUDGET_UNAVAILABLE", "SUPERSESSION_PREPARATION_FUNDING_UNAVAILABLE",
  "SUPERSESSION_PREPARATION_DISPOSITIONS_INCOMPLETE", "SUPERSESSION_PREPARATION_LINEAGE_EMPTY",
  "SUPERSESSION_PREPARATION_HISTORY_UNVERIFIABLE", "SUPERSESSION_PREPARATION_PAIR_SPLIT",
  "SUPERSESSION_PREPARATION_GENERATION_CURRENT", "SUPERSESSION_PREPARATION_BYTES_CONFLICT",
  "PLANNING_SUBMISSION_FINALIZING", "SUPERSESSION_CONSEQUENCE_CHANGED",
] as const);
export type SupersessionPreparationCode = (typeof SUPERSESSION_PREPARATION_CODES)[number];

export const SUPERSESSION_RELEASE_CODES = Object.freeze([
  "SUPERSESSION_RELEASE_REQUEST_INVALID", "SUPERSESSION_RELEASE_GENERATION_ABSENT",
  "SUPERSESSION_RELEASE_GENERATION_STALE", "SUPERSESSION_RELEASE_TARGET_FOREIGN",
  "SUPERSESSION_RELEASE_ACTIVATION_COMMITTED", "SUPERSESSION_RELEASE_ACTIVATION_UNVERIFIABLE",
  "SUPERSESSION_RELEASE_PAIR_SPLIT",
] as const);
export type SupersessionReleaseCode = (typeof SUPERSESSION_RELEASE_CODES)[number];

/** Which of the two modules answered. A delegated refusal still names the module that spoke. */
export const SUPERSESSION_PREPARATION_SERVICES = Object.freeze([
  "SUPERSESSION_PREPARATION_LEDGER", "SUPERSESSION_PREPARATION_SERVICE",
] as const);
export type SupersessionPreparationService = (typeof SUPERSESSION_PREPARATION_SERVICES)[number];

/**
 * MODULE-PRIVATE on purpose; only the TYPE is exported. A column-zero `export const *_LAYER`
 * enrols the constant in `tests/security/boundary-roster.security.ts` and owes it a hostile
 * trio, which a pure vocabulary earns no more than the planning-authority reader's layer did.
 */
const LAYER = "SUPERSESSION_PREPARATION" as const;
export type SupersessionPreparationLayer = typeof LAYER;
export const PREPARATION_BINDING_FIELDS = Object.freeze([
  "deadlineEpochMs", "factHorizonDigest", "generation", "goalRef", "targetRevisionRef",
] as const);

export const SUPERSESSION_PREPARATION_REQUEST_KEYS = Object.freeze([
  "approvedTargetRevisionRef", "commandId", "correlationId", "decidedAt",
  "goalRef", "principalId", "projectId",
] as const);

export const SUPERSESSION_RELEASE_REQUEST_KEYS = Object.freeze([
  "commandId", "correlationId", "decidedAt", "expectedPreparationVersion",
  "generation", "goalRef", "principalId", "projectId",
] as const);

/** The preparation window, in milliseconds, applied to the command's own `decidedAt`. */
export const PREPARATION_WINDOW_MS = 900_000;

export interface PreparationGenerationBinding {
  readonly deadlineEpochMs: number; readonly factHorizonDigest: string;
  readonly generation: number; readonly goalRef: string; readonly targetRevisionRef: string;
}

/** CONSUMED is the other terminal: SPENT by a supersession, not handed back (task-9e52f850). */
export interface SupersessionFundingReservation extends PreparationGenerationBinding {
  readonly lifecycle: "CONSUMED" | "HELD" | "RELEASED"; readonly meter: string;
  readonly quantity: number; readonly refunded: number; readonly reservationId: string;
}

export interface PreparedPlanningFence extends PreparationGenerationBinding {
  readonly fenceRef: string; readonly fencedLineages: readonly string[];
  readonly lifecycle: "ACTIVE" | "CONSUMED" | "RELEASED";
}

/**
 * How much of the lineage disposition the set authority could actually decide. COMPLETE means every
 * fenced lineage carries a decided disposition; PARTIAL means the set authority refused
 * PLANNING_DISPOSITION_UNKNOWN and the digest degrades to the lineage roster.
 *
 * DEFINED HERE, in the leaf, because the GENERATION now carries it durably —
 * `supersession-preparation-history.ts` re-exports this type so its existing importers are
 * unaffected. It is deliberately NOT a field of `PreparationGenerationBinding`: the binding's five
 * fields are framed into `planIdOf`, so adding it there would move every `supersessionPlanId`,
 * `fenceRef` and `reservationId` in the tree.
 */
export type DispositionCoverage = "COMPLETE" | "PARTIAL";

export interface SupersessionPreparationGeneration {
  readonly binding: PreparationGenerationBinding; readonly dispositionCoverage: DispositionCoverage;
  readonly dispositionDigest: string;
  readonly fence: PreparedPlanningFence; readonly funding: SupersessionFundingReservation;
  readonly supersessionPlanId: string;
}

export interface SupersessionPreparationRequest {
  readonly approvedTargetRevisionRef: string; readonly commandId: string;
  readonly correlationId: string; readonly decidedAt: string; readonly goalRef: string;
  readonly principalId: string; readonly projectId: string;
}

export interface SupersessionReleaseRequest {
  readonly commandId: string; readonly correlationId: string; readonly decidedAt: string;
  readonly expectedPreparationVersion: number; readonly generation: number;
  readonly goalRef: string; readonly principalId: string; readonly projectId: string;
}

export interface UpstreamRefusalFace { readonly code: string; readonly layer: string }

export interface SupersessionPreparationRefusal {
  readonly code: SupersessionPreparationCode | SupersessionReleaseCode;
  readonly layer: SupersessionPreparationLayer; readonly ok: false;
  readonly refusedBy: SupersessionPreparationService;
  /** The underlying authority's own code/layer when this vocabulary is wrapping one. */
  readonly sourceCode: string | null; readonly sourceLayer: string | null;
}

export type PreparationRequestResult = SupersessionPreparationRefusal
  | { readonly ok: true; readonly request: SupersessionPreparationRequest };
export type ReleaseRequestResult = SupersessionPreparationRefusal
  | { readonly ok: true; readonly request: SupersessionReleaseRequest };

function refuse(
  code: SupersessionPreparationCode | SupersessionReleaseCode,
  refusedBy: SupersessionPreparationService,
  source: UpstreamRefusalFace | null,
): SupersessionPreparationRefusal {
  return Object.freeze({
    code, layer: LAYER, ok: false as const, refusedBy,
    sourceCode: source === null ? null : source.code,
    sourceLayer: source === null ? null : source.layer,
  });
}

export function refusePreparation(
  code: SupersessionPreparationCode, refusedBy: SupersessionPreparationService,
  source: UpstreamRefusalFace | null = null,
): SupersessionPreparationRefusal { return refuse(code, refusedBy, source); }

export function refuseRelease(
  code: SupersessionReleaseCode, refusedBy: SupersessionPreparationService,
  source: UpstreamRefusalFace | null = null,
): SupersessionPreparationRefusal { return refuse(code, refusedBy, source); }

function exactRecord(
  value: unknown, keys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const present = Object.keys(record);
  if (present.length !== keys.length || keys.some((key) => !present.includes(key))) return null;
  return record;
}

function isRef(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 256;
}

export function decodePreparationRequest(value: unknown): PreparationRequestResult {
  const record = exactRecord(value, SUPERSESSION_PREPARATION_REQUEST_KEYS);
  if (record === null || SUPERSESSION_PREPARATION_REQUEST_KEYS.some((k) => !isRef(record[k]))) {
    return refusePreparation(
      "SUPERSESSION_PREPARATION_REQUEST_INVALID", "SUPERSESSION_PREPARATION_SERVICE",
    );
  }
  return Object.freeze({
    ok: true as const,
    request: Object.freeze({ ...record }) as unknown as SupersessionPreparationRequest,
  });
}

export function decodeReleaseRequest(value: unknown): ReleaseRequestResult {
  const record = exactRecord(value, SUPERSESSION_RELEASE_REQUEST_KEYS);
  const refs = SUPERSESSION_RELEASE_REQUEST_KEYS
    .filter((key) => key !== "expectedPreparationVersion" && key !== "generation");
  const version = record === null ? undefined : record["expectedPreparationVersion"];
  if (record === null || refs.some((key) => !isRef(record[key]))
    || !Number.isSafeInteger(record["generation"]) || (record["generation"] as number) <= 0
    || !Number.isSafeInteger(version) || (version as number) < 0) {
    return refuseRelease("SUPERSESSION_RELEASE_REQUEST_INVALID", "SUPERSESSION_PREPARATION_LEDGER");
  }
  return Object.freeze({
    ok: true as const,
    request: Object.freeze({ ...record }) as unknown as SupersessionReleaseRequest,
  });
}

export interface PreparationGenerationInput {
  readonly binding: PreparationGenerationBinding;
  readonly dispositionCoverage: DispositionCoverage; readonly dispositionDigest: string;
  readonly fencedLineages: readonly string[]; readonly meter: string; readonly quantity: number;
}

/** Domain-separated, field-framed so a value containing the separator cannot forge a neighbour. */
function planIdOf(binding: PreparationGenerationBinding, dispositionDigest: string): string {
  const digest = createHash("sha256").update("moe.supersession.preparation.v1", "utf8");
  for (const field of PREPARATION_BINDING_FIELDS) {
    const raw = String(binding[field]);
    digest.update(`${field}:${raw.length}:${raw}\n`, "utf8");
  }
  digest.update(`dispositionDigest:${dispositionDigest.length}:${dispositionDigest}\n`, "utf8");
  return digest.digest("hex");
}

/**
 * Bind one generation. The reservation and the fence are spread from the SAME frozen binding, so
 * "the pair shares its five fields" is a property of this function rather than of two writers.
 */
export function bindPreparationGeneration(
  input: PreparationGenerationInput,
): SupersessionPreparationGeneration {
  const binding: PreparationGenerationBinding = Object.freeze({ ...input.binding });
  const supersessionPlanId = planIdOf(binding, input.dispositionDigest);
  return Object.freeze({
    binding,
    dispositionCoverage: input.dispositionCoverage,
    dispositionDigest: input.dispositionDigest,
    fence: Object.freeze({
      ...binding, fenceRef: `${supersessionPlanId}#fence`,
      fencedLineages: Object.freeze([...input.fencedLineages].sort()), lifecycle: "ACTIVE" as const,
    }),
    funding: Object.freeze({
      ...binding, lifecycle: "HELD" as const, meter: input.meter, quantity: input.quantity,
      refunded: 0, reservationId: `${supersessionPlanId}#funding`,
    }),
    supersessionPlanId,
  });
}

/** Both members move together; there is no single-member transition. */
export function releaseGeneration(
  generation: SupersessionPreparationGeneration,
): SupersessionPreparationGeneration {
  return Object.freeze({
    ...generation,
    fence: Object.freeze({ ...generation.fence, lifecycle: "RELEASED" as const }),
    funding: Object.freeze({
      ...generation.funding, lifecycle: "RELEASED" as const,
      refunded: generation.funding.quantity,
    }),
  });
}

export function preparationAggregateId(projectId: string, goalRef: string): string {
  return `supersession-preparation:${projectId}:${goalRef}`;
}
export function fundingAggregateId(projectId: string, goalRef: string): string {
  return `supersession-funding:${projectId}:${goalRef}`;
}
export function planningFenceAggregateId(projectId: string, goalRef: string): string {
  return `planning-fence:${projectId}:${goalRef}`;
}
