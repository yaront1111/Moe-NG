/**
 * THE SERVER-DERIVED FOUNDATION CONTEXT SELECTION (design section 14.2).
 *
 * A caller hands over IDENTITY and nothing else — `{attemptRef, nodeKey, projectId, sessionId}`,
 * exactly four DATA properties. Items, sections, priorities, exclusions, ordering, graph or
 * configuration bytes and the byte budget are UNREPRESENTABLE on this surface, so no request can
 * propose the context it is then judged against. The matrix projection lives in
 * `foundation-context-matrix.ts`; this module owns admission, the snapshot fence, the budget and
 * the provenance.
 *
 * ONE SNAPSHOT, FENCED AT BOTH ENDS. The store's event horizon is taken before the first read and
 * again after the last; a horizon that moved refuses, because a selection stitched from two
 * ledgers would be authority over a state that never existed.
 *
 * THE BUDGET IS THE PROVIDER'S, NEVER OURS. Only `CONSERVATIVE_INPUT_BYTES.bytes` becomes a byte
 * budget; `UNKNOWN` and `EXACT_TOKENS` refuse in the matrix reader. This daemon owns no
 * tokenizer, and a default, a capture ceiling or a token-to-byte guess is an invented bound
 * wearing durable clothes.
 *
 * REFUSALS KEEP THEIR AUTHOR: a reader's verdict travels whole under `source`, and `@moe/context`'s
 * `INVALID_CONTEXT_BUDGET` / `CONTEXT_TOO_LARGE` keep their code AND their `CONTEXT_SELECTION`
 * layer rather than being restamped. No partial selection is ever returned.
 *
 * CONSUMER: task-203a5ca7aada4375a98a95df8773e249.
 */
import { selectContext } from "@moe/context";
import type { AdmittedContextSelection } from "@moe/context";
import type { SqliteEventStore } from "@moe/store";

import {
  FOUNDATION_CONTEXT_MATRIX_VERSION, freezeDeep, readFoundationContextFacts, refuse,
} from "./foundation-context-matrix.js";
import type {
  FoundationContextFacts, FoundationContextIdentity, FoundationContextRefused,
} from "./foundation-context-matrix.js";

export {
  FINDINGS_ITEM_ID, FOUNDATION_CONTEXT_MATRIX_VERSION, FOUNDATION_CONTEXT_SELECTION_CODES,
  JOURNAL_ITEM_ID,
} from "./foundation-context-matrix.js";
export type {
  FoundationContextIdentity, FoundationContextLayer, FoundationContextRefused,
  FoundationContextSelectionCode,
} from "./foundation-context-matrix.js";

export interface FoundationContextProvenance {
  readonly attemptRef: string; readonly configurationDigest: string;
  readonly contextLimitBytes: number; readonly graphContentHash: string;
  readonly graphEpoch: number; readonly graphRevisionId: string;
  readonly inputManifestSha256: string;
  /** `null` when the attempt journal is an explicit recorded absence — never `""`. */
  readonly journalDigest: string | null;
  /** The ONE durable horizon the whole selection, journal included, was read under. */
  readonly journalHorizon: string;
  readonly matrixVersion: typeof FOUNDATION_CONTEXT_MATRIX_VERSION;
  readonly nodeKey: string; readonly projectId: string; readonly sessionId: string;
}
export interface FoundationContextAdmitted {
  readonly ok: true; readonly provenance: FoundationContextProvenance;
  readonly selection: AdmittedContextSelection;
}
export type FoundationContextSelectionResult = FoundationContextAdmitted | FoundationContextRefused;
export interface FoundationContextAuthority {
  assembleFoundationContextSelection(input: unknown): FoundationContextSelectionResult;
}
export interface FoundationContextAuthorityConfig {
  /** From a successful production `selectProjectConfiguration(...).manifest.settingsDigest`. */
  readonly expectedConfigurationDigest: string;
  readonly store: SqliteEventStore;
}

const HEX64 = /^[0-9a-f]{64}$/u;
const REQUEST_KEYS = Object.freeze(["attemptRef", "nodeKey", "projectId", "sessionId"] as const);
const MAX_REQUEST_TEXT = 512;

/** Four DATA properties, no more and no fewer. A getter, a symbol key or an extra property is
 *  refused rather than ignored: an accessor could answer differently on a second look, and an
 *  ignored extra key is exactly how a caller smuggles content past an identity-only surface. */
function admitRequest(input: unknown): FoundationContextIdentity | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  let names: readonly string[];
  try {
    if (Object.getOwnPropertySymbols(input).length > 0) return null;
    names = Object.getOwnPropertyNames(input);
  } catch { return null; }
  if (names.length !== REQUEST_KEYS.length) return null;
  const admitted: Record<string, string> = {};
  for (const key of REQUEST_KEYS) {
    const held = Object.getOwnPropertyDescriptor(input, key);
    if (held === undefined || !("value" in held)) return null;
    const { value } = held;
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_REQUEST_TEXT) {
      return null;
    }
    admitted[key] = value;
  }
  return Object.freeze(admitted) as unknown as FoundationContextIdentity;
}

function assemble(
  config: FoundationContextAuthorityConfig, input: unknown,
): FoundationContextSelectionResult {
  if (!HEX64.test(config.expectedConfigurationDigest)) {
    return refuse("FOUNDATION_CONTEXT_CONFIGURATION_BINDING_INVALID", "binding is not a digest");
  }
  const id = admitRequest(input);
  if (id === null) {
    return refuse("FOUNDATION_CONTEXT_REQUEST_INVALID", "request is not a four-key identity");
  }
  let facts: FoundationContextFacts | FoundationContextRefused;
  let horizon: bigint;
  let settled: bigint;
  try {
    horizon = config.store.readEventHorizon();
    facts = readFoundationContextFacts(
      config.store, config.expectedConfigurationDigest, id, horizon);
    settled = config.store.readEventHorizon();
  } catch {
    return refuse("FOUNDATION_CONTEXT_STORE_UNAVAILABLE", "the durable store could not be read");
  }
  if ("ok" in facts) return facts;
  if (settled !== horizon) {
    return refuse("FOUNDATION_CONTEXT_SNAPSHOT_MOVED", "the durable ledger moved mid-read");
  }
  const selected = selectContext({
    byteBudget: facts.bytes, exclusions: facts.exclusions,
    mandatory: facts.mandatory, optional: facts.optional,
  });
  // The selector's own vocabulary, unflattened: its code AND its layer, so a caller can tell a
  // budget verdict from a composition verdict without reading this module's source.
  if (selected.kind !== "ADMITTED") {
    return refuse(selected.code, "the context selector refused", null, selected.layer);
  }
  return Object.freeze({
    ok: true as const,
    provenance: freezeDeep({
      attemptRef: id.attemptRef, configurationDigest: config.expectedConfigurationDigest,
      contextLimitBytes: facts.bytes, graphContentHash: facts.revision.hash,
      graphEpoch: facts.revision.epoch, graphRevisionId: facts.revision.id,
      inputManifestSha256: facts.manifestSha256, journalDigest: facts.journalDigest,
      journalHorizon: String(horizon), matrixVersion: FOUNDATION_CONTEXT_MATRIX_VERSION,
      nodeKey: id.nodeKey, projectId: id.projectId, sessionId: id.sessionId,
    }),
    selection: selected.selection,
  });
}

/**
 * Bind a server to its store and its accepted configuration digest ONCE. That digest is a
 * construction-time server fact taken from a successful `selectProjectConfiguration` — never a
 * fifth request field, which is exactly how a caller would otherwise choose its own provider.
 */
export function createFoundationContextAuthority(
  config: FoundationContextAuthorityConfig,
): FoundationContextAuthority {
  const bound = Object.freeze({ ...config });
  return Object.freeze({
    assembleFoundationContextSelection: (input: unknown): FoundationContextSelectionResult =>
      assemble(bound, input),
  });
}
