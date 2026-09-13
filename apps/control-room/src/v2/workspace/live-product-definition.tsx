import { useMemo } from "react";
import type { JSX } from "react";
import { sameProductContract } from "@moe/control-room-model";
import type { ProductContractRef } from "@moe/control-room-model";
import type { LiveSetup } from "../../live/live-config.js";
import { Gate1Card } from "../goals/gate1-card.js";
import { createGate1ApprovalPort, readPendingContract } from "../goals/gate1-approval.js";
import type { Gate1ReadOutcome } from "../goals/gate1-approval.js";
import { Gate1CardV1 } from "../goals/gate1-v1-card.js";
import { createGate1ApprovalPortV1, readPendingContractV1 } from "../goals/gate1-v1-approval.js";
import type { Gate1ReadOutcomeV1 } from "../goals/gate1-v1-approval.js";
import type { GoalSourceOutcome } from "../../live/live-goal-source.js";

const CHANGED = Object.freeze({ status: "REFUSED", code: "VIEWED_DEFINITION_CHANGED", layer: "CONTROL_ROOM_PRODUCT" } as const);
const READ_ONLY = Object.freeze({ ok: false, code: "VIEWED_DEFINITION_NOT_CURRENT", layer: "CONTROL_ROOM_PRODUCT" } as const);
interface DecisionObservation { accepted: boolean; readOnly: boolean }

function decisionPort<P, A extends unknown[], R extends { readonly ok: boolean }>(
  port: { readonly submit: (pending: P) => Promise<R>; readonly answer: (...args: A) => Promise<R> },
  observation: DecisionObservation,
) {
  return {
    answer: (...args: A) => observation.readOnly ? Promise.resolve(READ_ONLY) : port.answer(...args),
    submit: async (pending: P) => {
      if (observation.readOnly) return READ_ONLY;
      const outcome = await port.submit(pending);
      if (outcome.ok) observation.accepted = true;
      return outcome;
    },
  };
}

/** Current read routes cannot substitute another revision for the artifact being inspected. */
function viewed<T extends Gate1ReadOutcome | Gate1ReadOutcomeV1>(
  outcome: T, plane: ProductContractRef["plane"], expected: ProductContractRef | null, accepted: boolean,
): T | typeof CHANGED {
  if (expected === null) return outcome;
  // NONE can acknowledge this instance's accepted command; it never establishes another revision.
  if (expected.plane !== plane || outcome.status === "NONE" && !accepted) return CHANGED;
  if ((outcome.status === "PENDING" || outcome.status === "CURRENT")
    && !sameProductContract(expected, { plane, contractId: outcome.contractId,
      revisionId: outcome.revisionId, revisionDigest: outcome.revisionDigest })) return CHANGED;
  return outcome;
}

export function LiveProductDefinition({ setup, goalId, source, expectedRef = null, readOnly = false }: {
  readonly setup: LiveSetup; readonly goalId: string; readonly source: GoalSourceOutcome | null;
  readonly expectedRef?: ProductContractRef | null;
  readonly readOnly?: boolean;
}): JSX.Element {
  // Comparing fields keeps a freshly composed equivalent model from restarting the card.
  const selected = useMemo(() => expectedRef === null ? null : Object.freeze({ ...expectedRef }),
    [expectedRef?.plane, expectedRef?.contractId, expectedRef?.revisionId, expectedRef?.revisionDigest]);
  const identity = useMemo(() => crypto.randomUUID(), [setup, goalId, selected]);
  const observation = useMemo<DecisionObservation>(() => ({ accepted: false, readOnly: false }), [identity]);
  observation.readOnly = readOnly;
  const v2Read = useMemo(() => async (goal: string) => setup.projectId === null
    ? Promise.resolve({ status: "ERROR", code: "PROJECT_BINDING_ABSENT", layer: "CONTROL_ROOM_PRODUCT" } as const)
    : viewed(await readPendingContract(setup.headers, goal, setup.projectId), "V2", selected, observation.accepted), [setup, selected, observation]);
  const v1Read = useMemo(() => async (goal: string) => viewed(await readPendingContractV1(setup.headers, goal), "V1", selected, observation.accepted), [setup, selected, observation]);
  const v2Port = useMemo(() => decisionPort(createGate1ApprovalPort(setup), observation), [setup, observation]);
  const v1Port = useMemo(() => decisionPort(createGate1ApprovalPortV1(setup), observation), [setup, observation]);
  return <article><p className="cr-product-kind">Product definition</p><h2>What we&apos;re making</h2>
    <p>{selected === null ? "Review the current product proposal. Any decision below applies to the definition shown."
      : "Review the selected definition. A different current proposal cannot be approved from this version."}</p>
    {readOnly ? <p role="status">This saved definition is read-only. Any decision already sent remains visible below.</p> : null}
    <fieldset disabled={readOnly} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      <legend className="cr2-visually-hidden">Definition decision</legend>
      {setup.commandAuthorityPlane === "V2" ? <Gate1Card key={identity} goalId={goalId} port={v2Port} read={v2Read} />
        : <Gate1CardV1 key={identity} goalId={goalId} port={v1Port} read={v1Read} />}
    </fieldset>
    {source?.status === "GOAL_SOURCE" ? <section className="cr-product-source"><h3>Your original specification</h3>
      <p>{source.displayPath}</p><pre>{source.text}</pre></section>
      : <p className="cr-product-note">{source === null ? "Reading your original specification…"
        : source.code === "GOAL_SOURCE_UNBOUND" ? "This existing work has no original PRD attached. Its recorded work remains available in the production record."
        : "Your original specification could not be read right now."}</p>}
  </article>;
}
