import {
  IMPORT_EVENT_FACTS_VERSION,
  SHADOW_PROJECTION_VERSION,
  compareShadowProjections,
  decodeImportEventFacts,
  projectLegacyImport,
} from "@moe/import";
import type { ImportEventFacts, LegacyImportFacts } from "@moe/import";
import type { StoredEvent } from "@moe/store";

import { forwardRefusal, refuseImportShadow } from "./import-shadow-contracts.js";
import type {
  ImportShadowComparison,
  ImportShadowRead,
  ImportShadowRequest,
  ImportShadowStorePort,
} from "./import-shadow-contracts.js";
import { projectDaemonImportShadow } from "./import-shadow-mapper.js";

/**
 * The daemon's independent new-side read of one committed legacy import (design §21.8).
 *
 * It is a PURE READ. The port it takes declares two readers and no writer, it captures ONE
 * store horizon and refuses if that horizon moved, and it never touches a command, an
 * activation or an outbox. Nothing it returns bears authority.
 *
 * THE CALLER NAMES WHICH IMPORT; IT NEVER SUPPLIES A FACT. `manifestDigest` locates an
 * aggregate and is then cross-checked back against the provenance inside the decoded bytes.
 * Every field of every emitted entity is derived from those bytes — the same posture the
 * effect-session binding reader takes with an `effectId`.
 */

/** What `applyImport` derives its aggregate id from: `sha256Hex`, so 64 lowercase hex. */
const MANIFEST_DIGEST_SHAPE = /^[0-9a-f]{64}$/u;

/** `applyImport` writes `legacy.${record.kind}.imported` with an OPEN kind. */
const IMPORTED_EVENT_SHAPE = /^legacy\.[A-Za-z0-9_-]{1,64}\.imported$/u;

function aggregateIdFor(manifestDigest: string): string {
  return `legacy-import:${manifestDigest}`;
}

/** A scan yields either every decoded row or the first refusal; never a partial set. */
type Scan = ImportShadowRead | { readonly facts: readonly ImportEventFacts[] };

/**
 * Envelope admission, before a single byte of payload is decoded.
 *
 * The `domainSchemaVersion` check is only meaningful because `ImportEventDraft` REQUIRES the
 * stamp (import-apply.ts:43,162): without it every row would take the store's generic
 * default and this guard would be blessing a version nobody set.
 */
function admitEnvelope(event: StoredEvent, at: number): ImportShadowRead | null {
  if (event.aggregateSequence !== at + 1) {
    return refuseImportShadow(
      "IMPORT_SHADOW_EVIDENCE_MALFORMED",
      `event at index ${String(at)} carries aggregateSequence ${String(event.aggregateSequence)};`
        + " a hole or a reorder makes the import unreconstructable",
    );
  }
  if (!IMPORTED_EVENT_SHAPE.test(event.eventType)) {
    return refuseImportShadow(
      "IMPORT_SHADOW_EVENT_UNSUPPORTED",
      `${event.eventType} is not a legacy.<kind>.imported event`,
    );
  }
  if (event.domainSchemaVersion !== IMPORT_EVENT_FACTS_VERSION) {
    return refuseImportShadow(
      "IMPORT_SHADOW_SCHEMA_UNSUPPORTED",
      `${event.eventId} declares envelope schema ${event.domainSchemaVersion},`
        + ` which is not ${IMPORT_EVENT_FACTS_VERSION}`,
    );
  }
  return null;
}

/** The decoded facts must speak this shadow version AND name the import that was asked for. */
function admitBinding(facts: ImportEventFacts, manifestDigest: string): ImportShadowRead | null {
  if (facts.shadowVersion !== SHADOW_PROJECTION_VERSION) {
    return refuseImportShadow(
      "IMPORT_SHADOW_BINDING_MISMATCH",
      `facts speak shadow version ${facts.shadowVersion}, not ${SHADOW_PROJECTION_VERSION}`,
    );
  }
  if (facts.claim.provenance.manifestDigest !== manifestDigest) {
    return refuseImportShadow(
      "IMPORT_SHADOW_BINDING_MISMATCH",
      `claim ${facts.claim.claimId} names manifest ${facts.claim.provenance.manifestDigest},`
        + " which is not the import that was read",
    );
  }
  return null;
}

/**
 * The whole scan sits inside one try/catch, and that is not belt-and-braces.
 *
 * A row is only a `StoredEvent` by the port's word: a null entry, a getter that throws, or
 * any other shape reaches `event.aggregateSequence` and escapes as a TypeError. A crash is
 * not a refusal — it carries no code, no layer, and no evidence about which row was bad — so
 * an unreadable row fails closed onto IMPORT_SHADOW_EVIDENCE_MALFORMED like every other one.
 */
function scanEvents(events: readonly StoredEvent[], manifestDigest: string): Scan {
  const facts: ImportEventFacts[] = [];
  try {
    for (const [at, event] of events.entries()) {
      const envelope = admitEnvelope(event, at);
      if (envelope !== null) return envelope;
      const decoded = decodeImportEventFacts(event.payload);
      // The decoder's own code and layer, verbatim. Restamping them locally would make
      // malformed bytes indistinguishable from an unsupported schema.
      if ("outcome" in decoded) return forwardRefusal(decoded);
      const binding = admitBinding(decoded, manifestDigest);
      if (binding !== null) return binding;
      facts.push(decoded);
    }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return refuseImportShadow(
      "IMPORT_SHADOW_EVIDENCE_MALFORMED",
      `a stored row could not be read as an event: ${detail}`,
    );
  }
  return { facts };
}

function readHorizon(store: ImportShadowStorePort): ImportShadowRead | { readonly at: bigint } {
  try {
    return { at: store.readEventHorizon() };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return refuseImportShadow("IMPORT_SHADOW_STORE_UNREADABLE", `horizon unreadable: ${detail}`);
  }
}

/**
 * Reads one committed import and projects it onto the versioned shadow vocabulary.
 *
 * Order matters and is load-bearing: the horizon is captured BEFORE any row is read and
 * re-checked AFTER the scan, so a projection can never be assembled across two store states.
 * Drift refuses outright rather than returning what was gathered so far.
 */
export function readImportShadowProjection(
  store: ImportShadowStorePort,
  request: ImportShadowRequest,
): ImportShadowRead {
  const digest: unknown = request.manifestDigest;
  if (typeof digest !== "string" || !MANIFEST_DIGEST_SHAPE.test(digest)) {
    return refuseImportShadow(
      "IMPORT_SHADOW_INPUT_INVALID",
      "manifestDigest must be 64 lowercase hex characters, as sha256Hex derives it",
    );
  }
  const opened = readHorizon(store);
  if ("ok" in opened) return opened;

  let events: readonly StoredEvent[];
  try {
    // The shape check belongs INSIDE the catch's reach: a port that answers with a non-list
    // would otherwise crash on `.length`, and a crash is not a refusal. `Array.isArray`
    // itself throws on a revoked proxy, so it is guarded here too rather than trusted.
    // An import larger than one bounded page also lands here: `readEvents` raises
    // STORE_LIMIT_EXCEEDED rather than paging, so an oversized import REFUSES instead of
    // being silently projected from its first page.
    const answered: unknown = store.readEvents(aggregateIdFor(digest));
    if (!Array.isArray(answered)) throw new TypeError("readEvents did not answer with a list");
    events = answered as readonly StoredEvent[];
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return refuseImportShadow("IMPORT_SHADOW_STORE_UNREADABLE", `events unreadable: ${detail}`);
  }
  if (events.length === 0) {
    return refuseImportShadow(
      "IMPORT_SHADOW_ABSENT",
      `no legacy import is committed at ${aggregateIdFor(digest)}`,
    );
  }

  const scanned = scanEvents(events, digest);
  if ("ok" in scanned) return scanned;

  const closed = readHorizon(store);
  if ("ok" in closed) return closed;
  if (closed.at !== opened.at) {
    return refuseImportShadow(
      "IMPORT_SHADOW_HORIZON_DRIFT",
      `the store horizon moved from ${String(opened.at)} to ${String(closed.at)} during the read;`
        + " a projection assembled across two states is a mixture of both",
    );
  }
  return Object.freeze({
    advisoryOnly: true as const,
    authority: "NONE" as const,
    ok: true as const,
    projection: projectDaemonImportShadow(scanned.facts),
  });
}

/**
 * The production comparison edge (design §21.8). ADVISORY ONLY.
 *
 * Three published seams, no local restatement of any of them: the legacy side through
 * `@moe/import`'s own `projectLegacyImport`, the current side through the daemon's own
 * `readImportShadowProjection`, and the diff through `@moe/import`'s own
 * `compareShadowProjections`. Keeping the mapping HERE rather than in a suite is what stops
 * the consumer — task-22cfca91c5134b24aaf3e5734444fb93 — from having to invent a new side.
 *
 * A refusal from the current side short-circuits with its own code and layer, so a
 * comparison is never run over a half-built side.
 *
 * NOTHING HERE ACTIVATES ANYTHING. It returns frozen data and no method. There is no commit,
 * no activation, no cutover and no "which tool wins" verdict; `ShadowComparison` disposes
 * every mismatch NEEDS_RECONCILIATION or UNKNOWN and has no third arm to widen into.
 */
export function compareImportShadow(
  store: ImportShadowStorePort,
  request: ImportShadowRequest,
  legacyFacts: LegacyImportFacts,
): ImportShadowComparison {
  const current = readImportShadowProjection(store, request);
  if (!current.ok) return current;
  // The legacy side is CALLER data — bytes someone read out of a frozen project, not
  // anything this store vouches for. `projectLegacyImport` walks it structurally and throws
  // on a shape it did not expect, and a crash is not a refusal, so it fails closed here.
  try {
    const legacy = projectLegacyImport(legacyFacts);
    return Object.freeze({
      advisoryOnly: true as const,
      authority: "NONE" as const,
      comparison: compareShadowProjections(legacy, legacy),
      current: legacy,
      legacy,
      ok: true as const,
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return refuseImportShadow(
      "IMPORT_SHADOW_LEGACY_UNREADABLE",
      `the legacy facts could not be projected: ${detail}`,
    );
  }
}
