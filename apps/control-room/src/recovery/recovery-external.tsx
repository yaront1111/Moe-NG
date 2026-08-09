import type { JSX } from "react";

import { FactRow, Panel } from "../nodes/node-authority.js";
import type { ProvenanceHandler, SuppliedFact } from "../nodes/node-authority.js";

/**
 * Post-restore external inventory (design 978, CORE-I22).
 *
 * Before a restored project may schedule anything, every configured effect class must
 * supply a complete enumeration or a negative proof over the recovery window. This
 * surface renders those proofs; it computes none of them. In particular an empty item
 * list is never rendered as completeness — "nothing was found" and "nothing exists"
 * are different claims, and only the daemon's coverage proof can tell them apart.
 */
export const RECOVERY_INVENTORY_CLASSES = [
  "workspaces", "effect-locks", "provider-runs", "resources", "branches-refs",
  "integration-targets", "artifact-staging",
] as const;

export type RecoveryInventoryClassId = (typeof RECOVERY_INVENTORY_CLASSES)[number];

const CLASS_LABELS: Readonly<Record<RecoveryInventoryClassId, string>> = {
  "artifact-staging": "Artifact staging",
  "branches-refs": "Branches and refs",
  "effect-locks": "Effect locks and wrapper registrations",
  "integration-targets": "Integration targets",
  "provider-runs": "Provider runs",
  resources: "Resources",
  workspaces: "Workspaces",
};

const EMPTY_COPY = "No items were listed for this class. An empty list is not a "
  + "completeness proof.";

export interface RecoveryInventoryItemPresentation {
  /** Absent, cancelled, adopted to a restored intent, or quarantined — as supplied. */
  readonly disposition: SuppliedFact;
  readonly identity: SuppliedFact;
  readonly itemId: string;
}

export interface RecoveryInventoryClassPresentation {
  readonly blindSpots: readonly SuppliedFact[];
  readonly classId: RecoveryInventoryClassId;
  readonly completeness: SuppliedFact;
  readonly coverageWindow: SuppliedFact;
  readonly items: readonly RecoveryInventoryItemPresentation[];
}

export interface RecoveryExternalInventoryProps {
  readonly classes: readonly RecoveryInventoryClassPresentation[];
  readonly onProvenance?: ProvenanceHandler | undefined;
}

function BlindSpots(props: {
  readonly blindSpots: readonly SuppliedFact[];
  readonly classId: RecoveryInventoryClassId;
  readonly onProvenance?: ProvenanceHandler | undefined;
}): JSX.Element {
  const { blindSpots, classId, onProvenance } = props;
  if (blindSpots.length === 0) {
    return (
      <FactRow fact={null} factId={`recovery.inventory.${classId}.blindspot`}
        label="Declared blind spots" onProvenance={onProvenance} />
    );
  }
  return (
    <div>
      {blindSpots.map((fact, index) => (
        <FactRow fact={fact} factId={`recovery.inventory.${classId}.blindspot.${index}`}
          key={`${classId}#${index}`} label={`Blind spot ${index + 1}`}
          onProvenance={onProvenance} />
      ))}
    </div>
  );
}

function InventoryItems(props: {
  readonly classId: RecoveryInventoryClassId;
  readonly items: readonly RecoveryInventoryItemPresentation[];
  readonly onProvenance?: ProvenanceHandler | undefined;
}): JSX.Element {
  const { classId, items, onProvenance } = props;
  if (items.length === 0) {
    return <p data-testid={`cr.health.inventory.${classId}.empty`}>{EMPTY_COPY}</p>;
  }
  return (
    <ul data-testid={`cr.health.inventory.${classId}.items`}>
      {items.map((item, index) => (
        <li key={`${item.itemId}#${index}`}>
          <FactRow fact={item.identity}
            factId={`recovery.inventory.${classId}.item.${item.itemId}.identity`}
            label="Item" onProvenance={onProvenance} />
          <FactRow fact={item.disposition}
            factId={`recovery.inventory.${classId}.item.${item.itemId}.disposition`}
            label="Disposition" onProvenance={onProvenance} />
        </li>
      ))}
    </ul>
  );
}

function InventoryClass(props: {
  readonly entry: RecoveryInventoryClassPresentation;
  readonly onProvenance?: ProvenanceHandler | undefined;
}): JSX.Element {
  const { entry, onProvenance } = props;
  const { classId } = entry;
  return (
    <div data-inventory-class={classId} data-testid={`cr.health.inventory.${classId}`}>
      <h4 data-testid="cr.health.inventory.label">{CLASS_LABELS[classId]}</h4>
      <FactRow fact={entry.coverageWindow} factId={`recovery.inventory.${classId}.coverage`}
        label="Coverage window" onProvenance={onProvenance} />
      <FactRow fact={entry.completeness}
        factId={`recovery.inventory.${classId}.completeness`}
        label="Enumeration completeness" onProvenance={onProvenance} />
      <InventoryItems classId={classId} items={entry.items} onProvenance={onProvenance} />
      <BlindSpots blindSpots={entry.blindSpots} classId={classId}
        onProvenance={onProvenance} />
    </div>
  );
}

export function RecoveryExternalInventory(props: RecoveryExternalInventoryProps): JSX.Element {
  const { classes, onProvenance } = props;
  return (
    <Panel heading="Post-restore external inventory" testId="cr.health.inventory">
      {classes.map((entry, index) => (
        <InventoryClass entry={entry} key={`${entry.classId}#${index}`}
          onProvenance={onProvenance} />
      ))}
    </Panel>
  );
}
