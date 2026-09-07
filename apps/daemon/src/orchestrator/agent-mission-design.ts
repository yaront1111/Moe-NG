import { DESIGN_SECTION_KEYS } from "../design/design-contracts.js";

/**
 * THE DESIGN PARAGRAPHS EVERY MISSION CARRIES, and the type that makes them unambiguous.
 *
 * WHY A SEPARATE MODULE. Lifted out of `agent-mission-text.ts` when the fourth outcome landed:
 * that file sat at 394 lines against a 400 split threshold, so the branch could not be added
 * where the paragraphs lived. The type and both builders moved VERBATIM - line for line, doc
 * comments included - and the move is proved per line rather than by eye, because these strings
 * are read by a language model and each branch was deliberately phrased so no two share an
 * opening phrase. A paraphrase during a move would silently change what every seat reads.
 *
 * WHY UNREADABLE IS ITS OWN OUTCOME rather than a null or a throw. `agent-wrapper.ts:289,302`
 * read the resolver's answer as `?? null`, and `compilerDesignLines(null)` renders ABSENT - so
 * returning null for a failed read tells every planning seat, in words, that no design exists.
 * Throwing is worse: `failSetup` (agent-wrapper.ts:244-248) funnels the error through
 * `uncoded(...)`, which DISCARDS the refusal's code and layer. The fourth member carries both
 * out to the seat instead, so "the read failed" can never be mistaken for "there is nothing
 * to read".
 */
/**
 * WHAT A MISSION KNOWS ABOUT A GOAL'S DESIGN — FOUR outcomes, and the two that are not
 * PRESENT are the point. The count is stated here because it is the denominator every
 * distinguishability sweep must use; a fifth member added without widening those sweeps
 * is a silently uncovered branch.
 *
 * A seat that simply receives no design section cannot tell "the operator decided to plan
 * without one" from "the read failed", and a seat that cannot tell will guess. Modelling the
 * skip as its own variant rather than as an absent ref is what makes the guess impossible:
 * there is no value of this type that means "no design" ambiguously.
 *
 * SKIPPED mirrors the durable `DesignSkip` marker (design-contracts.ts:122) rather than
 * re-deciding what a skip is, and carries the operator's reason for the same purpose the
 * marker bounds it: an unexplained skip is a decision nobody can review later.
 */
export type DesignBrief =
  | {
    readonly entities: readonly string[];
    readonly outcome: "PRESENT";
    readonly ref: string;
    readonly screens: readonly string[];
  }
  | { readonly outcome: "SKIPPED"; readonly reason: string }
  | { readonly code: string; readonly layer: string; readonly outcome: "UNREADABLE" }
  | { readonly outcome: "ABSENT" };

/**
 * The design paragraph a PLANNING seat reads. Never empty: an omitted paragraph is precisely
 * the ambiguity `DesignBrief` exists to remove, so the ABSENT branch is stated out loud and an
 * unwired caller (`null`) is treated as ABSENT rather than as silence.
 *
 * Each branch is worded to be readable from the BYTES ALONE — no two share a phrase a seat
 * would have to disambiguate — because the only reader is a language model holding one string.
 */
function compilerDesignLines(design: DesignBrief | null): readonly string[] {
  if (design !== null && design.outcome === "PRESENT") {
    return [
      `A DESIGN EXISTS for this goal, submitted under design ref "${design.ref}". Read it with`,
      "design_read, payload {\"goalRef\": \"...\"} and nothing else: it answers the five sections",
      `${DESIGN_SECTION_KEYS.join(", ")} plus openDecisions. Plan the decomposition FROM it -`,
      "every screen and entity it draws must be implemented by some node, and each node's",
      "objective names the screens and entities that node implements.",
    ];
  }
  if (design !== null && design.outcome === "SKIPPED") {
    return [
      "NO DESIGN EXISTS for this goal BECAUSE THE DESIGN STEP WAS SKIPPED: the operator",
      `declared that this goal plans without one, stating "${design.reason}". This is a`,
      "decision, not a missing read - plan from the approved contract and the PRD alone, and",
      "do not wait for a design that is never coming.",
    ];
  }
  if (design !== null && design.outcome === "UNREADABLE") {
    return [
      `THE DESIGN STATE FOR THIS GOAL COULD NOT BE READ: the durable read refused`,
      `${design.code}, answered by the ${design.layer} layer. THAT IS A FAILED READ, NOT A GOAL`,
      "WITHOUT A DESIGN - a submitted design may well exist and simply be unreachable from here,",
      "so do not conclude either way. Call design_read yourself, payload {\"goalRef\": \"...\"}:",
      "if it answers, plan the decomposition from what it gives you; if it refuses as well,",
      "report that refusal code and stop rather than planning around it.",
    ];
  }
  return [
    "NO DESIGN ACCOMPANIES THIS BRIEF, and the operator has not declared that it plans",
    "without one. Plan from the approved contract and the PRD alone; if one was submitted",
    "after you were staffed, design_read with payload {\"goalRef\": \"...\"} answers it.",
  ];
}

/**
 * The design paragraph a CODING seat reads. `null` is the one place it differs from ABSENT:
 * a node step's aggregate is a nodeRef and the wrapper cannot resolve it back to a goal, so a
 * null here means the caller knows nothing — and a claim about the design would be worse than
 * saying nothing at all. An explicit ABSENT is still stated out loud.
 */
function nodeDesignLines(design: DesignBrief | null): readonly string[] {
  if (design === null) return [];
  if (design.outcome === "UNREADABLE") {
    return [
      `The design state for your goal could not be read: the durable read refused ${design.code},`,
      `answered by the ${design.layer} layer. A failed read is not a goal that has no design, so`,
      "claim neither: implement precisely what your task states, cite no screen and no entity,",
      "and record in your report that the design was UNREADABLE rather than missing.",
    ];
  }
  if (design.outcome === "SKIPPED") {
    return [
      `This goal plans WITHOUT a design: the operator declared it, stating "${design.reason}".`,
      "Implement exactly what your task states.",
    ];
  }
  if (design.outcome === "ABSENT") {
    return ["No design accompanies this brief. Implement exactly what your task states."];
  }
  // Listed only when non-empty: an empty list rendered inline reads as a dangling "draws ."
  // that a seat has to interpret, and interpreting is the failure this whole type prevents.
  const drawn = [
    ...(design.screens.length === 0 ? [] : [`screens ${design.screens.join(", ")}`]),
    ...(design.entities.length === 0 ? [] : [`entities ${design.entities.join(", ")}`]),
  ];
  return drawn.length === 0
    ? [
      `The design submitted under "${design.ref}" names no screens or entities yet, so cite`,
      "none: implement exactly what your task states and do not invent a screen the design",
      "does not draw.",
    ]
    : [
      `Your node implements part of the design submitted under "${design.ref}", which draws`,
      `${drawn.join(" and ")}. Name the ones your node implements in your report, and do not`,
      "invent a screen the design does not draw.",
    ];
}

/** Exported at the foot so both declarations above stay byte-identical to their originals. */
export { compilerDesignLines, nodeDesignLines };
