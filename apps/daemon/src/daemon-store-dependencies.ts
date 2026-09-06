import {
  FOUNDATION_WORKSPACE_CATALOG_ENV_KEY, PROJECT_CONFIGURATION_DIGEST_ENV_KEY,
  VERIFICATION_CATALOG_ENV_KEY,
} from "./daemon-context-seal-wiring.js";
import type { DaemonDependencyProvider } from "./daemon-entry.js";
import { CUTOVER_EVIDENCE_ROOT_ENV_KEY } from "./daemon-store-cutover-wiring.js";
import {
  createStoreDependencies, type StoreDependencyConfig, type StoreDependencyProvider,
} from "./daemon-store-foundation-composition.js";
import { DEFAULT_OPERATOR_PRINCIPAL_ID } from "./operator-identity.js";

/**
 * The command table itself lives in `./daemon-command-registry.js`. `agentCapabilitiesFor`
 * is re-exported here because the agent wrapper has always imported it from this module.
 */
export { agentCapabilitiesFor } from "./daemon-command-registry.js";

export { createStoreDependencies };
export { CUTOVER_EVIDENCE_ROOT_ENV_KEY };
export type { StoreDependencyConfig };

export const STORE_DEPENDENCIES_ENV_MISSING = "STORE_DEPENDENCIES_ENV_MISSING" as const;

const ENV_KEYS = ["MOE_STORE_PATH", "MOE_PROJECT_ID", "MOE_DAEMON_CREDENTIAL"] as const;

export function readStoreDependencyEnv(
  env: Readonly<Record<string, string | undefined>>,
): StoreDependencyConfig {
  const missing = ENV_KEYS.filter((key) => (env[key] ?? "") === "");
  if (missing.length > 0) {
    throw new Error(`${STORE_DEPENDENCIES_ENV_MISSING}: ${missing.join(", ")}`);
  }
  // Optionals follow the SAME empty-means-absent rule as the required trio:
  // MOE_PRINCIPAL_ID="" must not mint an empty operator principal.
  const principalId = env.MOE_PRINCIPAL_ID;
  const nodeSpecsDir = env.MOE_NODE_SPECS_DIR;
  const catalogPath = env[FOUNDATION_WORKSPACE_CATALOG_ENV_KEY];
  const verificationCatalogPath = env[VERIFICATION_CATALOG_ENV_KEY];
  const projectConfigurationDigest = env[PROJECT_CONFIGURATION_DIGEST_ENV_KEY];
  const cutoverEvidenceRoot = env[CUTOVER_EVIDENCE_ROOT_ENV_KEY];
  return Object.freeze({
    credential: env.MOE_DAEMON_CREDENTIAL as string,
    cutoverEvidenceRoot: cutoverEvidenceRoot === "" ? undefined : cutoverEvidenceRoot,
    nodeSpecsDir: nodeSpecsDir === "" ? undefined : nodeSpecsDir,
    principalId: principalId === undefined || principalId === ""
      ? DEFAULT_OPERATOR_PRINCIPAL_ID
      : principalId,
    ...(projectConfigurationDigest === undefined || projectConfigurationDigest === ""
      ? {} : { projectConfigurationDigest }),
    projectId: env.MOE_PROJECT_ID as string,
    storePath: env.MOE_STORE_PATH as string,
    verificationCatalogPath: verificationCatalogPath === "" ? undefined : verificationCatalogPath,
    workspaceCatalogPath: catalogPath === "" ? undefined : catalogPath,
  });
}

let envProvider: StoreDependencyProvider | null = null;

function fromEnv(): StoreDependencyProvider {
  envProvider = envProvider ?? createStoreDependencies(readStoreDependencyEnv(process.env));
  return envProvider;
}

const provider: DaemonDependencyProvider & Pick<
  StoreDependencyProvider, "restore" | "sourceSnapshotPublisher"
> = Object.freeze({
  schedules: () => fromEnv().schedules(),
  activation: () => {
    const port = fromEnv().activation;
    if (port === undefined) throw new Error("unreachable: the activation reader is always wired");
    return port();
  },
  affordances: () => {
    const port = fromEnv().affordances;
    if (port === undefined) throw new Error("unreachable: affordances is always wired");
    return port();
  },
  documentCoverage: () => {
    const port = fromEnv().documentCoverage;
    if (port === undefined) throw new Error("unreachable: the coverage reader is always wired");
    return port();
  },
  runs: () => {
    const port = fromEnv().runs;
    if (port === undefined) throw new Error("unreachable: the runs reader is always wired");
    return port();
  },
  health: () => {
    const port = fromEnv().health;
    if (port === undefined) throw new Error("unreachable: the health reader is always wired");
    return port();
  },
  policy: () => {
    const port = fromEnv().policy;
    if (port === undefined) throw new Error("unreachable: the policy reader is always wired");
    return port();
  },
  activity: () => {
    const port = fromEnv().activity;
    if (port === undefined) throw new Error("unreachable: the activity reader is always wired");
    return port();
  },
  sessions: () => {
    const port = fromEnv().sessions;
    if (port === undefined) throw new Error("unreachable: the sessions reader is always wired");
    return port();
  },
  repositoryRemote: () => {
    const port = fromEnv().repositoryRemote;
    if (port === undefined) {
      throw new Error("unreachable: the repository-remote reader is always wired");
    }
    return port();
  },
  repositoryWorkflows: () => {
    const port = fromEnv().repositoryWorkflows;
    if (port === undefined) throw new Error("repository workflow read port unavailable");
    return port();
  },
  goalSource: () => {
    const port = fromEnv().goalSource;
    if (port === undefined) throw new Error("unreachable: the goal-source reader is always wired");
    return port();
  },
  designReads: () => {
    const port = fromEnv().designReads;
    if (port === undefined) throw new Error("unreachable: the design reader is always wired");
    return port();
  },
  environmentReads: () => {
    const port = fromEnv().environmentReads;
    if (port === undefined) throw new Error("unreachable: the environment reader is always wired");
    return port();
  },
  previewReads: () => {
    const port = fromEnv().previewReads;
    if (port === undefined) throw new Error("unreachable: the preview reader is always wired");
    return port();
  },
  previewCaptures: () => {
    const port = fromEnv().previewCaptures;
    if (port === undefined) throw new Error("unreachable: the preview capture reader is always wired");
    return port();
  },
  documentDossiers: () => {
    const port = fromEnv().documentDossiers;
    if (port === undefined) throw new Error("unreachable: document dossiers are always wired");
    return port();
  },
  documentIngest: () => {
    const port = fromEnv().documentIngest;
    if (port === undefined) throw new Error("unreachable: document ingest is always wired");
    return port();
  },
  /**
   * FORWARDED, not merely constructed. `createStoreDependencies` returning a
   * `graph` factory is invisible to the shipped daemon: `daemon-main` loads THIS
   * frozen object, and a port missing here answers `GRAPH_QUERY_UNAVAILABLE` on
   * a real authenticated `POST /graph/get` while every direct-injection test
   * stays green. Every optional factory this root builds must appear here.
   */
  graph: () => {
    const port = fromEnv().graph;
    if (port === undefined) throw new Error("unreachable: the graph reader is always wired");
    return port();
  },
  goalCatalog: () => {
    const port = fromEnv().goalCatalog;
    if (port === undefined) throw new Error("unreachable: the goal catalog is always wired");
    return port();
  },
  /**
   * FORWARDED for the reason stated on `graph` above, and the consequence here is a LEAKED
   * PROCESS rather than a refusal: `daemon-main` loads THIS frozen object, so a preview port
   * missing here leaves the shipped daemon's shutdown with nothing to sweep, and every preview
   * server it started keeps its port after the daemon is gone — while every direct-injection
   * test stays green.
   */
  previews: () => {
    const port = fromEnv().previews;
    if (port === undefined) throw new Error("unreachable: the preview port is always wired");
    return port();
  },
  planningRuns: () => {
    const port = fromEnv().planningRuns;
    if (port === undefined) throw new Error("unreachable: the planning-run reader is always wired");
    return port();
  },
  budgetCommitment: () => {
    const port = fromEnv().budgetCommitment;
    if (port === undefined) {
      throw new Error("unreachable: the budget commitment reader is always wired");
    }
    return port();
  },
  productContractGate1: () => {
    const port = fromEnv().productContractGate1;
    if (port === undefined) throw new Error("unreachable: the gate 1 reader is always wired");
    return port();
  },
  productContractPending: () => {
    const port = fromEnv().productContractPending;
    if (port === undefined) throw new Error("unreachable: the pending reader is always wired");
    return port();
  },
  productContractV2Current: () => {
    const port = fromEnv().productContractV2Current;
    if (port === undefined) throw new Error("unreachable: the v2 current reader is always wired");
    return port();
  },
  productContractV2Pending: () => {
    const port = fromEnv().productContractV2Pending;
    if (port === undefined) throw new Error("unreachable: the v2 pending reader is always wired");
    return port();
  },
  commandAuthorityPlane: () => {
    const port = fromEnv().commandAuthorityPlane;
    if (port === undefined) throw new Error("unreachable: the command plane reader is always wired");
    return port();
  },
  pairingOpenSessions: () => {
    const port = fromEnv().pairingOpenSessions;
    if (port === undefined) throw new Error("pairingOpenSessions is unavailable");
    return port();
  },
  sessionChallengeOperands: () => {
    const port = fromEnv().sessionChallengeOperands;
    if (port === undefined) {
      throw new Error("unreachable: the challenge-operands reader is always wired");
    }
    return port();
  },
  provide: () => fromEnv().provide(),
  provideV2: () => {
    const port = fromEnv().provideV2;
    if (port === undefined) throw new Error("unreachable: the v2 command plane is always wired");
    return port();
  },
  reconciliation: () => {
    const port = fromEnv().reconciliation;
    if (port === undefined) throw new Error("unreachable: reconciliation is always wired");
    return port();
  },
  restore: () => fromEnv().restore(),
  sessionHandshake: () => {
    const port = fromEnv().sessionHandshake;
    if (port === undefined) throw new Error("unreachable: the session handshake is always wired");
    return port();
  },
  sourceSnapshotPublisher: () => fromEnv().sourceSnapshotPublisher(),
  subscriptions: () => {
    const port = fromEnv().subscriptions;
    if (port === undefined) throw new Error("unreachable: subscriptions is always wired");
    return port();
  },
});

export default provider;
