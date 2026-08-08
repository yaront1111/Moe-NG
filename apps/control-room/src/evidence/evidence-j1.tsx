import type { JSX } from "react";

import type { FixtureFact } from "../fixtures.js";
import { FactWithProvenance } from "../shell/provenance-panel.js";

/**
 * J1 evidence slice (spec §4.11). The J1 acceptance bar requires the result view to
 * show the receipt exit code and both SHAs, so the receipt line renders all three
 * from the supplied record.
 *
 * The exit code is printed as given. A non-zero exit is still displayed as itself —
 * this slice never relabels a failed run as anything softer.
 */
export interface EvidenceJ1Receipt {
  readonly baseSha: string;
  readonly command: string;
  readonly exitCode: number;
  readonly headSha: string;
}

export interface EvidenceJ1Props {
  readonly facts: readonly FixtureFact[];
  readonly receipt: EvidenceJ1Receipt;
}

export function EvidenceJ1({ facts, receipt }: EvidenceJ1Props): JSX.Element {
  return (
    <section aria-label="Evidence" data-testid="cr.surface.evidence">
      {facts.map((fact) => (
        <FactWithProvenance fact={fact} key={fact.factId} />
      ))}
      <div data-testid="cr.evidence.receipt">
        <span data-testid="cr.evidence.receipt.command">{receipt.command}</span>
        <span data-testid="cr.evidence.receipt.exit">exit {receipt.exitCode}</span>
        <span data-testid="cr.evidence.receipt.base">base {receipt.baseSha}</span>
        <span data-testid="cr.evidence.receipt.head">head {receipt.headSha}</span>
      </div>
    </section>
  );
}
