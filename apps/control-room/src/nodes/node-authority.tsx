import type { JSX, ReactNode } from "react";

import { Fact } from "../kernel.js";
import type { ShellTruthPresentation } from "../kernel.js";

/**
 * Presentation primitives shared by every node and attempt panel.
 *
 * Each panel receives facts the daemon has already projected and already
 * classified. Nothing here computes a hash, a currentness, a readiness, a legal
 * transition, or an evidence strength; a value that was not supplied becomes
 * literal UNKNOWN with an absent truth class rather than a zero or a success.
 */
export interface PresentedFact {
  readonly truthClass?: unknown;
  readonly value: string | null;
}

/** A fact the payload did not supply. Never blank, never zero, never a success. */
export const UNKNOWN_FACT_VALUE = "UNKNOWN";

/** An empty supplied command list is itself a daemon fact, not a missing one. */
export const NO_COMMANDS_SUPPLIED = "No commands supplied by the daemon.";

/** An empty supplied collection, distinct from an unreadable one. */
export const NONE_SUPPLIED = "none";

export type SuppliedFact = PresentedFact | null | undefined;

export type ProvenanceHandler = (factId: string, shown: ShellTruthPresentation) => void;

function readValue(fact: SuppliedFact): string | null {
  if (fact === null || fact === undefined) {
    return null;
  }
  const { value } = fact;
  return typeof value === "string" && value !== "" ? value : null;
}

/** Whether the payload supplied a usable value for this fact. */
export function isSupplied(fact: SuppliedFact): boolean {
  return readValue(fact) !== null;
}

/** A supplied identity, or the UNKNOWN marker when the payload omitted one. */
export function readIdentity(identity: string): string {
  return typeof identity === "string" && identity !== "" ? identity : UNKNOWN_FACT_VALUE;
}

export interface FactRowProps {
  /** Surface-specific copy for an absent value; the chip still reads UNKNOWN. */
  readonly absentValue?: string;
  readonly fact: SuppliedFact;
  readonly factId: string;
  readonly label: string;
  readonly onProvenance?: ProvenanceHandler | undefined;
}

/**
 * The only way a panel renders a claim. The class travels with the value, so a
 * fact cannot be shown without its chip, and a withdrawn value cannot keep the
 * class its previous payload carried.
 */
export function FactRow(props: FactRowProps): JSX.Element {
  const { absentValue, fact, factId, label, onProvenance } = props;
  const supplied = readValue(fact);
  return (
    <Fact
      factId={factId}
      label={label}
      onProvenance={
        onProvenance === undefined ? undefined : (shown) => onProvenance(factId, shown)
      }
      truthClass={supplied === null ? undefined : fact?.truthClass}
      value={supplied ?? absentValue ?? UNKNOWN_FACT_VALUE}
    />
  );
}

export type FactRowSpec = readonly [factId: string, label: string, fact: SuppliedFact];

export function FactList(props: {
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly rows: readonly FactRowSpec[];
}): JSX.Element {
  const { onProvenance, rows } = props;
  return (
    <div>
      {rows.map(([factId, label, fact]) => (
        <FactRow
          fact={fact}
          factId={factId}
          key={factId}
          label={label}
          onProvenance={onProvenance}
        />
      ))}
    </div>
  );
}

export function Panel(props: {
  readonly children: ReactNode;
  readonly heading: string;
  readonly testId: string;
}): JSX.Element {
  const { children, heading, testId } = props;
  return (
    <section data-testid={testId}>
      <h3>{heading}</h3>
      {children}
    </section>
  );
}

/**
 * Lists the command kinds the daemon said are legal here, as labels rather than
 * controls: this module holds no mutation handler, so it must not imply one. The
 * list is never widened from a phase, a lifecycle enum, or a transition table.
 */
export function CommandKindList(props: {
  readonly commandKinds: readonly string[];
  readonly testId: string;
}): JSX.Element {
  const { commandKinds, testId } = props;
  if (commandKinds.length === 0) {
    return <p data-testid={testId}>{NO_COMMANDS_SUPPLIED}</p>;
  }
  return (
    <ul data-testid={testId}>
      {commandKinds.map((kind) => (
        <li data-testid={`cr.action.${kind.replaceAll(".", "-")}`} key={kind}>
          {kind}
        </li>
      ))}
    </ul>
  );
}

export interface NodeIdentityFacts {
  readonly acceptanceCriteria: SuppliedFact;
  readonly nodeAuthorityHash: SuppliedFact;
  readonly nodeId: SuppliedFact;
  readonly objective: SuppliedFact;
  readonly writeScope: SuppliedFact;
}

export interface NodePhaseFacts {
  readonly phase: SuppliedFact;
  readonly reopenCount: SuppliedFact;
}

/** Lease presentation carries no token, credential, or session secret by design. */
export interface NodeLeaseFacts {
  readonly activitySilence: SuppliedFact;
  readonly epoch: SuppliedFact;
  readonly expiry: SuppliedFact;
  readonly principal: SuppliedFact;
  readonly renewalSilence: SuppliedFact;
}

export interface NodePlanFacts {
  readonly approvalHash: SuppliedFact;
  readonly approvalValidity: SuppliedFact;
  readonly planHash: SuppliedFact;
  readonly planRevision: SuppliedFact;
}

export interface NodeAuthorityProps {
  readonly identity: NodeIdentityFacts;
  readonly lease: NodeLeaseFacts;
  readonly legalCommandKinds: readonly string[];
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly phase: NodePhaseFacts;
  readonly plan: NodePlanFacts;
}

/**
 * Node identity, phase, lease, and plan binding as the daemon projected them.
 *
 * Renewal silence and activity silence stay separate facts: a worker that renews
 * its lease while doing nothing is the case both a merged datum and an inferred
 * "healthy" badge would hide.
 */
export function NodeAuthority(props: NodeAuthorityProps): JSX.Element {
  const { identity, lease, legalCommandKinds, onProvenance, phase, plan } = props;
  return (
    <div data-testid="cr.inspector.authority">
      <Panel heading="Identity" testId="cr.inspector.section.identity">
        <FactList
          onProvenance={onProvenance}
          rows={[
            ["node.id", "Node", identity.nodeId],
            ["node.objective", "Objective", identity.objective],
            ["node.criteria", "Acceptance criteria", identity.acceptanceCriteria],
            ["node.writescope", "Write scope", identity.writeScope],
            ["node.authorityhash", "Node authority hash", identity.nodeAuthorityHash],
          ]}
        />
      </Panel>
      <Panel heading="Phase" testId="cr.inspector.section.phase">
        <FactList onProvenance={onProvenance} rows={[["node.phase", "Phase", phase.phase]]} />
        <div data-testid="cr.inspector.loopcounter">
          <FactList
            onProvenance={onProvenance}
            rows={[["node.reopencount", "Reopen loop", phase.reopenCount]]}
          />
        </div>
        <CommandKindList
          commandKinds={legalCommandKinds}
          testId="cr.inspector.legalcommands"
        />
      </Panel>
      <Panel heading="Lease" testId="cr.inspector.section.lease">
        <FactList
          onProvenance={onProvenance}
          rows={[
            ["node.lease.principal", "Principal", lease.principal],
            ["node.lease.epoch", "Epoch", lease.epoch],
            ["node.lease.expiry", "Expires", lease.expiry],
            ["node.lease.renewalsilence", "Renewal silence", lease.renewalSilence],
            ["node.lease.activitysilence", "Activity silence", lease.activitySilence],
          ]}
        />
      </Panel>
      <Panel heading="Plan binding" testId="cr.inspector.section.plan">
        <FactList
          onProvenance={onProvenance}
          rows={[
            ["node.plan.revision", "Plan revision", plan.planRevision],
            ["node.plan.hash", "Plan hash", plan.planHash],
            ["node.plan.approvalhash", "Approval hash", plan.approvalHash],
            ["node.plan.validity", "Approval validity", plan.approvalValidity],
          ]}
        />
      </Panel>
    </div>
  );
}
