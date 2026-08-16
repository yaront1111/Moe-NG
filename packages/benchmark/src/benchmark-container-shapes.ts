/**
 * One predicate per container the projector reads INTO, guarded to the depth it is read.
 *
 * WHY EACH OF THESE EXISTS RATHER THAN A BARE `isPlainRecord`. The projector does not
 * carry these containers verbatim; it reaches inside them for named fields and builds a
 * cell out of each. A guard that stops at the container's KIND therefore stops one level
 * above where the reading happens, and every field below it is admitted unexamined. `{}`
 * passes such a guard, its members read back as `undefined`, and the cell minters publish
 * that as an observation. The whole family below is one rule: guard where you read.
 *
 * AND NO DEEPER. Each predicate names exactly the fields the projection reads out of its
 * container and ignores everything else. A record may legitimately carry more than this
 * package projects — `ClaudeTelemetryLaunchFacts.exit` is a live example — and a guard
 * demanding an exact key set would refuse real runs over fields it never touches. These
 * answer "is this the shape I read?", never "is this a good record?".
 */

import {
  hasTextFields, hasTextOrNullFields, isPlainRecord, isProducerUnknown, isProjectedQuantity,
  isProjectedText, isText,
} from "./benchmark-field-primitives.js";

/** Run, effect and attempt identity. Projected whole, so every member must be readable. */
const RUN_REF_TEXT = Object.freeze(["provider", "runRef", "effectIntentId", "attemptRef"]);

/** The launcher's nullable facts: its own wall stamps and the digests that reproduce a run. */
const LAUNCH_TEXT_OR_NULL = Object.freeze([
  "reasonCode", "reasonLayer", "effectDigest", "activationDigest", "runtimeBindingDigest",
  "quotedRuntimeDigest", "freshRuntimeDigest", "pinnedClosureDigest", "observationDigest",
  "startedAt", "completedAt",
]);

/** What was ASKED FOR. Every member is projected into the effort or settings columns. */
const SELECTION_TEXT = Object.freeze([
  "provider", "selectedModelId", "modelSnapshotKind", "modelSnapshotEvidence",
  "reasoningEffort", "profileRevisionId", "configurationDigest", "policyDigest",
  "orchestrationDigest",
]);

const TOKEN_QUANTITIES = Object.freeze([
  "inputTokens", "outputTokens", "cacheCreationInputTokens", "cacheReadInputTokens",
]);

/**
 * `runIdentity` is carried verbatim, so an unreadable member reaches the row as a hole
 * rather than as an UNKNOWN — a run with no run, effect or attempt identity, reporting ok.
 */
export function isRunRef(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return hasTextFields(value, RUN_REF_TEXT) && Number.isFinite(value["epoch"]);
}

export function isLaunchFacts(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return hasTextFields(value, ["kind", "truthClass"])
    && hasTextOrNullFields(value, LAUNCH_TEXT_OR_NULL);
}

/**
 * The declared selection, or the producer's unknown standing in for it.
 *
 * A TRUNCATED SELECTION IS THE QUIETEST FAILURE IN THE PACKAGE. `{known: true, selection:
 * {selectedModelId: "m"}}` reaches the KNOWN arm, and every field the projection reads and
 * the selection lacks becomes a known cell with nothing behind it. The version seam cannot
 * catch it either: `ClaudeLaunchSelection` belongs to @moe/runner and moves on its own
 * version line, so a rename there arrives with `recordVersion` untouched.
 */
export function isDeclaredSelection(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (value["known"] !== true) return isProducerUnknown(value);
  const selection = value["selection"];
  if (!isPlainRecord(selection)) return false;
  return hasTextFields(selection, SELECTION_TEXT)
    && Number.isFinite(selection["concurrencyCeiling"]);
}

/** What the provider's BYTES said. Never defaulted from `declared`, so guarded on its own. */
export function isObservedModel(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return isProjectedText(value["modelId"])
    && isText(value["snapshotKind"])
    && isProjectedText(value["snapshotEvidence"]);
}

export function isTokenObservations(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return TOKEN_QUANTITIES.every((key) => isProjectedQuantity(value[key]))
    && isText(value["coverage"]);
}

export function isStepObservations(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return isProjectedQuantity(value["turns"]) && isText(value["coverage"]);
}

export function isConcurrency(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return isText(value["fact"])
    && isProjectedQuantity(value["declaredCeiling"])
    && isProjectedQuantity(value["achieved"]);
}

/**
 * The PROVIDER seam's refusal, carried verbatim into its own column.
 *
 * Guarded for the same reason an unknown cell is: a refusal whose `code` and `layer` are
 * absent names no authority, so a later reader holding only these bytes cannot tell which
 * seam refused the run. That is the disjointness the record's own contract is built on.
 */
export function isUpstreamRefusalOrNull(value: unknown): boolean {
  if (value === null) return true;
  if (!isPlainRecord(value)) return false;
  return value["ok"] === false && hasTextFields(value, ["code", "layer", "message"]);
}

/** One layered issue: which authority refused, under which code. */
function isLayeredIssue(value: unknown): boolean {
  return isPlainRecord(value) && hasTextFields(value, ["layer", "code", "message"]);
}

/** The SCHEDULER's refused envelopes, kept disjoint from the provider's refusal above. */
export function isUsageRefusalList(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((entry) =>
    isPlainRecord(entry)
    && Number.isFinite(entry["providerSequence"])
    && Array.isArray(entry["issues"])
    && (entry["issues"] as readonly unknown[]).every(isLayeredIssue));
}

/**
 * A derived list price against the revision it was read from, or no binding at all.
 *
 * `costBasis` is derived from this field being non-null, so a binding of the right kind
 * carrying none of its members reports PRICEBOOK_BINDING with nothing bound to it — a cost
 * basis naming a pricebook revision that is not there.
 */
export function isPricebookBindingOrNull(value: unknown): boolean {
  if (value === null) return true;
  if (!isPlainRecord(value)) return false;
  return hasTextFields(value, ["pricebookRevisionRef", "pricedAtRef"])
    && Number.isFinite(value["unitPriceMicros"]);
}

/**
 * The measurement fields a cost row is projected from. A row short of these has no basis.
 * `quantity` is either an explicit `null` — unobserved, and projected as UNKNOWN — or a
 * FINITE number; `NaN` is neither, and admitting it would publish it as a measurement.
 */
function hasMeasurementBasis(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const quantity = value["quantity"];
  return isText(value["meter"])
    && (quantity === null || Number.isFinite(quantity))
    && isText(value["coverage"])
    && isText(value["source"])
    && Number.isFinite(value["sequence"]);
}

export function isReadableUsageRow(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return hasMeasurementBasis(value["measurement"])
    && isPricebookBindingOrNull(value["pricebookBinding"])
    && typeof value["truncated"] === "boolean"
    && isText(value["identity"]);
}
