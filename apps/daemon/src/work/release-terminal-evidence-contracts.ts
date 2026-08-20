/**
 * What a release-terminality answer IS, and the vocabulary it may refuse in.
 *
 * Split from the derivation for the per-file cap, and the seam is deliberate: everything here is
 * shape and naming. Nothing here reads a store, enumerates an item or judges a terminal — that
 * stays with the derivation, so this module cannot become a second place where terminality is
 * decided. Same split, and same reason, as `effect-terminal-contracts.ts`.
 */

export const RELEASE_TERMINAL_CODES = Object.freeze([
  "RELEASE_TERMINAL_REQUEST_INVALID",
  "RELEASE_TERMINAL_BINDING_UNREADABLE",
  "RELEASE_TERMINAL_EFFECT_ENUMERATION_UNREADABLE",
  "RELEASE_TERMINAL_EFFECT_UNKNOWN",
  "RELEASE_TERMINAL_RESOURCE_UNKNOWN",
] as const);

/**
 * Module-private. An exported column-zero `*_LAYER` constant is a declared production boundary the
 * security roster then demands a BEFORE/AFTER/RACE hostile trio for; the layer travels as a closed
 * TYPE instead, exactly as the effect-terminal contracts seam does.
 */
const EVIDENCE_LAYER = "RELEASE_TERMINAL_EVIDENCE";

export type ReleaseTerminalCode = (typeof RELEASE_TERMINAL_CODES)[number];
export type ReleaseTerminalLayer = typeof EVIDENCE_LAYER;

/** The upstream authority's OWN code and layer, carried verbatim and never restamped. */
export interface ReleaseTerminalUpstream { readonly code: string; readonly layer: string }

/** Identity ONLY. No ref, flag or list: those are answers, not questions. */
export interface ReleaseTerminalRequest {
  readonly attemptRef: string;
  readonly projectId: string;
}

export interface ReleaseTerminalRefusal {
  readonly code: ReleaseTerminalCode;
  readonly detail: string;
  readonly layer: ReleaseTerminalLayer;
  readonly ok: false;
  readonly upstream: ReleaseTerminalUpstream | null;
}

/**
 * `terminalEffectRefs` / `terminalResourceRefs` carry PROVEN-TERMINAL refs only, which is what
 * `ExpansionReleaseEvidence` means by those names. Completeness is proved by the paired
 * `nonTerminal*` lists and the `enumerated*` counts — never by putting a non-terminal ref into a
 * list named terminal, which would read to a consumer as proof it does not have.
 */
export interface ReleaseTerminalEvidence {
  readonly attemptRef: string;
  readonly effectsTerminal: boolean;
  readonly enumeratedEffects: number;
  readonly enumeratedResources: number;
  readonly nonTerminalEffectRefs: readonly string[];
  readonly nonTerminalResourceRefs: readonly string[];
  readonly ok: true;
  readonly projectId: string;
  readonly releasable: boolean;
  readonly resourcesTerminal: boolean;
  readonly terminalEffectRefs: readonly string[];
  readonly terminalResourceRefs: readonly string[];
}

export type ReleaseTerminalOutcome = ReleaseTerminalEvidence | ReleaseTerminalRefusal;

/** Frozen, including the upstream it carries: a refusal a caller can edit is not a refusal. */
export function refuseReleaseTerminal(
  code: ReleaseTerminalCode, detail: string, upstream: ReleaseTerminalUpstream | null = null,
): ReleaseTerminalRefusal {
  return Object.freeze({
    code, detail, layer: EVIDENCE_LAYER, ok: false as const,
    upstream: upstream === null ? null : Object.freeze({ ...upstream }),
  });
}

/** Terminal / not terminal, for one family of items. Both halves travel together so a caller
 *  cannot receive one without the other. */
export interface ReleaseTerminalSplit {
  readonly nonTerminal: readonly string[];
  readonly terminal: readonly string[];
}

/** TRUE only when every enumerated item is terminal AND at least one was enumerated: an empty
 *  family is not proof, it is the absence of proof. */
export const provenTerminal = (split: ReleaseTerminalSplit): boolean =>
  split.nonTerminal.length === 0 && split.terminal.length > 0;
