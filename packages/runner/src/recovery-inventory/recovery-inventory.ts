import { canonicalDigest, deepFreeze } from "../canonical.js";
import {
  exactRecord,
  isPlainArray,
  isStrictRecord,
  oneOf,
  readList,
} from "../supervisor/effect-shape.js";
import {
  compareCodePoints,
  identityKey,
  isBoundedInventoryText,
  readInventoryItem,
  readOpaqueRef,
  readPortResult,
  readWindow,
  utcSortKey,
} from "./recovery-inventory-shape.js";
import {
  MAX_RECOVERY_INVENTORY_ITEMS,
  RECOVERY_INVENTORY_CLASSES,
  RECOVERY_INVENTORY_REQUEST_KEYS,
  RECOVERY_INVENTORY_VERSION,
  recoveryInventoryFailure,
  type RecoveryInventoryClass,
  type RecoveryInventoryCoverageProof,
  type RecoveryInventoryEnumerationContext,
  type RecoveryInventoryErrorCode,
  type RecoveryInventoryItem,
  type RecoveryInventoryOpaqueRef,
  type RecoveryInventoryRegistration,
  type RecoveryInventoryRegistry,
  type RecoveryInventoryReport,
  type RecoveryInventoryResult,
  type RecoveryInventoryUnknownReason,
  type RecoveryInventoryWindow,
} from "./recovery-inventory-contract.js";

/**
 * Composes per-class enumerator ports into one coverage report.
 *
 * The protocol is COMPLETE-or-UNKNOWN per CONFIGURED class, never per returned
 * class: a class nobody registered answers UNKNOWN instead of vanishing from the
 * report, which is the difference between "we looked and found nothing" and "we
 * never looked". Nothing raises an UNKNOWN back to COMPLETE, so a later port
 * succeeding cannot launder an earlier one's silence.
 *
 * Registration is an immutable caller-supplied tuple rather than a module-global
 * registry: a global would be order-dependent, race-prone across concurrent
 * collections, and would let a sibling adapter slice change this aggregate's
 * behaviour by importing it.
 */
export function createRecoveryInventoryRegistry(
  registrations: readonly RecoveryInventoryRegistration[],
): RecoveryInventoryRegistry {
  const snapshot = isPlainArray(registrations) ? [...registrations] : [];
  return Object.freeze({ registrations: Object.freeze(snapshot) });
}

interface CollectBasis {
  readonly projectTag: string;
  readonly backup: RecoveryInventoryOpaqueRef;
  readonly incarnation: RecoveryInventoryOpaqueRef;
  readonly window: RecoveryInventoryWindow;
  readonly configuredClasses: readonly RecoveryInventoryClass[];
}

export async function collectRecoveryInventory(
  request: unknown,
  registry: RecoveryInventoryRegistry,
): Promise<RecoveryInventoryResult> {
  const basis = readBasis(request);
  if ("code" in basis) {
    return recoveryInventoryFailure(basis.code, basis.message);
  }
  const ports = readRegistry(registry);
  if (ports === null) {
    return recoveryInventoryFailure(
      "RECOVERY_INVENTORY_REQUEST_INVALID",
      "registry is not a list of unique, well-formed class registrations",
    );
  }

  const items: RecoveryInventoryItem[] = [];
  const proofs: RecoveryInventoryCoverageProof[] = [];
  for (const cls of basis.configuredClasses) {
    const outcome = await collectClass(cls, ports.get(cls), basis);
    proofs.push(outcome.proof);
    items.push(...outcome.items);
  }

  return buildReport(basis, items, proofs);
}

interface BasisRefusal {
  readonly code: RecoveryInventoryErrorCode;
  readonly message: string;
}

function refuse(code: RecoveryInventoryErrorCode, message: string): BasisRefusal {
  return { code, message };
}

/**
 * Validates the whole request before the first await, so nothing is read twice
 * and no enumerator runs against a request that was never admissible. The order
 * below IS the precedence contract: an earlier refusal always answers first, so
 * a request that is wrong in two ways reports the same code every time.
 */
function readBasis(request: unknown): CollectBasis | BasisRefusal {
  if (!isStrictRecord(request)) {
    return refuse("RECOVERY_INVENTORY_REQUEST_INVALID", "request is not a plain record");
  }
  const keys = Object.keys(request);
  const expected = RECOVERY_INVENTORY_REQUEST_KEYS;
  if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) {
    return refuse("RECOVERY_INVENTORY_REQUEST_INVALID", "request keys are not exactly the five declared");
  }
  const record = request as Record<string, unknown>;
  if (!isBoundedInventoryText(record["projectTag"])) {
    return refuse("RECOVERY_INVENTORY_PROJECT_TAG_INVALID", "not bounded normalized text");
  }
  const backup = readOpaqueRef(record["backup"], "BACKUP_CURSOR_GENERATION");
  if (backup === null) {
    return refuse("RECOVERY_INVENTORY_BACKUP_REF_INVALID", "not an exact opaque cursor projection");
  }
  const incarnation = readOpaqueRef(record["incarnation"], "RECOVERY_INCARNATION");
  if (incarnation === null) {
    return refuse("RECOVERY_INVENTORY_INCARNATION_REF_INVALID", "not an exact opaque projection");
  }
  const window = readWindow(record["window"]);
  if (window === null) {
    return refuse("RECOVERY_INVENTORY_WINDOW_INVALID", "not an inclusive canonical UTC interval");
  }
  const configuredClasses = readConfiguredClasses(record["configuredClasses"]);
  if (configuredClasses === null) {
    return refuse("RECOVERY_INVENTORY_CONFIGURED_CLASSES_INVALID", "not a unique non-empty subset");
  }
  return { projectTag: record["projectTag"], backup, incarnation, window, configuredClasses };
}

function readConfiguredClasses(value: unknown): readonly RecoveryInventoryClass[] | null {
  const list = readList(value, RECOVERY_INVENTORY_CLASSES.length);
  if (list === null || list.length === 0) {
    return null;
  }
  const seen = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== "string" || !RECOVERY_INVENTORY_CLASSES.includes(entry as never)) {
      return null;
    }
    if (seen.has(entry)) {
      return null;
    }
    seen.add(entry);
  }
  // Emitted in frozen vocabulary order so the report never depends on the order
  // a caller happened to list its classes in.
  return Object.freeze(RECOVERY_INVENTORY_CLASSES.filter((cls) => seen.has(cls)));
}

/**
 * Snapshots the registry up front; a later push into the caller's array is not
 * seen. A registration for an unconfigured class is legal and simply never
 * invoked — only the configured set drives enumeration.
 */
function readRegistry(
  registry: unknown,
): Map<RecoveryInventoryClass, RecoveryInventoryRegistration> | null {
  const wrapper = exactRecord(registry, ["registrations"]);
  if (wrapper === null) {
    return null;
  }
  const registrations = readList(
    wrapper["registrations"],
    RECOVERY_INVENTORY_CLASSES.length * 2,
  );
  if (registrations === null) {
    return null;
  }
  const ports = new Map<RecoveryInventoryClass, RecoveryInventoryRegistration>();
  for (const entry of registrations) {
    // Exact-key and data-property-only: a registration carrying a field this
    // seam does not understand is not one it may invoke, and a getter must
    // never be able to answer `class` once and something else later.
    const parsed = exactRecord(entry, ["class", "enumerate"]);
    if (parsed === null) return null;
    const cls = parsed["class"];
    const enumerate = parsed["enumerate"];
    if (!oneOf(cls, RECOVERY_INVENTORY_CLASSES)) return null;
    if (typeof enumerate !== "function") return null;
    if (ports.has(cls)) return null;
    ports.set(cls, {
      class: cls,
      enumerate: enumerate as RecoveryInventoryRegistration["enumerate"],
    });
  }
  return ports;
}

interface ClassOutcome {
  readonly proof: RecoveryInventoryCoverageProof;
  readonly items: readonly RecoveryInventoryItem[];
}

async function collectClass(
  cls: RecoveryInventoryClass,
  registration: RecoveryInventoryRegistration | undefined,
  basis: CollectBasis,
): Promise<ClassOutcome> {
  if (registration === undefined) {
    return unknownClass(cls, "ENUMERATOR_UNREGISTERED");
  }
  const context: RecoveryInventoryEnumerationContext = Object.freeze({
    class: cls,
    projectTag: basis.projectTag,
    backup: basis.backup,
    incarnation: basis.incarnation,
    window: basis.window,
  });

  let answered: unknown;
  try {
    answered = await registration.enumerate(context);
  } catch {
    return unknownClass(cls, "ENUMERATOR_FAILED");
  }

  const reading = readPortResult(answered);
  if (reading === null) {
    return unknownClass(cls, "RESULT_MALFORMED");
  }
  if (reading.status === "UNAVAILABLE") {
    return unknownClass(cls, "ENUMERATOR_UNAVAILABLE");
  }
  if (reading.status === "UNSUPPORTED") {
    return unknownClass(cls, "CAPABILITY_UNSUPPORTED");
  }
  if (reading.items.length > MAX_RECOVERY_INVENTORY_ITEMS) {
    return unknownClass(cls, "RESULT_OVER_LIMIT");
  }
  if (!reading.complete) {
    return unknownClass(cls, "RESULT_TRUNCATED");
  }
  return admitItems(cls, reading.items, reading.negativeProofDigest, basis);
}

/**
 * Validates every returned item in a fixed order — shape, class, project, window,
 * then normalized identity duplication — so one hostile item cannot pick which
 * code it is refused with. A structurally valid but rejected item leaves the
 * class UNKNOWN and contributes nothing; it is never silently dropped.
 */
function admitItems(
  cls: RecoveryInventoryClass,
  raw: readonly unknown[],
  negativeProofDigest: string | null,
  basis: CollectBasis,
): ClassOutcome {
  const admitted: RecoveryInventoryItem[] = [];
  const seen = new Set<string>();
  const start = utcSortKey(basis.window.startInclusive);
  const end = utcSortKey(basis.window.endInclusive);

  for (const candidate of raw) {
    const parsed = readInventoryItem(candidate);
    if (parsed === null) {
      return rejectedClass(cls, "RECOVERY_INVENTORY_REQUEST_INVALID");
    }
    if (parsed.class !== cls) {
      return rejectedClass(cls, "RECOVERY_INVENTORY_CLASS_MISMATCH");
    }
    if (parsed.projectTag !== basis.projectTag) {
      return rejectedClass(cls, "RECOVERY_INVENTORY_PROJECT_MISMATCH");
    }
    const observed = utcSortKey(parsed.observedAt);
    if (observed < start || observed > end) {
      return rejectedClass(cls, "RECOVERY_INVENTORY_WINDOW_MISMATCH");
    }
    const key = identityKey(parsed.identity);
    if (seen.has(key)) {
      return rejectedClass(cls, "RECOVERY_INVENTORY_EXTERNAL_IDENTITY_DUPLICATE");
    }
    seen.add(key);
    admitted.push(parsed);
  }

  // An empty list is only ever COMPLETE against a verifiable negative proof; a
  // quiet enumerator is otherwise indistinguishable from an absent one.
  if (admitted.length === 0 && negativeProofDigest === null) {
    return unknownClass(cls, "NEGATIVE_PROOF_MISSING");
  }
  return {
    items: admitted,
    proof: proofOf(cls, "COMPLETE", null, null, admitted.length, negativeProofDigest),
  };
}

function unknownClass(
  cls: RecoveryInventoryClass,
  reason: RecoveryInventoryUnknownReason,
): ClassOutcome {
  return {
    items: [],
    proof: proofOf(cls, "UNKNOWN", "RECOVERY_INVENTORY_COVERAGE_UNKNOWN", reason, 0, null),
  };
}

function rejectedClass(
  cls: RecoveryInventoryClass,
  code: RecoveryInventoryErrorCode,
): ClassOutcome {
  return { items: [], proof: proofOf(cls, "UNKNOWN", code, "ITEM_REJECTED", 0, null) };
}

function proofOf(
  cls: RecoveryInventoryClass,
  truth: "COMPLETE" | "UNKNOWN",
  code: RecoveryInventoryErrorCode | null,
  reason: RecoveryInventoryUnknownReason | null,
  itemCount: number,
  negativeProofDigest: string | null,
): RecoveryInventoryCoverageProof {
  const body = { class: cls, truth, code, reason, itemCount, negativeProofDigest };
  return Object.freeze({
    ...body,
    layer: "INVENTORY_ADAPTER" as const,
    proofDigest: canonicalDigest({ version: RECOVERY_INVENTORY_VERSION, ...body }),
  });
}

function buildReport(
  basis: CollectBasis,
  items: readonly RecoveryInventoryItem[],
  proofs: readonly RecoveryInventoryCoverageProof[],
): RecoveryInventoryReport {
  const ordered = [...items].sort(
    (left, right) =>
      RECOVERY_INVENTORY_CLASSES.indexOf(left.class) -
        RECOVERY_INVENTORY_CLASSES.indexOf(right.class) ||
      compareCodePoints(identityKey(left.identity), identityKey(right.identity)),
  );
  const basisDigest = canonicalDigest({
    version: RECOVERY_INVENTORY_VERSION,
    projectTag: basis.projectTag,
    backup: { ...basis.backup },
    incarnation: { ...basis.incarnation },
    window: { ...basis.window },
    configuredClasses: [...basis.configuredClasses],
  });
  // Exact cardinality, not `every()`: a proof list that lost a class would
  // otherwise satisfy an all-COMPLETE test vacuously.
  const complete =
    proofs.length === basis.configuredClasses.length &&
    basis.configuredClasses.length > 0 &&
    proofs.every((proof) => proof.truth === "COMPLETE");

  return deepFreeze({
    reportVersion: RECOVERY_INVENTORY_VERSION,
    projectTag: basis.projectTag,
    backup: basis.backup,
    incarnation: basis.incarnation,
    window: basis.window,
    configuredClasses: basis.configuredClasses,
    items: ordered,
    proofs,
    coverage: complete ? ("COMPLETE" as const) : ("UNKNOWN" as const),
    basisDigest,
    // Digested as-is rather than re-spread: `canonicalJson` sorts keys itself,
    // and copying a fact record through `{...}` here would risk reintroducing
    // exactly the `__proto__` drop the reader was hardened against.
    inventoryDigest: canonicalDigest({
      basisDigest,
      items: ordered,
      proofs: proofs.map((proof) => proof.proofDigest),
    }),
  });
}
