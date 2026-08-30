import { SqliteEventStore } from "@moe/store";

import { createDaemonFoundationWiring } from "./daemon-context-seal-wiring.js";
import type { DaemonFoundationWiring } from "./daemon-context-seal-wiring.js";
import { ensureGenesisRecoveryBinding } from "./identity/genesis-recovery-binding.js";

export interface FoundationStoreAcquisitionInput {
  readonly clock: () => string;
  readonly projectConfigurationDigest?: string | undefined;
  readonly projectId: string;
  readonly storePath: string;
  readonly verificationCatalogPath?: string | undefined;
  readonly workspaceCatalogPath?: string | undefined;
}

export interface FoundationStoreAcquisition {
  readonly foundation: DaemonFoundationWiring;
  readonly store: SqliteEventStore;
}

export type FoundationStoreOpener = (path: string, projectId: string) => SqliteEventStore;

/** Opens the handle and owns cleanup until the complete Foundation wiring is constructed. */
export function acquireFoundationStore(
  input: FoundationStoreAcquisitionInput,
  openStore: FoundationStoreOpener = SqliteEventStore.openForProject,
): FoundationStoreAcquisition {
  const store = openStore(input.storePath, input.projectId);
  const genesis = ensureGenesisRecoveryBinding(store, {
    clock: input.clock,
    projectId: input.projectId,
  });
  if (!genesis.ok) {
    store.close();
    throw new Error(`GENESIS_RECOVERY_BINDING_FAILED: ${genesis.code} (${genesis.storeCode})`);
  }
  try {
    const foundation = createDaemonFoundationWiring({
      projectConfigurationDigest: input.projectConfigurationDigest,
      projectId: input.projectId,
      store,
      verificationCatalogPath: input.verificationCatalogPath,
      workspaceCatalogPath: input.workspaceCatalogPath,
    });
    return Object.freeze({ foundation, store });
  } catch (error) {
    try { store.close(); } catch { /* cleanup must never mask the construction failure */ }
    throw error;
  }
}
