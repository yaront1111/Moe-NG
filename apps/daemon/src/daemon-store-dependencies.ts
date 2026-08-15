import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SqliteEventStore } from "@moe/store";
import { readSubscriptionPage } from "@moe/store/subscriptions/subscription-read-page.js";
import { reseatToSnapshot } from "@moe/store/subscriptions/subscription-writes.js";

import { OPERATOR_CAPABILITIES, createDaemonCommandPorts } from "./daemon-command-registry.js";
import type { DaemonDependencyProvider } from "./daemon-entry.js";
import { ensureGenesisRecoveryBinding } from "./identity/genesis-recovery-binding.js";
import { createSessionAuthenticator } from "./identity/session-authenticator.js";
import { createBoardProjectionService } from "./projections/board-projection-service.js";
import { readLatestDocumentWorkDossier } from "./documents/document-work-service.js";
import { createRestorePort } from "./recovery/restore-controller-commands.js";
import type { RestorePort } from "./recovery/restore-controller-commands.js";
import { createAffordancePort } from "./http/affordance-read.js";
import type { DocumentDossierReadPort } from "./http/document-dossier-read.js";
import type { CommandAdapterDeps } from "./http/http-contract.js";
import type { StreamPageRequest, StreamReseatRequest,
  SubscriptionPort } from "./http/event-stream-contract.js";

/**
 * The command table itself lives in `./daemon-command-registry.js`. `agentCapabilitiesFor`
 * is re-exported here because the agent wrapper has always imported it from this module.
 */
export { agentCapabilitiesFor } from "./daemon-command-registry.js";

export interface StoreDependencyConfig {
  readonly clock?: () => string;
  readonly credential: string;
  readonly nodeSpecsDir?: string | undefined;
  readonly principalId: string;
  readonly projectId: string;
  readonly storePath: string;
}

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
  return Object.freeze({
    credential: env.MOE_DAEMON_CREDENTIAL as string,
    nodeSpecsDir: nodeSpecsDir === "" ? undefined : nodeSpecsDir,
    principalId: principalId === undefined || principalId === "" ? "operator-local" : principalId,
    projectId: env.MOE_PROJECT_ID as string,
    storePath: env.MOE_STORE_PATH as string,
  });
}

function nodeSpecLoader(directory: string): () => readonly { nodeRef: string; title: string }[] {
  return () => {
    let entries: string[];
    try {
      entries = readdirSync(directory).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const specs: { nodeRef: string; title: string }[] = [];
    for (const name of entries.sort()) {
      try {
        const parsed = JSON.parse(readFileSync(join(directory, name), "utf8")) as {
          nodeRef?: unknown; title?: unknown;
        };
        if (typeof parsed.nodeRef === "string" && parsed.nodeRef.length > 0
          && typeof parsed.title === "string") {
          specs.push({ nodeRef: parsed.nodeRef, title: parsed.title });
        }
      } catch { /* skipped, never invented */ }
    }
    return specs;
  };
}

type StoreDependencyProvider = DaemonDependencyProvider & {
  close(): void;
  restore(): RestorePort;
};

export function createStoreDependencies(
  config: StoreDependencyConfig,
): StoreDependencyProvider {
  const clock = config.clock ?? ((): string => new Date().toISOString());
  const store = SqliteEventStore.openForProject(config.storePath, config.projectId);
  // Every authentication is fenced on the ACTIVE recovery binding, and the only
  // other installer is the disaster-restore path — without genesis, a fresh
  // store could never authenticate anyone. A refusal here is a startup fault:
  // the throw surfaces as DAEMON_ENTRY_PROVIDER_THREW rather than as a daemon
  // that listens but refuses every credential forever.
  const genesis = ensureGenesisRecoveryBinding(store, { clock, projectId: config.projectId });
  if (!genesis.ok) {
    store.close();
    throw new Error(`GENESIS_RECOVERY_BINDING_FAILED: ${genesis.code} (${genesis.storeCode})`);
  }
  let subscriptionDatabase: DatabaseSync | null = null;

  const { decisions, registry } = createDaemonCommandPorts({
    clock, projectId: config.projectId, store,
  });

  const authenticator = createSessionAuthenticator(store, {
    clock: () => Date.now(),
    operatorCapabilities: OPERATOR_CAPABILITIES,
    operatorCredential: config.credential,
    operatorPrincipalId: config.principalId,
    projectId: config.projectId,
  });

  const provide = (): CommandAdapterDeps =>
    Object.freeze({ authenticator, decisions, registry });

  const DEFAULT_READER = "control-room-1";

  const subscriptions = (): SubscriptionPort => {
    const database = subscriptionDatabase ?? new DatabaseSync(config.storePath);
    subscriptionDatabase = database;
    database.exec("PRAGMA busy_timeout = 5000;");
    const board = createBoardProjectionService({ database, store });
    const baseline = board.ensureBaseline("daemon provider startup");
    if (baseline.outcome === "BASELINE_READY") board.registerReader(DEFAULT_READER);
    return Object.freeze({
      readPage: (request: StreamPageRequest) => {
        const folded = board.foldOnce();
        if (folded.outcome !== "FOLDED") return folded;
        return readSubscriptionPage(store, database, request);
      },
      reseat: (request: StreamReseatRequest) => reseatToSnapshot(database, request),
    });
  };

  const affordances = () => createAffordancePort({
    mintId: () => randomUUID(),
    ...(config.nodeSpecsDir === undefined ? {} : { nodes: nodeSpecLoader(config.nodeSpecsDir) }),
    projectId: config.projectId,
    store,
  });

  const documentDossiers = (): DocumentDossierReadPort => Object.freeze({
    readLatest: (projectId: string) => readLatestDocumentWorkDossier(store, projectId),
  });

  return Object.freeze({
    affordances,
    close: (): void => { subscriptionDatabase?.close(); store.close(); },
    documentDossiers,
    provide,
    restore: () => createRestorePort(store, config.projectId),
    subscriptions,
  });
}

let envProvider: StoreDependencyProvider | null = null;

function fromEnv(): StoreDependencyProvider {
  envProvider = envProvider ?? createStoreDependencies(readStoreDependencyEnv(process.env));
  return envProvider;
}

const provider: DaemonDependencyProvider & Pick<StoreDependencyProvider, "restore"> = Object.freeze({
  affordances: () => {
    const port = fromEnv().affordances;
    if (port === undefined) throw new Error("unreachable: affordances is always wired");
    return port();
  },
  documentDossiers: () => {
    const port = fromEnv().documentDossiers;
    if (port === undefined) throw new Error("unreachable: document dossiers are always wired");
    return port();
  },
  provide: () => fromEnv().provide(),
  restore: () => fromEnv().restore(),
  subscriptions: () => {
    const port = fromEnv().subscriptions;
    if (port === undefined) throw new Error("unreachable: subscriptions is always wired");
    return port();
  },
});

export default provider;
