export type TruthClass =
  | "OBSERVED"
  | "AGENT_REPORTED"
  | "DAEMON_VERIFIED"
  | "HUMAN_APPROVED"
  | "UNKNOWN";

export type TruthGlyph = "●" | "💬" | "▣" | "◉" | "◇";

export type TruthShortLabel = "OBS" | "AGT" | "VER" | "HUM" | "UNK";

export type TruthSemanticTone =
  | "neutral slate"
  | "amber"
  | "green"
  | "blue"
  | "high-contrast magenta";

export type TruthBorderStyle = "solid" | "dashed";

export type TruthChipTestId =
  | "cr.chip.observed"
  | "cr.chip.agent_reported"
  | "cr.chip.daemon_verified"
  | "cr.chip.human_approved"
  | "cr.chip.unknown";

export interface TruthPresentationDescriptor {
  readonly truthClass: TruthClass;
  readonly glyph: TruthGlyph;
  readonly shortLabel: TruthShortLabel;
  readonly semanticTone: TruthSemanticTone;
  readonly meaning: string;
  readonly borderStyle: TruthBorderStyle;
  readonly provenanceAffordance: "press Enter for provenance.";
  readonly ariaLabel: string;
  readonly chipTestId: TruthChipTestId;
}

export interface TruthPresentationSuccess {
  readonly ok: true;
  readonly descriptor: TruthPresentationDescriptor;
}

export interface TruthPresentationError {
  readonly code: "TRUTH_CLASS_INVALID";
  readonly message: "Truth class must be a daemon-supplied supported value.";
}

export interface TruthPresentationFailure {
  readonly ok: false;
  readonly error: TruthPresentationError;
}

export type TruthPresentationResult =
  | TruthPresentationSuccess
  | TruthPresentationFailure;

const PROVENANCE_AFFORDANCE = "press Enter for provenance." as const;

function success(
  descriptor: TruthPresentationDescriptor,
): TruthPresentationSuccess {
  return Object.freeze({
    ok: true,
    descriptor: Object.freeze(descriptor),
  });
}

const OBSERVED_RESULT = success({
  truthClass: "OBSERVED",
  glyph: "●",
  shortLabel: "OBS",
  semanticTone: "neutral slate",
  meaning: "Captured directly by Moe or the OS.",
  borderStyle: "solid",
  provenanceAffordance: PROVENANCE_AFFORDANCE,
  ariaLabel:
    "OBSERVED Captured directly by Moe or the OS. press Enter for provenance.",
  chipTestId: "cr.chip.observed",
});

const AGENT_REPORTED_RESULT = success({
  truthClass: "AGENT_REPORTED",
  glyph: "💬",
  shortLabel: "AGT",
  semanticTone: "amber",
  meaning: "Asserted by an agent; not independently verified.",
  borderStyle: "solid",
  provenanceAffordance: PROVENANCE_AFFORDANCE,
  ariaLabel:
    "AGENT_REPORTED Asserted by an agent; not independently verified. press Enter for provenance.",
  chipTestId: "cr.chip.agent_reported",
});

const DAEMON_VERIFIED_RESULT = success({
  truthClass: "DAEMON_VERIFIED",
  glyph: "▣",
  shortLabel: "VER",
  semanticTone: "green",
  meaning: "Produced by Moe's runner with a hash-bound receipt.",
  borderStyle: "solid",
  provenanceAffordance: PROVENANCE_AFFORDANCE,
  ariaLabel:
    "DAEMON_VERIFIED Produced by Moe's runner with a hash-bound receipt. press Enter for provenance.",
  chipTestId: "cr.chip.daemon_verified",
});

const HUMAN_APPROVED_RESULT = success({
  truthClass: "HUMAN_APPROVED",
  glyph: "◉",
  shortLabel: "HUM",
  semanticTone: "blue",
  meaning: "Explicitly accepted by an authenticated human.",
  borderStyle: "solid",
  provenanceAffordance: PROVENANCE_AFFORDANCE,
  ariaLabel:
    "HUMAN_APPROVED Explicitly accepted by an authenticated human. press Enter for provenance.",
  chipTestId: "cr.chip.human_approved",
});

const UNKNOWN_RESULT = success({
  truthClass: "UNKNOWN",
  glyph: "◇",
  shortLabel: "UNK",
  semanticTone: "high-contrast magenta",
  meaning: "Evidence is absent, corrupt, stale, or irreconcilable.",
  borderStyle: "dashed",
  provenanceAffordance: PROVENANCE_AFFORDANCE,
  ariaLabel:
    "UNKNOWN Evidence is absent, corrupt, stale, or irreconcilable. press Enter for provenance.",
  chipTestId: "cr.chip.unknown",
});

const INVALID_RESULT: TruthPresentationFailure = Object.freeze({
  ok: false,
  error: Object.freeze({
    code: "TRUTH_CLASS_INVALID",
    message: "Truth class must be a daemon-supplied supported value.",
  }),
});

/**
 * Maps one daemon-supplied truth-class token to its presentation contract.
 *
 * This function deliberately performs no coercion, property access, inference,
 * aggregation, or fallback. Any value other than one of the five primitive
 * strings receives the same stable fail-closed result.
 */
export function describeTruthClass(input: unknown): TruthPresentationResult {
  switch (input) {
    case "OBSERVED":
      return OBSERVED_RESULT;
    case "AGENT_REPORTED":
      return AGENT_REPORTED_RESULT;
    case "DAEMON_VERIFIED":
      return DAEMON_VERIFIED_RESULT;
    case "HUMAN_APPROVED":
      return HUMAN_APPROVED_RESULT;
    case "UNKNOWN":
      return UNKNOWN_RESULT;
    default:
      return INVALID_RESULT;
  }
}
