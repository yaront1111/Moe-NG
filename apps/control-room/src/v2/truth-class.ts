import { describeTruthClass } from "@moe/control-room-model";
import type { TruthClass } from "@moe/control-room-model";

/**
 * SaysWho - the UI-owned mapping from a daemon truth class to its Cordum
 * presentation (glyph, short label, one-line meaning, tone token, chip border,
 * and which receipt the proof inspector opens).
 *
 * The daemon stays the authority on VALIDITY: `describeTruthClass` decides
 * whether a token is one of the five supported classes, and the kernel-honest
 * distinction between an absent class and a malformed one is preserved. This
 * module only supplies how a resolved class LOOKS in Cordum - it never invents a
 * class, and every colour it names is a token, never a raw hex.
 */

export type CordumBorderStyle = "solid" | "dashed" | "double" | "dotted";
export type CordumReceiptLink = "report" | "receipt" | "decision" | "finding";
export type CordumTruthOrigin = "PRESENT" | "ABSENT" | "INVALID";

export interface CordumTruthPresentation {
  readonly truthClass: TruthClass;
  readonly glyph: string;
  readonly shortLabel: string;
  /** One line an operator can read: the legend copy and the chip aria meaning. */
  readonly name: string;
  /** CSS custom property carrying the tone, e.g. "--cr-truth-observed". */
  readonly toneVar: string;
  readonly borderStyle: CordumBorderStyle;
  /** What the proof inspector offers to open for this class. */
  readonly receiptLink: CordumReceiptLink;
  readonly origin: CordumTruthOrigin;
  readonly provenanceNote: string;
}

/** A payload that omitted the class entirely; never defaulted upward. */
export const CORDUM_ABSENT_NOTE = "class missing from payload";

/** A payload that supplied a class the daemon contract does not define. */
export const CORDUM_INVALID_NOTE =
  "TRUTH_CLASS_INVALID: class present but not a daemon-supplied supported value";

interface CordumTruthVisual {
  readonly glyph: string;
  readonly shortLabel: string;
  readonly name: string;
  readonly toneVar: string;
  readonly borderStyle: CordumBorderStyle;
  readonly receiptLink: CordumReceiptLink;
}

const VISUALS: Readonly<Record<TruthClass, CordumTruthVisual>> = Object.freeze({
  OBSERVED: {
    glyph: "\u25ce", shortLabel: "OBS", name: "Observed by the daemon",
    toneVar: "--cr-truth-observed", borderStyle: "solid", receiptLink: "report",
  },
  AGENT_REPORTED: {
    glyph: "\u25c6", shortLabel: "AGT", name: "Agent reported \u2014 unverified",
    toneVar: "--cr-truth-agent", borderStyle: "dashed", receiptLink: "report",
  },
  DAEMON_VERIFIED: {
    glyph: "\u2713", shortLabel: "VER", name: "Daemon verified",
    toneVar: "--cr-truth-verified", borderStyle: "solid", receiptLink: "receipt",
  },
  HUMAN_APPROVED: {
    glyph: "\u25c8", shortLabel: "HUM", name: "Human decided",
    toneVar: "--cr-truth-human", borderStyle: "double", receiptLink: "decision",
  },
  UNKNOWN: {
    glyph: "?", shortLabel: "UNK", name: "Unknown \u2014 no class supplied",
    toneVar: "--cr-truth-unknown", borderStyle: "dotted", receiptLink: "finding",
  },
});

/** The five classes, in the order the chip legend lists them. */
export const CORDUM_TRUTH_CLASSES: readonly TruthClass[] = Object.freeze([
  "OBSERVED", "AGENT_REPORTED", "DAEMON_VERIFIED", "HUMAN_APPROVED", "UNKNOWN",
]);

function present(
  truthClass: TruthClass,
  origin: CordumTruthOrigin,
  provenanceNote: string,
): CordumTruthPresentation {
  const visual = VISUALS[truthClass];
  return Object.freeze({
    truthClass,
    glyph: visual.glyph,
    shortLabel: visual.shortLabel,
    name: visual.name,
    toneVar: visual.toneVar,
    borderStyle: visual.borderStyle,
    receiptLink: visual.receiptLink,
    origin,
    provenanceNote,
  });
}

/**
 * The Cordum presentation for a class already known to be valid - used by the
 * legend and by any surface that holds a resolved `TruthClass`.
 */
export function cordumTruthPresentation(truthClass: TruthClass): CordumTruthPresentation {
  return present(truthClass, "PRESENT", "");
}

/**
 * Resolve any daemon-supplied token (or its absence) to a Cordum presentation.
 * Absent and malformed both render UNKNOWN but carry different provenance notes,
 * so the two failures never look alike.
 */
export function sayWho(input: unknown): CordumTruthPresentation {
  if (input === undefined || input === null) {
    return present("UNKNOWN", "ABSENT", CORDUM_ABSENT_NOTE);
  }
  const result = describeTruthClass(input);
  if (!result.ok) return present("UNKNOWN", "INVALID", CORDUM_INVALID_NOTE);
  return present(result.descriptor.truthClass, "PRESENT", "");
}
