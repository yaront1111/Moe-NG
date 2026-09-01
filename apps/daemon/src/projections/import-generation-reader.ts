import { COMMAND_EFFECT_IDENTITY_VERSION } from "@moe/store";
import type { CommandReceipt, StoredEvent } from "@moe/store";

import type { ImportShadowRefused, ImportShadowStorePort } from "./import-shadow-contracts.js";
import { readImportShadowProjection } from "./import-shadow-reader.js";

/**
 * The durable import generation (design §21.12), for the v2 cutover activation marker.
 *
 * WHICH DURABLE FACT THIS IS, AND WHY. `importGenerationSha256` is the store's own
 * `CommandReceipt.effectSha256` for the committed legacy import: `identifyCommandEffects`
 * derives it over the aggregate, the command, the request identity, the version transition
 * and every event's position, id, type, payload and metadata. It therefore names the VERIFIED
 * IMPORT HEAD - what was actually committed.
 *
 * It is deliberately NOT `SourceManifest.digest`, even though that digest is already durable
 * and would have been the easier answer. The manifest digest names the locked INPUT: the
 * bytes that were asked to be imported. Two runs over the same source tree share it while
 * committing different durable effects. Returning it would name the request rather than the
 * result, and the cutover marker exists precisely to detect drift in the result. The manifest
 * digest survives here only as the aggregate LOCATOR, and is revalidated as such.
 *
 * THE CALLER SUPPLIES NOTHING. The request vocabulary is exactly the empty record. There is
 * no locator, no digest, no aggregate id and no "current" selector, because a generation the
 * caller handed in would make the drift check compare a value against itself while looking
 * rigorous. The prefix scanned is server-owned and fixed.
 *
 * ABSENCE REFUSES, IT DOES NOT DEFAULT. No path returns a zero-filled or empty digest: two
 * zero-filled generations compare EQUAL, which would silently make the drift comparison
 * vacuous. The refusal arm carries no digest field at all, so that answer is unrepresentable.
 */

/** The daemon's shadow adapter and its `@moe/import` decoder keep their OWN layers. */
export const IMPORT_GENERATION_READ_LAYER = "DAEMON_IMPORT_GENERATION" as const;

export type ImportGenerationReadLayer = typeof IMPORT_GENERATION_READ_LAYER;

/** Every code has a planned emitter; an unreachable code is a claim no test can pin. */
export const IMPORT_GENERATION_REFUSAL_CODES = Object.freeze([
  "IMPORT_GENERATION_ABSENT",
  "IMPORT_GENERATION_AMBIGUOUS",
  "IMPORT_GENERATION_EVIDENCE_UNREADABLE",
  "IMPORT_GENERATION_HORIZON_DRIFT",
  "IMPORT_GENERATION_INPUT_INVALID",
  "IMPORT_GENERATION_RECEIPT_ABSENT",
  "IMPORT_GENERATION_RECEIPT_MISMATCH",
] as const);

export type ImportGenerationRefusalCode = (typeof IMPORT_GENERATION_REFUSAL_CODES)[number];

/**
 * Read-only by construction. Declared structurally rather than as `SqliteEventStore` so this
 * reader cannot reach a writer even by accident, and extending the shadow port is what lets
 * the same handle be passed to the validator it composes.
 */
export interface ImportGenerationStorePort extends ImportShadowStorePort {
  enumerateAggregateIdsByPrefix(aggregateIdPrefix: string): readonly string[];
  getCommandReceipt(commandId: string): CommandReceipt | null;
}

/** A refusal carries no digest field, so a defaulted generation is unrepresentable. */
export interface ImportGenerationRefused {
  readonly code: ImportGenerationRefusalCode | ImportShadowRefused["code"];
  readonly detail: string;
  readonly layer: ImportGenerationReadLayer | ImportShadowRefused["layer"];
  readonly ok: false;
}

export interface ImportGenerationAccepted {
  readonly importGenerationSha256: string;
  readonly ok: true;
}

export type ImportGenerationRead = ImportGenerationAccepted | ImportGenerationRefused;

/** `applyImport` keys its aggregate on the manifest digest; the prefix is server-owned. */
const AGGREGATE_PREFIX = "legacy-import:";

/** Both the manifest digest and the effect digest come from `sha256Hex`. */
const SHA256_SHAPE = /^[0-9a-f]{64}$/u;

function refuse(code: ImportGenerationRefusalCode, detail: string): ImportGenerationRefused {
  return Object.freeze({ code, detail, layer: IMPORT_GENERATION_READ_LAYER, ok: false as const });
}

/**
 * Wraps an upstream refusal WITHOUT touching its code or its layer.
 *
 * The finer diagnosis belongs to whichever layer made it. Restamping it here would make
 * malformed bytes indistinguishable from an unsupported schema, and nothing would notice.
 */
function forward(refused: ImportShadowRefused): ImportGenerationRefused {
  return Object.freeze({
    code: refused.code,
    detail: refused.detail,
    layer: refused.layer,
    ok: false as const,
  });
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The request vocabulary is the EMPTY RECORD, and nothing else.
 *
 * `Reflect.ownKeys` and `Array.isArray` both throw on a revoked proxy, so the whole admission
 * sits inside the catch's reach: a crash is not a refusal.
 */
function admitRequest(request: unknown): ImportGenerationRefused | null {
  try {
    if (typeof request !== "object" || request === null || Array.isArray(request)) {
      return refuse(
        "IMPORT_GENERATION_INPUT_INVALID",
        "the request must be a plain empty record; this reader takes no caller input",
      );
    }
    const prototype: unknown = Object.getPrototypeOf(request);
    if (prototype !== Object.prototype && prototype !== null) {
      return refuse("IMPORT_GENERATION_INPUT_INVALID", "the request must be a plain object");
    }
    const keys = Reflect.ownKeys(request);
    if (keys.length !== 0) {
      // `importGenerationSha256` lands here with every other key. A caller-presented
      // generation is not a hint to be validated; it is a fabricated authority.
      return refuse(
        "IMPORT_GENERATION_INPUT_INVALID",
        `the request carries ${String(keys.length)} key(s) (${keys.map(String).join(", ")});`
          + " the generation is derived from durable state and is never supplied",
      );
    }
  } catch (cause) {
    return refuse("IMPORT_GENERATION_INPUT_INVALID", `the request is unreadable: ${describe(cause)}`);
  }
  return null;
}

function readHorizon(
  store: ImportGenerationStorePort,
): ImportGenerationRefused | { readonly at: bigint } {
  try {
    const at: unknown = store.readEventHorizon();
    if (typeof at !== "bigint" || at < 0n) {
      throw new TypeError(`the horizon is not a nonnegative bigint: ${String(at)}`);
    }
    return { at };
  } catch (cause) {
    return refuse("IMPORT_GENERATION_EVIDENCE_UNREADABLE", `horizon unreadable: ${describe(cause)}`);
  }
}

/**
 * Enumerates the fixed server-owned prefix. A candidate whose id does not fit
 * `legacy-import:<64 hex>` refuses rather than being skipped: skipping one would let a second
 * committed import hide behind a malformed sibling and turn ambiguity into a confident answer.
 */
function enumerateCandidates(
  store: ImportGenerationStorePort,
): ImportGenerationRefused | readonly string[] {
  let answered: unknown;
  try {
    answered = store.enumerateAggregateIdsByPrefix(AGGREGATE_PREFIX);
    if (!Array.isArray(answered)) throw new TypeError("enumeration did not answer with a list");
  } catch (cause) {
    return refuse(
      "IMPORT_GENERATION_EVIDENCE_UNREADABLE",
      `aggregate enumeration unreadable: ${describe(cause)}`,
    );
  }
  const candidates = answered as readonly unknown[];
  for (const candidate of candidates) {
    // `startsWith` is tested BEFORE the suffix so the shape check reads in the order it
    // reasons: an id outside the server-owned prefix is rejected as such, rather than
    // incidentally because slicing 14 characters off it failed to look like a digest.
    if (
      typeof candidate !== "string"
      || !candidate.startsWith(AGGREGATE_PREFIX)
      || !SHA256_SHAPE.test(candidate.slice(AGGREGATE_PREFIX.length))
    ) {
      return refuse(
        "IMPORT_GENERATION_EVIDENCE_UNREADABLE",
        `an enumerated aggregate is not ${AGGREGATE_PREFIX}<64 hex>: ${String(candidate)}`,
      );
    }
  }
  return candidates as readonly string[];
}

function readEventsOf(
  store: ImportGenerationStorePort,
  aggregateId: string,
): ImportGenerationRefused | readonly StoredEvent[] {
  try {
    const answered: unknown = store.readEvents(aggregateId);
    if (!Array.isArray(answered)) throw new TypeError("readEvents did not answer with a list");
    if (answered.length === 0) throw new TypeError("an enumerated aggregate holds no event");
    return answered as readonly StoredEvent[];
  } catch (cause) {
    return refuse(
      "IMPORT_GENERATION_EVIDENCE_UNREADABLE",
      `events unreadable at ${aggregateId}: ${describe(cause)}`,
    );
  }
}

/**
 * The committed identity, joined to the exact events it claims.
 *
 * Reading `effectSha256` as a bare scalar would accept a detached identity: a receipt naming
 * another aggregate carries a perfectly well-formed digest. Every field below is therefore
 * compared against the durable rows, in aggregate order. Sequence CONTIGUITY is not restated
 * here - the composed shadow validator already refuses a hole at its own layer, and this
 * reader consumes that same order to build the expected roster.
 */
function bindReceipt(
  store: ImportGenerationStorePort,
  aggregateId: string,
  events: readonly StoredEvent[],
): ImportGenerationRefused | CommandReceipt {
  const [first] = events;
  if (first === undefined) {
    return refuse("IMPORT_GENERATION_EVIDENCE_UNREADABLE", `no event at ${aggregateId}`);
  }
  const { commandId, committedAt, requestSha256 } = first;
  const coherent = events.every(
    (event) => event.commandId === commandId
      && event.committedAt === committedAt
      && event.requestSha256 === requestSha256,
  );
  if (commandId.length === 0 || committedAt.length === 0 || requestSha256.length === 0 || !coherent) {
    return refuse(
      "IMPORT_GENERATION_EVIDENCE_UNREADABLE",
      `the rows at ${aggregateId} do not agree on one committed command`,
    );
  }

  let receipt: CommandReceipt | null;
  try {
    receipt = store.getCommandReceipt(commandId);
  } catch (cause) {
    return refuse(
      "IMPORT_GENERATION_EVIDENCE_UNREADABLE",
      `receipt unreadable for ${commandId}: ${describe(cause)}`,
    );
  }
  if (receipt === null) {
    return refuse(
      "IMPORT_GENERATION_RECEIPT_ABSENT",
      `${aggregateId} is committed but carries no receipt for ${commandId};`
        + " an import without a durable effect identity has no generation",
    );
  }

  const eventIds = events.map((event) => event.eventId);
  const bound = receipt.effectIdentityVersion === COMMAND_EFFECT_IDENTITY_VERSION
    && receipt.aggregateId === aggregateId
    && receipt.commandId === commandId
    && receipt.requestSha256 === requestSha256
    && receipt.committedAt === committedAt
    && receipt.previousVersion === 0
    && receipt.currentVersion === events.length
    && receipt.outboxMessageIds.length === 0
    && receipt.eventIds.length === eventIds.length
    && receipt.eventIds.every((id, at) => id === eventIds[at])
    && SHA256_SHAPE.test(receipt.effectSha256);
  if (!bound) {
    return refuse(
      "IMPORT_GENERATION_RECEIPT_MISMATCH",
      `the receipt for ${commandId} does not bind the durable rows at ${aggregateId};`
        + " a detached effect identity is not this import's generation",
    );
  }
  return receipt;
}

/**
 * Reads the one committed legacy import and answers with its durable generation.
 *
 * Order is load-bearing. The horizon is captured BEFORE any row is read and re-checked as the
 * LAST store operation, so an answer can never be assembled across two store states. Every
 * candidate is validated before any is counted, so a corrupt sibling cannot masquerade as
 * ambiguity and ambiguity cannot be resolved by whichever candidate happened to validate.
 */
export function readDurableImportGeneration(
  store: ImportGenerationStorePort,
  request: unknown,
): ImportGenerationRead {
  const rejected = admitRequest(request);
  if (rejected !== null) return rejected;

  const opened = readHorizon(store);
  if ("ok" in opened) return opened;

  const candidates = enumerateCandidates(store);
  if ("ok" in candidates) return candidates;

  const generations: string[] = [];
  for (const aggregateId of candidates as readonly string[]) {
    const manifestDigest = aggregateId.slice(AGGREGATE_PREFIX.length);
    // The suffix is a LOCATOR only. The shadow validator re-derives every fact from the
    // durable bytes and cross-checks this digest against their provenance; its refusal is
    // forwarded verbatim rather than being re-diagnosed here.
    const validated = readImportShadowProjection(store, { manifestDigest });
    if (!validated.ok) return forward(validated);

    const events = readEventsOf(store, aggregateId);
    if ("ok" in events) return events;
    const receipt = bindReceipt(store, aggregateId, events as readonly StoredEvent[]);
    if ("ok" in receipt) return receipt;
    generations.push(receipt.effectSha256);
  }

  const closed = readHorizon(store);
  if ("ok" in closed) return closed;
  if (closed.at !== opened.at) {
    return refuse(
      "IMPORT_GENERATION_HORIZON_DRIFT",
      `the store horizon moved from ${String(opened.at)} to ${String(closed.at)} during the read;`
        + " a generation read across two states names neither of them",
    );
  }

  const [generation] = generations;
  if (generation === undefined) {
    return refuse(
      "IMPORT_GENERATION_ABSENT",
      `no legacy import is committed under ${AGGREGATE_PREFIX};`
        + " there is no generation to name, and a defaulted one would compare equal to itself",
    );
  }
  if (generations.length > 1) {
    // Production has no durable current-import selector. Electing the first or the newest
    // would be this reader inventing the authority it is supposed to be reporting.
    return refuse(
      "IMPORT_GENERATION_AMBIGUOUS",
      `${String(generations.length)} legacy imports are committed and no durable selector`
        + " names a current one; electing one would fabricate authority",
    );
  }
  return Object.freeze({ importGenerationSha256: generation, ok: true as const });
}
