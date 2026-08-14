import { byCodeUnit, canonicalDigest } from "./canonical-bytes.js";
import { refuseImport } from "./import-contract.js";
import type { ImportRefused } from "./import-contract.js";
import type { LegacyLink } from "./import-contract.js";
import {
  SHADOW_ENTITY_FIELDS,
  SHADOW_ENTITY_KINDS,
  SHADOW_MISMATCH_DISPOSITIONS,
  SHADOW_PROJECTION_VERSION,
  SHADOW_WHOLE_ENTITY_FIELD,
} from "./shadow-contract.js";
import type {
  LegacyImportFacts,
  ShadowComparison,
  ShadowEntity,
  ShadowEntityKind,
  ShadowMismatch,
  ShadowMismatchKind,
  ShadowProjection,
} from "./shadow-contract.js";

/**
 * The shadow projection MAPPER and COMPARATOR. The vocabulary they are written against
 * lives in `shadow-contract.ts`; it was split out when this module passed the 250-line
 * target, and moving it into `import-contract.ts` instead would have pushed THAT file to
 * roughly 303 lines. Same reasoning either way: split the file, never the task.
 *
 * Both functions are pure. They hold no store, no port and no command emitter, so the
 * task rail "the comparator is advisory and may not reach an authority-bearing store" is
 * a property of these signatures rather than a rule to remember. There is no clock and no
 * random source, and the mismatch order is total, so two runs over identical input
 * produce byte-identical output.
 */

function entityOf(kind: ShadowEntityKind, id: string, fields: Record<string, string>): ShadowEntity {
  return Object.freeze({ fields: Object.freeze(fields), id, kind });
}

/**
 * A link's identity is digested over the whole tuple rather than joined into a key:
 * `from "a"` + `to "b:c"` and `from "a:b"` + `to "c"` both render as `a:b:c`, so a joined
 * key would silently merge two distinct links.
 */
function linkId(link: LegacyLink): string {
  return canonicalDigest({
    from: link.from,
    kind: link.kind,
    to: link.to,
    version: SHADOW_PROJECTION_VERSION,
  });
}

/**
 * Maps an import onto the target vocabulary.
 *
 * A held claim yields BOTH a CLAIM and a BLOCKER: §21.4 imports it suspended and requires
 * a new authenticated lease, which is a blocker in new-side terms. The blocker is derived
 * from the claim's own status, never asserted independently, so it cannot outlive it.
 */
export function projectLegacyImport(facts: LegacyImportFacts): ShadowProjection {
  const entities: ShadowEntity[] = [];
  for (const claim of facts.claims) {
    entities.push(entityOf("CLAIM", claim.claimId, {
      principal: claim.principal,
      sourcePath: claim.provenance.sourcePath,
      status: claim.status,
    }));
    if (claim.status === "SUSPENDED") {
      entities.push(entityOf("BLOCKER", claim.claimId, {
        basis: "SUSPENDED_CLAIM",
        holder: claim.principal,
      }));
    }
  }
  for (const link of facts.links) {
    entities.push(entityOf("LINK", linkId(link), {
      evidenceOnly: String(link.evidenceOnly),
      from: link.from,
      kind: link.kind,
      to: link.to,
    }));
  }
  return Object.freeze({
    entities: Object.freeze(entities.sort(compareEntities)),
    version: SHADOW_PROJECTION_VERSION,
  });
}

function compareEntities(left: ShadowEntity, right: ShadowEntity): number {
  const byKind = byCodeUnit(left.kind, right.kind);
  return byKind === 0 ? byCodeUnit(left.id, right.id) : byKind;
}

function mismatchOf(
  entity: Pick<ShadowMismatch, "entityId" | "entityKind" | "field">,
  mismatchKind: ShadowMismatchKind,
  values: Pick<ShadowMismatch, "currentValue" | "legacyValue">,
): ShadowMismatch {
  return Object.freeze({
    currentValue: values.currentValue,
    disposition: SHADOW_MISMATCH_DISPOSITIONS[mismatchKind],
    entityId: entity.entityId,
    entityKind: entity.entityKind,
    field: entity.field,
    legacyValue: values.legacyValue,
    mismatchKind,
  });
}

/**
 * A TOTAL order over four keys.
 *
 * Ordering by id alone is not total here: a held claim produces a CLAIM and a BLOCKER
 * that share one id, so two callers listing their entities differently would report the
 * same facts in different orders — and a shadow report that reorders between runs cannot
 * be diffed by whoever has to act on it.
 */
function compareMismatches(left: ShadowMismatch, right: ShadowMismatch): number {
  const byKind = byCodeUnit(left.entityKind, right.entityKind);
  if (byKind !== 0) return byKind;
  const byId = byCodeUnit(left.entityId, right.entityId);
  if (byId !== 0) return byId;
  const byField = byCodeUnit(left.field, right.field);
  return byField === 0 ? byCodeUnit(left.mismatchKind, right.mismatchKind) : byField;
}

const DECLARED_KINDS: readonly string[] = SHADOW_ENTITY_KINDS;

function fieldsFor(kind: string): readonly string[] {
  return DECLARED_KINDS.includes(kind)
    ? SHADOW_ENTITY_FIELDS[kind as ShadowEntityKind]
    : [];
}

/** Indexed per kind rather than by a joined key, for the same collision reason as `linkId`. */
function index(projection: ShadowProjection): Map<string, Map<string, ShadowEntity>> {
  const byKind = new Map<string, Map<string, ShadowEntity>>();
  for (const entity of projection.entities) {
    const bucket = byKind.get(entity.kind) ?? new Map<string, ShadowEntity>();
    if (!bucket.has(entity.id)) bucket.set(entity.id, entity);
    byKind.set(entity.kind, bucket);
  }
  return byKind;
}

interface Collector {
  readonly mismatches: ShadowMismatch[];
  readonly refusals: ImportRefused[];
}

function reportUnmapped(
  into: Collector,
  entity: ShadowEntity,
  field: string,
  values: Pick<ShadowMismatch, "currentValue" | "legacyValue">,
): void {
  into.mismatches.push(mismatchOf(
    { entityId: entity.id, entityKind: entity.kind, field },
    "FIELD_UNMAPPED",
    values,
  ));
  into.refusals.push(refuseImport(
    "IMPORT_SHADOW_FIELD_UNMAPPED",
    "SHADOW",
    `${entity.kind} ${entity.id} carries ${field}, which ${SHADOW_PROJECTION_VERSION} does not map`,
  ));
}

/**
 * Reads one field as OWN-property-or-absent.
 *
 * `entity.fields[field] ?? null` is wrong for exactly one field name: reading an absent
 * `__proto__` returns the prototype OBJECT rather than undefined, so `?? null` does not
 * fire and a non-string value reaches the report. Both sides are caller-supplied plain
 * data, so a field with that name is reachable, and `Object.hasOwn` closes it for good.
 */
function readField(entity: ShadowEntity, field: string): string | null {
  return Object.hasOwn(entity.fields, field) ? entity.fields[field] ?? null : null;
}

/** Compares one entity that exists on both sides, field by field. */
function compareFields(into: Collector, legacy: ShadowEntity, current: ShadowEntity): void {
  const declared = fieldsFor(legacy.kind);
  const names = [...new Set([...Object.keys(legacy.fields), ...Object.keys(current.fields)])]
    .sort(byCodeUnit);
  for (const field of names) {
    const legacyValue = readField(legacy, field);
    const currentValue = readField(current, field);
    const values = { currentValue, legacyValue };
    if (!declared.includes(field)) {
      reportUnmapped(into, legacy, field, values);
      continue;
    }
    if (legacyValue === currentValue) continue;
    const kind = legacyValue === null
      ? "FIELD_ABSENT_ON_LEGACY"
      : currentValue === null ? "FIELD_ABSENT_ON_CURRENT" : "FIELD_DIFFERS";
    into.mismatches.push(mismatchOf(
      { entityId: legacy.id, entityKind: legacy.kind, field },
      kind,
      values,
    ));
  }
}

/** An entity present on one side only, plus any unmapped field it carries. */
function reportLone(into: Collector, entity: ShadowEntity, mismatchKind: ShadowMismatchKind): void {
  if (!DECLARED_KINDS.includes(entity.kind)) {
    reportUnmapped(into, entity, SHADOW_WHOLE_ENTITY_FIELD, { currentValue: null, legacyValue: null });
    return;
  }
  into.mismatches.push(mismatchOf(
    { entityId: entity.id, entityKind: entity.kind, field: SHADOW_WHOLE_ENTITY_FIELD },
    mismatchKind,
    { currentValue: null, legacyValue: null },
  ));
}

/**
 * Compares the two projections and returns every difference, ordered.
 *
 * Read-only and side-effect free: it holds no store, no port and no command emitter, so
 * "advisory" is a property of the signature rather than a rule to remember.
 */
export function compareShadowProjections(
  legacy: ShadowProjection,
  current: ShadowProjection,
): ShadowComparison {
  const into: Collector = { mismatches: [], refusals: [] };
  const currentIndex = index(current);
  const legacyIndex = index(legacy);
  for (const entity of legacy.entities) {
    const counterpart = currentIndex.get(entity.kind)?.get(entity.id);
    if (counterpart === undefined) reportLone(into, entity, "ENTITY_ABSENT_ON_CURRENT");
    else compareFields(into, entity, counterpart);
  }
  for (const entity of current.entities) {
    if (legacyIndex.get(entity.kind)?.has(entity.id) === true) continue;
    reportLone(into, entity, "ENTITY_ABSENT_ON_LEGACY");
  }
  return Object.freeze({
    mismatches: Object.freeze(into.mismatches.sort(compareMismatches)),
    refusals: Object.freeze(into.refusals),
    version: SHADOW_PROJECTION_VERSION,
  });
}
