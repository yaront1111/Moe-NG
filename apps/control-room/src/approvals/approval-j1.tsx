import type { RuntimeCommandKind } from "@moe/contracts";
import type { JSX } from "react";

import type { FixtureFact } from "../fixtures.js";
import { ActionBar } from "../shell/frame.js";
import { FactWithProvenance } from "../shell/provenance-panel.js";

/**
 * J1 approval detail (spec §4.7/§4.9) — the two decision points of the Tuesday bug
 * fix: approving the plan, then accepting the output.
 *
 * Each section renders its controls through `ActionBar`, so a decision appears only
 * because the daemon supplied the matching command. When it supplies none, the
 * section renders its context and no control at all — never a disabled placeholder
 * with invented explanatory text (§8.1).
 */
export type ApprovalJ1Kind = "plan" | "acceptance";

/** Which supplied command kind carries each decision. */
const DECISION_COMMAND: Record<ApprovalJ1Kind, RuntimeCommandKind> = {
  acceptance: "integration.accept_output",
  plan: "approval.decide",
};

const DECISION_TITLES: Record<ApprovalJ1Kind, string> = {
  acceptance: "Acceptance — diff, receipt, and review summary",
  plan: "Plan — steps, scope, and oracle",
};

export interface ApprovalJ1Props {
  readonly facts: readonly FixtureFact[];
  readonly kinds: readonly ApprovalJ1Kind[];
}

export function ApprovalJ1({ facts, kinds }: ApprovalJ1Props): JSX.Element {
  return (
    <section aria-label="Approvals" data-testid="cr.surface.approval">
      {facts.map((fact) => (
        <FactWithProvenance fact={fact} key={fact.factId} />
      ))}
      {kinds.map((kind) => (
        <div data-testid={`cr.approvals.detail.${kind}`} key={kind}>
          <h2>{DECISION_TITLES[kind]}</h2>
          <ActionBar kind={DECISION_COMMAND[kind]} />
        </div>
      ))}
    </section>
  );
}
