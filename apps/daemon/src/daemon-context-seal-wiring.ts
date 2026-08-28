import { snapshotProjectState } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf } from "./bootstrap/bootstrap-ledger.js";
import {
  createVerificationCatalogReader, readVerificationCatalogConfig,
} from "./evidence/verification-catalog-reader.js";
import type { VerificationCatalogReader }
  from "./evidence/verification-catalog-reader.js";
import { VERIFICATION_CATALOG_ENV_KEY }
  from "./evidence/verification-catalog-contracts.js";
import {
  FOUNDATION_WORKSPACE_CATALOG_ENV_KEY, createFoundationCaptureLifecycle,
  readFoundationCatalogConfig,
} from "./work/foundation-capture-lifecycle.js";
import type { FoundationCaptureLifecycle }
  from "./work/foundation-capture-lifecycle.js";
import type { FoundationContextSealIdentity, FoundationContextSealPort }
  from "./work/foundation-context-record.js";
import { createDurableFoundationContextSealPort }
  from "./work/foundation-context-record.js";
import {
  decodeFoundationRepositoryScopeCatalog, resolveFoundationRepositoryScope,
} from "./work/foundation-repository-scope-authority.js";
import {
  refuseCatalog, refuseResolution,
} from "./work/foundation-repository-scope-contracts.js";
import type { FoundationRepositoryScopeResult }
  from "./work/foundation-repository-scope-contracts.js";

export interface DaemonContextSealConfig {
  readonly foundationCatalogSource: () => unknown;
  readonly projectConfigurationDigest?: string | undefined;
  readonly projectId: string;
  readonly store: SqliteEventStore;
  readonly verificationCatalogSource: () => unknown;
}

export const PROJECT_CONFIGURATION_DIGEST_ENV_KEY = "MOE_PROJECT_CONFIGURATION_DIGEST";
export { VERIFICATION_CATALOG_ENV_KEY, FOUNDATION_WORKSPACE_CATALOG_ENV_KEY };

export interface DaemonFoundationWiringConfig {
  readonly projectConfigurationDigest?: string | undefined;
  readonly projectId: string;
  readonly store: SqliteEventStore;
  readonly verificationCatalogPath?: string | undefined;
  readonly workspaceCatalogPath?: string | undefined;
}

export interface DaemonFoundationWiring {
  readonly foundationCatalogSource: () => unknown;
  readonly foundationContextSeal?: FoundationContextSealPort;
  readonly foundationLifecycle: FoundationCaptureLifecycle;
  readonly verificationCatalogSource: () => unknown;
}

const HEX64 = /^[0-9a-f]{64}$/u;

function currentRepositoryScope(
  config: DaemonContextSealConfig,
): FoundationRepositoryScopeResult {
  let raw: unknown;
  try {
    raw = stateOf(readDurableLedger(config.store, config.projectId), config.projectId);
  } catch {
    return refuseResolution("FOUNDATION_REPOSITORY_SCOPE_PROJECT_STATE_UNREADABLE");
  }
  const state = snapshotProjectState(raw);
  if (state === undefined) {
    return raw === undefined || raw === null
      ? refuseResolution("FOUNDATION_REPOSITORY_SCOPE_PROJECT_STATE_ABSENT")
      : refuseResolution("FOUNDATION_REPOSITORY_SCOPE_PROJECT_STATE_INVALID");
  }
  const observation = state.repositoryObservations[state.repositoryObservations.length - 1];
  if (observation === undefined) {
    return refuseResolution("FOUNDATION_REPOSITORY_SCOPE_OBSERVATION_ABSENT");
  }
  let configured: unknown;
  try { configured = config.foundationCatalogSource(); } catch {
    return refuseCatalog("FOUNDATION_REPOSITORY_SCOPE_CATALOG_ACCESSOR");
  }
  const decoded = decodeFoundationRepositoryScopeCatalog(configured);
  if (!decoded.ok) return decoded;
  return resolveFoundationRepositoryScope(config.store, decoded.catalog, {
    baseRevisionHash: observation.baseRevisionHash, projectId: config.projectId,
    repositoryRef: observation.repositoryRef, scopeRef: observation.scopeRef,
  });
}

function uniqueProfileRevision(
  catalog: VerificationCatalogReader, projectId: string,
): string | null {
  const capabilities = catalog.capabilitiesFor(projectId);
  if (!capabilities.ok) return null;
  const revisions = new Set<string>();
  for (const capability of capabilities.capabilities) {
    const configured = catalog.entryFor(projectId, capability);
    if (!configured.ok) return null;
    revisions.add(configured.entry.profileRevisionId);
  }
  return revisions.size === 1 ? [...revisions][0] ?? null : null;
}

export function createDaemonContextSealPort(
  config: DaemonContextSealConfig,
): FoundationContextSealPort | undefined {
  if (!HEX64.test(config.projectConfigurationDigest ?? "")) return undefined;
  const catalog = createVerificationCatalogReader({
    catalogSource: config.verificationCatalogSource,
  });
  return Object.freeze({
    sealFoundationContext(identity: FoundationContextSealIdentity, decidedAt: string) {
      const profileRevisionId = uniqueProfileRevision(catalog, config.projectId);
      if (profileRevisionId === null) {
        return Object.freeze({
          code: "FOUNDATION_CONTEXT_SEAL_REFUSED" as const,
          detail: "the verification catalog names no unique provider profile revision",
          layer: "FOUNDATION_CONTEXT_SEAL" as const,
          ok: false as const,
          upstream: null,
        });
      }
      return createDurableFoundationContextSealPort({
        brief: {
          catalog,
          repositoryScope: (): FoundationRepositoryScopeResult => currentRepositoryScope(config),
          store: config.store,
        },
        expectedConfigurationDigest: config.projectConfigurationDigest as string,
        profileRevisionId, projectId: config.projectId, store: config.store,
      }).sealFoundationContext(identity, decidedAt);
    },
  });
}

export function createDaemonFoundationWiring(
  config: DaemonFoundationWiringConfig,
): DaemonFoundationWiring {
  const foundationCatalogSource = readFoundationCatalogConfig({
    [FOUNDATION_WORKSPACE_CATALOG_ENV_KEY]: config.workspaceCatalogPath,
  });
  const verificationCatalogSource = readVerificationCatalogConfig({
    [VERIFICATION_CATALOG_ENV_KEY]: config.verificationCatalogPath,
  });
  const foundationContextSeal = createDaemonContextSealPort({
    foundationCatalogSource,
    projectConfigurationDigest: config.projectConfigurationDigest,
    projectId: config.projectId,
    store: config.store,
    verificationCatalogSource,
  });
  return Object.freeze({
    foundationCatalogSource,
    ...(foundationContextSeal === undefined ? {} : { foundationContextSeal }),
    foundationLifecycle: createFoundationCaptureLifecycle({
      catalogSource: foundationCatalogSource, store: config.store,
    }),
    verificationCatalogSource,
  });
}
