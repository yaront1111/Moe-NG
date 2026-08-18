/**
 * The single derivation authority for Foundation context manifest identity.
 *
 * WHY A THIRD MODULE, AND NOT THE LEDGER. These derivations were private to the
 * writer, which imports the low-level reader for the event type and the replay
 * codes. A strict reader that needs the same identities would therefore have to
 * import the writer, closing an ESM cycle whose initialization order surfaces as
 * a TDZ fault far from its cause. A module that imports NEITHER — only the codec
 * and store TYPES — is importable from both sides forever.
 *
 * NO IDENTIFIER IS ACCEPTED, ONLY DERIVED. Every function here takes record
 * FIELDS and returns an identity; none takes an id, a namespace or a digest
 * function, so a caller cannot name a slot it does not own or swap the preimage.
 *
 * THREE NESTED PREIMAGES, each answering one question the store can be asked:
 *   aggregate = project + session + attempt          "whose context slot is this"
 *   command   = aggregate + node + revision + epoch  "which sealing command"
 *   request   = command + configuration + inputs + graph content
 *
 * BYTE IDENTITY DEPENDS ON THREE THINGS, not one: the namespace literal, the
 * frame format, and the parts ORDER. Tidying any of them silently rewrites
 * durable identity, so all three are pinned by hand-transcribed goldens in
 * `foundation-context-manifest-ledger.test.ts`.
 */

import { createHash } from "node:crypto";

import type { CommandDecisionKey } from "@moe/store";

import { FOUNDATION_CONTEXT_RECORD_VERSION } from "./foundation-context-manifest-codec.js";

export const FOUNDATION_CONTEXT_COMMAND_KIND = "foundation.context-manifest.seal" as const;

/** Which context slot: the narrowest identity the aggregate is allowed to see. */
export interface FoundationContextSlotIdentity {
  readonly attemptRef: string;
  readonly projectId: string;
  readonly sessionId: string;
}

/**
 * The nine server-authority fields a selection is sealed under. No manifest and
 * no recordDigest: those are the SEALED CONTENT, and hashing content into the
 * command identity would make a re-render a different command.
 */
export interface FoundationContextSelectionIdentity extends FoundationContextSlotIdentity {
  readonly configurationDigest: string;
  readonly graphContentHash: string;
  readonly graphEpoch: number;
  readonly graphRevisionRef: string;
  readonly inputManifestDigest: string;
  readonly nodeKey: string;
}

type Parts = readonly (string | number)[];

const AGGREGATE_NAMESPACE = "moe-foundation-context/1:";
const COMMAND_NAMESPACE = "moe-foundation-context-command/1:";
const CORRELATION_NAMESPACE = "moe-foundation-context-correlation/1:";
const EVENT_NAMESPACE = "moe-foundation-context-event/1:";
const PRINCIPAL_NAMESPACE = "moe-foundation-context-principal/1:";
const REQUEST_NAMESPACE = "moe-foundation-context-request/1:";
const encoder = new TextEncoder();

/** Length-prefixed: `"ab" + "c"` and `"a" + "bc"` must not hash alike. */
function frame(parts: Parts): string {
  return parts.map((part) => `${String(part).length}:${String(part)}`).join("|");
}

/** Namespaced, hashed, and therefore bounded whatever the field lengths are. */
function identifier(namespace: string, parts: Parts): string {
  const digest = createHash("sha256").update(`${namespace}${frame(parts)}`, "utf8").digest("hex");
  return `${namespace}sha256:${digest}`;
}

function aggregateParts(slot: FoundationContextSlotIdentity): Parts {
  return [FOUNDATION_CONTEXT_RECORD_VERSION, slot.projectId, slot.sessionId, slot.attemptRef];
}
function commandParts(selection: FoundationContextSelectionIdentity): Parts {
  return [...aggregateParts(selection), selection.nodeKey, selection.graphRevisionRef,
    selection.graphEpoch];
}
function requestParts(selection: FoundationContextSelectionIdentity): Parts {
  return [...commandParts(selection), selection.configurationDigest,
    selection.inputManifestDigest, selection.graphContentHash];
}

export function deriveFoundationContextAggregateId(slot: FoundationContextSlotIdentity): string {
  return identifier(AGGREGATE_NAMESPACE, aggregateParts(slot));
}

export function deriveFoundationContextDecisionKey(
  selection: FoundationContextSelectionIdentity,
): CommandDecisionKey {
  return Object.freeze({
    commandId: identifier(COMMAND_NAMESPACE, commandParts(selection)),
    principalId: identifier(PRINCIPAL_NAMESPACE, [selection.projectId, selection.sessionId]),
    // The store scopes every decision by project; this is the record's OWN
    // project, already bound by its digest, so it cannot name a foreign one.
    projectId: selection.projectId,
  });
}

export function deriveFoundationContextRequestBytes(
  selection: FoundationContextSelectionIdentity,
): Uint8Array {
  return encoder.encode(`${REQUEST_NAMESPACE}${frame(requestParts(selection))}`);
}

/**
 * DELIBERATELY NOT THE COMMAND ID, though both hash the SAME `commandParts`.
 * They are two durable identities that differ only by namespace: the command id
 * fences idempotent redelivery, the event id names one appended fact. Sharing a
 * single derivation between them typechecks, leaves most tests green, and makes
 * two distinct identities equal — so they stay two functions with two
 * namespaces, and the suite pins that their answers differ.
 */
export function deriveFoundationContextEventId(
  selection: FoundationContextSelectionIdentity,
): string {
  return identifier(EVENT_NAMESPACE, commandParts(selection));
}

/**
 * Over the SEALED CONTENT digest, not the selection: correlation groups the
 * record actually written, so a re-render under one command correlates apart.
 */
export function deriveFoundationContextCorrelationId(recordDigest: string): string {
  return identifier(CORRELATION_NAMESPACE, [recordDigest]);
}
