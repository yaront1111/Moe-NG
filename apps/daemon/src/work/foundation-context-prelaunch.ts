/**
 * The SERVER-ONLY Foundation context prelaunch composition.
 *
 * A caller hands over IDENTITY and nothing else. Context text, items, bytes, digests, graph,
 * configuration or input facts, the byte budget, argv, a prompt slot and a provider observation
 * are UNREPRESENTABLE on the request surface: it is passed straight through to the context
 * authority, whose four-key admission is the fence. No second admission is added here — two
 * admissions drift, and the second is where a fifth key gets ignored rather than refused.
 *
 * THE ORDER IS THE POINT, and it is fixed: assemble the selection, render EXACTLY ONCE, verify
 * the seal, build the 11-key record, commit, RE-READ, admit the durable bytes, then compose the
 * mission and the launch template FROM THOSE BYTES.
 *
 * WHY THE RETURN VALUE COMES FROM THE RE-READ. Built from the in-memory render, an exact replay
 * would return identical bytes because rendering is deterministic — a coincidence, not a
 * property. Sourcing `renderedContext` from the record the store handed back makes "a replay
 * returns the ORIGINAL durable bytes" structural: a second caller whose render differs still
 * receives the FIRST commit's bytes, because the ledger answers a replay from the durable event.
 *
 * REFUSALS KEEP THEIR AUTHOR. Six vocabularies can answer for one prelaunch — the selection
 * authority's, the codec's, the ledger's, the reader's, the brief producer's and the template
 * producer's. Each arrives under this module's own code with the upstream code AND layer carried
 * verbatim in `upstream`, never restamped as ours and never flattened away.
 *
 * WHERE THE BYTE ADMISSION SITS. `renderContext` emits canonical UTF-8 with control characters
 * JSON-escaped, so no selection can make IT produce an empty, NUL-bearing or non-round-tripping
 * array. The bytes that reach a provider are the DURABLE ones — which a replay may have had
 * sealed by another caller, and which the codec admits as any 0-255 integer array — so
 * `roundTrips` guards those. `FOUNDATION_PRELAUNCH_MANIFEST_UNSEALED` is the one check with no
 * reachable driver: `renderContext` recomputes the digest it stores. It stays as a fail-closed
 * check across the package boundary, named here so nobody reads it as covered.
 *
 * NO PROVIDER EFFECT HAPPENS HERE: this returns a launch TEMPLATE, opening no process, taking
 * no grant and holding no lock, so every refusal is before a provider effect by construction.
 *
 * CONSUMER: task-203a5ca7aada4375a98a95df8773e249.
 */

import { digestContextManifest, renderContext } from "@moe/context";
import type { RenderedContext } from "@moe/context";
import { produceNodeBrief } from "../planning/node-mission-producer.js";
import type { NodeBriefDeps } from "../planning/node-mission-producer.js";
import {
  FOUNDATION_CONTEXT_RECORD_KEYS, deriveFoundationContextRecordDigest,
} from "./foundation-context-manifest-codec.js";
import type { FoundationContextManifestRecord } from "./foundation-context-manifest-codec.js";
import { commitFoundationContextManifest } from "./foundation-context-manifest-ledger.js";
import type { FoundationContextLedgerStore } from "./foundation-context-manifest-ledger.js";
import type { FoundationContextExpectedBinding } from "./foundation-context-manifest-proofs.js";
import { readFoundationContextManifest } from "./foundation-context-manifest-reader.js";
import type { FoundationContextReadPort } from "./foundation-context-manifest-reader.js";
import { freezeDeep } from "./foundation-context-matrix.js";
import type {
  FoundationContextAuthority, FoundationContextProvenance,
} from "./foundation-context-selection.js";
import { produceLaunchTemplateFields } from "./launch-template-producer.js";
import type { LaunchTemplateFields } from "./launch-template-producer.js";

/** Module-private stamp, published as a closed type; the literal rides on every refusal. */
const LAYER = "FOUNDATION_CONTEXT_PRELAUNCH";
export const FOUNDATION_PRELAUNCH_CODES = Object.freeze([
  "FOUNDATION_PRELAUNCH_SELECTION_REFUSED", "FOUNDATION_PRELAUNCH_MANIFEST_UNSEALED",
  "FOUNDATION_PRELAUNCH_BYTES_UNUSABLE", "FOUNDATION_PRELAUNCH_RECORD_INEXACT",
  "FOUNDATION_PRELAUNCH_COMMIT_REFUSED", "FOUNDATION_PRELAUNCH_READBACK_REFUSED",
  "FOUNDATION_PRELAUNCH_MISSION_REFUSED", "FOUNDATION_PRELAUNCH_TEMPLATE_REFUSED",
] as const);
export type FoundationPrelaunchCode = (typeof FOUNDATION_PRELAUNCH_CODES)[number];
export type FoundationPrelaunchLayer = typeof LAYER;
export type FoundationPrelaunchUpstream = Readonly<{ code: string; layer: string }>;
export interface FoundationPrelaunchRefusal {
  readonly code: FoundationPrelaunchCode;
  readonly detail: string;
  readonly layer: FoundationPrelaunchLayer;
  readonly ok: false;
  /** The refusing authority when it was not this one, preserved rather than restamped. */
  readonly upstream: FoundationPrelaunchUpstream | null;
}

/**
 * The durable Foundation authority services, every one a SERVICE the server binds rather than a
 * value a request proposes: `capabilities` and `observation` are thunks over the production
 * provider-profile resolver and the durable probe reader, exactly as the node brief producer
 * takes `repositoryScope`. A thunk that THROWS escapes, as it does there: both real readers
 * catch their own faults, and a catch-all here would mask a store fault under the wrong repair.
 */
export interface FoundationPrelaunchServices {
  readonly brief: NodeBriefDeps;
  readonly capabilities: () => unknown;
  readonly context: FoundationContextAuthority;
  readonly decidedAt: string;
  readonly ledger: FoundationContextLedgerStore;
  readonly observation: () => unknown;
  readonly readPort: FoundationContextReadPort;
}

export interface FoundationPrelaunchPrepared {
  /** The DURABLE sealed bytes, from the re-read - never the in-memory render. */
  readonly bytes: readonly number[];
  readonly ok: true;
  readonly record: FoundationContextManifestRecord;
  readonly template: LaunchTemplateFields;
}

export type FoundationPrelaunchResult = FoundationPrelaunchPrepared | FoundationPrelaunchRefusal;
const decoder = new TextDecoder("utf-8", { fatal: true }), encoder = new TextEncoder();
function refuse(
  code: FoundationPrelaunchCode, detail: string,
  upstream: FoundationPrelaunchUpstream | null = null,
): FoundationPrelaunchRefusal {
  return Object.freeze({
    code, detail, layer: LAYER, ok: false as const,
    upstream: upstream === null ? null : Object.freeze({ ...upstream }),
  });
}
/** The upstream verdict's own code and layer, copied field by field so nothing else travels. */
const carry = (source: { readonly code: string; readonly layer: string }):
FoundationPrelaunchUpstream => ({ code: source.code, layer: source.layer });

/**
 * Nonempty, NUL-free, canonical UTF-8 that round-trips byte-identically. A lone surrogate or an
 * overlong sequence decodes under a lenient reader and re-encodes to DIFFERENT bytes, so what
 * the provider received would not be what the digest attests; `fatal: true` refuses it outright
 * rather than substituting U+FFFD, the same failure wearing a valid costume.
 */
function roundTrips(bytes: readonly number[]): boolean {
  if (bytes.length === 0 || bytes.includes(0)) return false;
  let text: string;
  try { text = decoder.decode(Uint8Array.from(bytes)); } catch { return false; }
  const again = encoder.encode(text);
  return again.length === bytes.length && bytes.every((b, index) => again[index] === b);
}
/**
 * BOTH DIRECTIONS. Iterating the roster alone cannot see an extra key, iterating the candidate
 * alone cannot see a missing one, and a length check alone cannot see a swap; all three run, so
 * a drifted record REFUSES rather than being trimmed into shape.
 */
function exactRoster(candidate: Record<string, unknown>): boolean {
  const roster: readonly string[] = FOUNDATION_CONTEXT_RECORD_KEYS;
  const held = Object.keys(candidate);
  return held.length === roster.length && roster.every((key) => held.includes(key))
    && held.every((key) => roster.includes(key));
}

/**
 * THE FIELD MAPPING, spelled key by key rather than spread. The provenance names
 * `graphRevisionId` and `inputManifestSha256`; the record keys are `graphRevisionRef` and
 * `inputManifestDigest`. A spread drops both silently and the damage surfaces far from its cause.
 */
function candidateFor(
  provenance: FoundationContextProvenance,
  manifest: RenderedContext["manifest"],
): Record<string, unknown> {
  const bound = {
    attemptRef: provenance.attemptRef,
    configurationDigest: provenance.configurationDigest,
    graphContentHash: provenance.graphContentHash,
    graphEpoch: provenance.graphEpoch,
    graphRevisionRef: provenance.graphRevisionId,
    inputManifestDigest: provenance.inputManifestSha256,
    manifest, nodeKey: provenance.nodeKey,
    projectId: provenance.projectId, sessionId: provenance.sessionId,
  };
  return { ...bound, recordDigest: deriveFoundationContextRecordDigest(bound) };
}
/**
 * The six binding fields the readback COMPARES against, derived from the PROVENANCE and never
 * from the candidate: deriving both sides from the candidate would make them wrong together,
 * and a mis-mapped record would read back clean.
 */
function expectedFor(provenance: FoundationContextProvenance): FoundationContextExpectedBinding {
  return {
    configurationDigest: provenance.configurationDigest,
    graphContentHash: provenance.graphContentHash,
    graphEpoch: provenance.graphEpoch,
    graphRevisionRef: provenance.graphRevisionId,
    inputManifestDigest: provenance.inputManifestSha256, nodeKey: provenance.nodeKey,
  };
}
export function prepareFoundationContextForLaunch(
  services: FoundationPrelaunchServices,
  request: unknown,
): FoundationPrelaunchResult {
  const assembled = services.context.assembleFoundationContextSelection(request);
  if (!assembled.ok) {
    return refuse("FOUNDATION_PRELAUNCH_SELECTION_REFUSED",
      "the context selection refused", carry(assembled));
  }
  const { provenance } = assembled;
  // The ONLY render in this module. Nothing below re-renders, on any path.
  const rendered = renderContext(assembled.selection);
  if (rendered.manifest.digest !== digestContextManifest(rendered.manifest.binding)) {
    return refuse("FOUNDATION_PRELAUNCH_MANIFEST_UNSEALED",
      "the manifest digest does not cover its binding");
  }
  const candidate = candidateFor(provenance, rendered.manifest);
  if (!exactRoster(candidate)) {
    return refuse("FOUNDATION_PRELAUNCH_RECORD_INEXACT",
      `the record is exactly ${FOUNDATION_CONTEXT_RECORD_KEYS.join(", ")}`);
  }
  const committed = commitFoundationContextManifest(services.ledger,
    { candidate, decidedAt: services.decidedAt });
  if (!committed.ok) {
    return refuse("FOUNDATION_PRELAUNCH_COMMIT_REFUSED",
      "the context manifest did not commit", carry(committed));
  }
  const durable = readFoundationContextManifest(services.readPort, {
    attemptRef: provenance.attemptRef, projectId: provenance.projectId,
    sessionId: provenance.sessionId,
  }, expectedFor(provenance));
  if (!durable.ok) {
    return refuse("FOUNDATION_PRELAUNCH_READBACK_REFUSED",
      "the sealed manifest did not read back", carry(durable));
  }
  // ON THE DURABLE BYTES, which are the ones that reach a provider. A replay hands back bytes
  // this call never rendered, and the codec admits any 0-255 integer array, so NUL-freedom and
  // canonical round-tripping are settled HERE rather than over the local render.
  if (!roundTrips(durable.record.manifest.binding.exactBytes)) {
    return refuse("FOUNDATION_PRELAUNCH_BYTES_UNUSABLE",
      "the durable bytes are empty, NUL-bearing or not canonical UTF-8");
  }
  const brief = produceNodeBrief(services.brief,
    { nodeKey: provenance.nodeKey, projectId: provenance.projectId });
  if (!brief.ok) {
    return refuse("FOUNDATION_PRELAUNCH_MISSION_REFUSED", brief.detail, carry(brief));
  }
  // THE DURABLE BYTES, carried into the producer's typed context slot. `admitRenderedContext`
  // recomputes the digest over this binding and compares the bytes against it, so a record that
  // did not survive the round trip byte-for-byte cannot reach a launch template.
  // FROZEN HERE, not left to `freezeDeep` below: the producer returns a SHALLOWLY frozen record,
  // and `freezeDeep` stops at an already-frozen object, so a slot built unfrozen here would stay
  // writable inside a template a caller was handed as authority.
  const durableContext = Object.freeze({
    bytes: durable.record.manifest.binding.exactBytes, manifest: durable.record.manifest,
  }) as unknown as RenderedContext;
  const template = produceLaunchTemplateFields({
    capabilities: services.capabilities(),
    mission: brief.brief,
    renderedContext: durableContext,
    runtimeObservation: services.observation(),
  });
  if (!template.ok) {
    return refuse("FOUNDATION_PRELAUNCH_TEMPLATE_REFUSED", template.detail, carry(template));
  }
  return freezeDeep({
    bytes: durable.record.manifest.binding.exactBytes,
    ok: true as const,
    record: durable.record,
    template,
  });
}
