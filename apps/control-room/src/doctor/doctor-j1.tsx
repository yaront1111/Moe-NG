import type { JSX } from "react";

import type { FixtureFact } from "../fixtures.js";
import { FactWithProvenance } from "../shell/provenance-panel.js";

/**
 * J1 doctor slice (spec §4.14): the `cr.health.status` summary only.
 *
 * The reconciliation queue, outbox rows, version table, and offline doctor harness
 * belong to the health surface task that builds over this file. Nothing here offers
 * an action, which is also what `CR-DOC-001` expects of doctor mode.
 */
export interface DoctorJ1Props {
  readonly facts: readonly FixtureFact[];
}

export function DoctorJ1({ facts }: DoctorJ1Props): JSX.Element {
  return (
    <section aria-label="Health" data-testid="cr.surface.doctor">
      <div data-testid="cr.health.status">
        <h2>Daemon health</h2>
        {facts.map((fact) => (
          <FactWithProvenance fact={fact} key={fact.factId} />
        ))}
      </div>
    </section>
  );
}
