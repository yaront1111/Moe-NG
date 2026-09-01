import { EMDASH } from "../glyphs.js";
import type { ProofRow, ProofPayload } from "../shell/proof-context.js";
import type { SurfaceStep } from "../../live/live-board-feed.js";
import { cardIdentity, columnFor, labelForKind, labelForMissing } from "./work-labels.js";

/**
 * The receipt behind ONE work-board card: the same fields the frame already
 * carried, laid out as the proof inspector's rows. It is the board's only
 * affordance and it is read-only - opening a receipt sends nothing to the daemon
 * and changes nothing on the surface.
 *
 * Every row is a re-statement. SOURCE names the read the card came from, COMMAND
 * / TARGET / STATUS / VERSION are the step's own fields verbatim, and MEANS is
 * this module's plain wording of the status token beside it. Nothing is computed,
 * summed, or inferred, and an absent field renders as an em-dash rather than a
 * zero. The class is OBSERVED: a surface read is the daemon reporting what it
 * holds, not a verification it performed, so DAEMON_VERIFIED would overclaim.
 */

const SOURCE = "POST /affordances/read";

const NOTE = "Every line here is copied from the daemon's answer to this board's "
  + "read. This screen computed none of it, and opening this receipt changes nothing.";

const MINTED = "fresh on every read; the command is one, this id is not durable";

export function receiptFor(step: SurfaceStep): ProofPayload {
  const reading = labelForKind(step.kind);
  const column = columnFor(step.status);
  const rows: ProofRow[] = [
    { k: "SOURCE", v: SOURCE },
    { k: "COMMAND", v: step.kind },
    { k: "TARGET", v: step.aggregateId ?? EMDASH },
    { k: "STATUS", v: step.status },
    { k: "MEANS", v: column.meaning },
    { k: "VERSION", v: step.version === null ? EMDASH : String(step.version) },
  ];
  // On the field, not the kind: a BLOCKED goal.create carries no target at all.
  if (reading.identityPerRead && step.aggregateId !== null) {
    rows.push({ k: "TARGET MINTED", v: MINTED });
  }
  if (step.claim !== null) {
    rows.push({ k: "HELD BY", v: step.claim.claimedBy });
    rows.push({ k: "HOLD EXPIRES", v: step.claim.expiresAt });
  }
  if (step.missing.length > 0) {
    rows.push({ k: "STILL NEEDS", v: step.missing.map(labelForMissing).join(", ") });
    rows.push({ k: "RAW PREREQUISITES", v: step.missing.join(", ") });
  }
  return Object.freeze({
    factId: `board.${cardIdentity(step.kind, step.aggregateId)}`,
    label: reading.label,
    note: NOTE,
    rows: Object.freeze(rows.map((row) => Object.freeze(row))),
    truthClass: "OBSERVED",
    value: column.title,
  });
}
