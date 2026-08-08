import type { JSX } from "react";

import type { FixtureFact } from "../fixtures.js";
import { FactWithProvenance } from "../shell/provenance-panel.js";

/**
 * J1 node inspector slice (spec §4.5): chipped facts in the identity and phase
 * sections, and nothing more.
 *
 * Attempt detail is deliberately absent. Transcripts exist in exactly one place
 * (§10.5, attempt detail) and are narrative rather than evidence, so no
 * `cr.inspector.transcript.*` element may appear here — asserted by the J1 flow test
 * and depended on by the clean-review firewall (`CR-J2-003`).
 */
export const NODE_INSPECTOR_J1_SECTIONS = ["identity", "phase"] as const;
export type NodeInspectorJ1Section = (typeof NODE_INSPECTOR_J1_SECTIONS)[number];

export interface NodeInspectorJ1Props {
  readonly facts: readonly FixtureFact[];
  readonly nodeId: string;
}

export function NodeInspectorJ1({ facts, nodeId }: NodeInspectorJ1Props): JSX.Element {
  const [identity, ...phase] = facts;
  const bySection: Record<NodeInspectorJ1Section, readonly FixtureFact[]> = {
    identity: identity === undefined ? [] : [identity],
    phase,
  };
  return (
    <section aria-label={`Node ${nodeId}`} data-testid="cr.surface.node">
      {NODE_INSPECTOR_J1_SECTIONS.map((section) => (
        <div data-testid={`cr.inspector.section.${section}`} key={section}>
          {bySection[section].map((fact) => (
            <FactWithProvenance fact={fact} key={fact.factId} />
          ))}
        </div>
      ))}
    </section>
  );
}
