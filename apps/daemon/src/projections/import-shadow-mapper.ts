import { createHash } from "node:crypto";

import { SHADOW_ENTITY_FIELDS, SHADOW_PROJECTION_VERSION } from "@moe/import";
import type { ImportEventFacts, ShadowEntity, ShadowEntityKind, ShadowProjection } from "@moe/import";

/**
 * The DAEMON's own mapping from decoded import facts onto the shadow vocabulary.
 *
 * WHY THIS IS NOT `projectLegacyImport`, and it is the whole point of the adapter.
 * `projectLegacyImport` maps the LEGACY side. If the new side reached for it too — directly
 * or through a shared helper — the shadow comparison would run one function against itself
 * and report perfect agreement forever, with a fully green suite behind it. The two mappings
 * must be able to DISAGREE for the comparison to mean anything, so this one is written
 * against the published `SHADOW_ENTITY_FIELDS` contract and nothing else.
 *
 * WHAT IT MAY NOT REACH FOR. Not `BoardProjection`, not its `byType` counts, not
 * `WorkClaimLedger`. A count is not a semantic fact, and agreement manufactured out of one is
 * exactly the invention this adapter exists to prevent. A semantic fact that is absent stays
 * absent; the reader refuses rather than letting this file fabricate it.
 *
 * Pure: no clock, no random source, no store and no port. The order is derived, so unchanged
 * durable bytes serialize identically on every run.
 */

/** Locale-independent and total; `localeCompare` varies with the host's ICU data. */
function byCodeUnit(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * The canonical form `SHADOW_PROJECTION_VERSION` declares for a link identity: the four
 * fields as a sorted-key JSON object, digested whole.
 *
 * Digested over the TUPLE rather than a joined key, deliberately: `from "a"` + `to "b:c"`
 * and `from "a:b"` + `to "c"` both render as `a:b:c`, so a joined key would silently merge
 * two distinct links into one entity and hide a real disagreement.
 */
function linkIdOf(from: string, kind: string, to: string): string {
  const body = { from, kind, to, version: SHADOW_PROJECTION_VERSION };
  const canonical = Object.keys(body)
    .sort(byCodeUnit)
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(body[key as keyof typeof body])}`)
    .join(",");
  return createHash("sha256").update(new TextEncoder().encode(`{${canonical}}`)).digest("hex");
}

function entityOf(
  kind: ShadowEntityKind,
  id: string,
  fields: Record<string, string>,
): ShadowEntity {
  return Object.freeze({ fields: Object.freeze(fields), id, kind });
}

/** A total order over kind then id. Derived, never insertion order. */
function compareEntities(left: ShadowEntity, right: ShadowEntity): number {
  const byKind = byCodeUnit(left.kind, right.kind);
  return byKind === 0 ? byCodeUnit(left.id, right.id) : byKind;
}

/**
 * A held legacy claim is SUSPENDED on import (§21.4) and a suspended claim is a blocker in
 * new-side terms. The blocker is derived from the claim's OWN status, so it cannot outlive
 * it — and a HISTORICAL claim emitting none is a FACT about that claim, not a gap.
 */
function claimEntities(facts: ImportEventFacts): readonly ShadowEntity[] {
  const { claim } = facts;
  const entities = [
    entityOf("CLAIM", claim.claimId, {
      [SHADOW_ENTITY_FIELDS.CLAIM[0]]: claim.principal,
      [SHADOW_ENTITY_FIELDS.CLAIM[1]]: claim.provenance.sourcePath,
      [SHADOW_ENTITY_FIELDS.CLAIM[2]]: claim.status,
    }),
  ];
  if (claim.status === "SUSPENDED") {
    entities.push(entityOf("BLOCKER", claim.claimId, {
      [SHADOW_ENTITY_FIELDS.BLOCKER[0]]: "SUSPENDED_CLAIM",
      [SHADOW_ENTITY_FIELDS.BLOCKER[1]]: claim.principal,
    }));
  }
  return entities;
}

/** Every field value is canonical TEXT, so `evidenceOnly` renders rather than coerces. */
function linkEntities(facts: ImportEventFacts): readonly ShadowEntity[] {
  return facts.links.map((link) => entityOf("LINK", linkIdOf(link.from, link.kind, link.to), {
    [SHADOW_ENTITY_FIELDS.LINK[0]]: String(link.evidenceOnly),
    [SHADOW_ENTITY_FIELDS.LINK[1]]: link.from,
    [SHADOW_ENTITY_FIELDS.LINK[2]]: link.kind,
    [SHADOW_ENTITY_FIELDS.LINK[3]]: link.to,
  }));
}

/**
 * Projects every decoded row of one import onto the versioned shadow vocabulary.
 *
 * A field outside `SHADOW_ENTITY_FIELDS` is never emitted: the comparator reports an
 * undeclared field as UNKNOWN, so emitting one here would launder a daemon-invented field
 * into a comparison as though both sides had agreed to it.
 */
export function projectDaemonImportShadow(
  rows: readonly ImportEventFacts[],
): ShadowProjection {
  const entities: ShadowEntity[] = [];
  for (const facts of rows) {
    entities.push(...claimEntities(facts), ...linkEntities(facts));
  }
  return Object.freeze({
    entities: Object.freeze(entities.sort(compareEntities)),
    version: SHADOW_PROJECTION_VERSION,
  });
}
