import type { SqliteEventStore } from "@moe/store";

import { agentProviderFact, resolveAgentProvider } from "../orchestrator/agent-provider-resolve.js";
import { readProbe } from "../provider-profile/provider-profile-reader-checks.js";
import {
  measureActivationReceipts,
  nodeActivationReceiptPorts,
} from "./activation-receipts-measure.js";
import type { ActivationReceiptInput } from "./activation-receipts-measure.js";
import type { ActivationReceiptPorts } from "./activation-receipts-ports.js";
import type { ActivationReceipts } from "./activation-receipts.js";
import { readDurableLedger, stateOf } from "./bootstrap-ledger.js";
import { installedSlices } from "./bootstrap-policy-services.js";
import { policyAggregateId } from "./bootstrap-sequence.js";

/**
 * THE COMPOSITION HALF OF `project.activate`: what the daemon MEASURES before its handler is
 * allowed to mint a witness.
 *
 * The receipts module deliberately defaults `committedProbeRef` to `null` and
 * `installedPolicySliceRefs` to `[]`, so a daemon that never wired them refuses every
 * activation with an honest ACTIVATION_PROVIDER_UNMEASURED / ACTIVATION_POLICY_UNMEASURED
 * instead of inventing a ref. THIS MODULE IS THAT WIRING. Deleting either override below does
 * not break a build and does not fail a shape test — it silently makes activation impossible,
 * which is why `activation-command-entry.test.ts` asserts a WIRED daemon mints and an unwired
 * one refuses, rather than asserting the overrides exist.
 */

/** The two durable readers, bound to the store this daemon serves. */
export function activationReceiptPorts(
  store: SqliteEventStore,
  projectId: string,
  overrides: Partial<ActivationReceiptPorts> = {},
): ActivationReceiptPorts {
  return nodeActivationReceiptPorts({
    // The ref the committed `provider.probe` ENVELOPE carried. The activation read path
    // (provider-profile-reader-checks.ts:192-193) compares the witness ref against this same
    // record, so a wrong value fails there rather than being quietly accepted here.
    committedProbeRef: () => {
      const probe = readProbe(store, projectId);
      return Promise.resolve(probe.ok ? probe.envelopeRef : null);
    },
    // The installed policy slice refs, read from the durable policy aggregate. An EMPTY set is
    // not an error state to paper over: it means the operator has not installed policy yet, and
    // ACTIVATION_POLICY_UNMEASURED is the correct, actionable answer.
    installedPolicySliceRefs: () => Promise.resolve(
      Object.keys(installedSlices(stateOf(
        readDurableLedger(store, projectId), policyAggregateId(projectId),
      ))),
    ),
    ...overrides,
  });
}

/**
 * HOST-SCOPED DAEMON-PROCESS CONFIGURATION, read RAW and never pre-validated here.
 *
 * An absent variable becomes an empty string, and the measurer owns what that means: it answers
 * "no store path configured" / "no project root configured" under the failing member's own code.
 * Substituting a default would be a second place for those rules to live, and would let a
 * misconfigured daemon activate against a path nobody chose.
 *
 * `projectRoot` falls back to the process CWD rather than to "", because the measurer resolves
 * the real repository through `git rev-parse --show-toplevel` FROM this directory — the daemon
 * is started inside the project it serves.
 *
 * `agentCommand` IS THE SEAT'S OWN RESOLUTION, not the env alone. It used to read
 * `MOE_AGENT_COMMAND ?? "claude"`, while the wrapper staffs a seat through `resolveAgentProvider`
 * (env, then the per-goal setting, then the durable per-project `project.set_agent_provider`
 * setting, then claude). With the env unset and the project set to codex, the provider member
 * therefore probed `claude --version` and certified claude's credential for a project whose
 * seats spawn codex — measured on this tree: `durableActivationReceiptInput` answered `claude`
 * against a store holding a committed codex setting. The same resolver now answers here, with
 * no goal (an activation is project-scoped), so the credential ref, the `--version` reading and
 * the minted witness describe the provider the wrapper will actually launch. `settingFor` is
 * the durable rung; a caller without a store passes none and gets the env-or-claude answer.
 */
export function activationReceiptInput(
  projectId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
  settingFor?: (goalId: string) => string | null,
): ActivationReceiptInput {
  const projectRoot = env["MOE_PROJECT_ROOT"] ?? cwd;
  return Object.freeze({
    agentCommand: resolveAgentProvider({
      envCommand: env["MOE_AGENT_COMMAND"], goalRef: null, settingFor,
    }),
    artifactRoot: projectRoot,
    projectId,
    projectRoot,
    storePath: env["MOE_STORE_PATH"] ?? "",
  });
}

/**
 * The input bound to THIS daemon's durable store: the provider rung reads the committed
 * `project.set_agent_provider` setting through the SAME fact the wrapper reads per staffed
 * seat (`agentProviderFact`). Resolved on every call, never at composition, so a setting the
 * operator changes while the daemon runs reaches the very next measurement.
 */
export function durableActivationReceiptInput(
  store: SqliteEventStore,
  projectId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
): ActivationReceiptInput {
  return activationReceiptInput(projectId, env, cwd, agentProviderFact(store, projectId));
}

export interface ActivationReceiptSource {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

/**
 * Measure once, for one command. NOT hoisted to daemon startup: a backup is taken and a HEAD sha
 * read as part of this measurement, so a set captured at boot would certify a tree the operator
 * has since changed.
 */
export function createActivationReceiptMeasurer(
  source: ActivationReceiptSource,
): () => Promise<ActivationReceipts> {
  const { projectId, store } = source;
  return async (): Promise<ActivationReceipts> => await measureActivationReceipts(
    durableActivationReceiptInput(store, projectId, source.env ?? process.env),
    activationReceiptPorts(store, projectId),
  );
}
