import type { JSX } from "react";

import { CommandKindList, FactList, Panel } from "./node-authority.js";
import type { ProvenanceHandler, SuppliedFact } from "./node-authority.js";

/**
 * Which graph revision this work started against and which binding is current.
 *
 * Carry-forward keeps an attempt's immutable source identity while a new binding
 * supplies current fencing, so these are four separate facts. Collapsing them
 * would let a rebound node read as if it had been re-executed.
 */
export interface NodeBindingFacts {
  readonly bindingVersion: SuppliedFact;
  readonly graphEpoch: SuppliedFact;
  readonly inputBindingHash: SuppliedFact;
  readonly startedRevision: SuppliedFact;
}

export interface NodeManifestFacts {
  readonly manifestDigest: SuppliedFact;
  readonly tree: SuppliedFact;
}

/** The rendered context bytes and the adapter's observation of what it submitted. */
export interface NodeWorkerContextFacts {
  readonly contextDigest: SuppliedFact;
  readonly providerInputDigest: SuppliedFact;
}

export interface NodeCoverageFacts {
  readonly bytes: SuppliedFact;
  readonly tokens: SuppliedFact;
}

/** Recovery state and its commands are supplied by the daemon, never inferred. */
export interface NodeRecoveryFacts {
  readonly commandKinds: readonly string[];
  readonly reason: SuppliedFact;
  readonly state: SuppliedFact;
}

export interface NodeContextProps {
  readonly binding: NodeBindingFacts;
  readonly coverage: NodeCoverageFacts;
  readonly input: NodeManifestFacts;
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly recovery: NodeRecoveryFacts;
  readonly result: NodeManifestFacts;
  readonly workerContext: NodeWorkerContextFacts;
}

/**
 * Input, result, and context identity for one node.
 *
 * Every digest is displayed exactly as supplied. This module compares no hashes,
 * decides no currentness, and derives no recovery route; an unsupplied digest or
 * measurement renders UNKNOWN rather than zero, verified, current, or successful.
 */
export function NodeContext(props: NodeContextProps): JSX.Element {
  const { binding, coverage, input, onProvenance, recovery, result, workerContext } = props;
  return (
    <div data-testid="cr.inspector.context">
      <Panel heading="Authority binding" testId="cr.inspector.section.binding">
        <FactList
          onProvenance={onProvenance}
          rows={[
            ["node.binding.startedrevision", "Started revision", binding.startedRevision],
            ["node.binding.graphepoch", "Graph epoch", binding.graphEpoch],
            ["node.binding.version", "Binding version", binding.bindingVersion],
            ["node.binding.inputbindinghash", "Input binding hash", binding.inputBindingHash],
          ]}
        />
      </Panel>
      <Panel heading="Input" testId="cr.inspector.section.input">
        <FactList
          onProvenance={onProvenance}
          rows={[
            ["node.input.manifestdigest", "Input manifest digest", input.manifestDigest],
            ["node.input.tree", "Input tree", input.tree],
          ]}
        />
      </Panel>
      <Panel heading="Result" testId="cr.inspector.section.result">
        <FactList
          onProvenance={onProvenance}
          rows={[
            ["node.result.manifestdigest", "Result manifest digest", result.manifestDigest],
            ["node.result.tree", "Result tree", result.tree],
          ]}
        />
      </Panel>
      <Panel heading="Worker context" testId="cr.inspector.section.context">
        <FactList
          onProvenance={onProvenance}
          rows={[
            ["node.context.digest", "Context digest", workerContext.contextDigest],
            [
              "node.context.providerinputdigest",
              "Provider input digest",
              workerContext.providerInputDigest,
            ],
            ["node.coverage.tokens", "Token coverage", coverage.tokens],
            ["node.coverage.bytes", "Byte coverage", coverage.bytes],
          ]}
        />
      </Panel>
      <Panel heading="Recovery" testId="cr.inspector.section.recovery">
        <FactList
          onProvenance={onProvenance}
          rows={[
            ["node.recovery.state", "Recovery state", recovery.state],
            ["node.recovery.reason", "Recovery reason", recovery.reason],
          ]}
        />
        <CommandKindList
          commandKinds={recovery.commandKinds}
          testId="cr.inspector.recoverycommands"
        />
      </Panel>
    </div>
  );
}
