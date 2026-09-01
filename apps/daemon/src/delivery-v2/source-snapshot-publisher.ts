import { isProxy } from "node:util/types";

import {
  createSourceSnapshot,
  type SourceSnapshotRefusal,
} from "@moe/core";
import {
  RUNNER_SOURCE_SNAPSHOT_GIT_CODES,
  RUNNER_SOURCE_SNAPSHOT_GIT_LAYER,
  createNodeSourceSnapshotGitObserver,
  hermeticGitEnvironment,
  type SourceSnapshotGitObserver,
  type SourceSnapshotGitRefusal,
} from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";

import {
  decodeFoundationRepositoryScopeCatalog,
  readCurrentFoundationRepositoryScopeRequest,
  resolveFoundationRepositoryScope,
} from "../work/foundation-repository-scope-authority.js";
import type {
  FoundationRepositoryScopeRefused,
} from "../work/foundation-repository-scope-contracts.js";
import { deliveryV2Digest } from "./addresses.js";
import {
  appendDeliveryV2SourceSnapshot,
  type DeliveryV2SourceSnapshotAppendResult,
} from "./source-snapshot-persistence.js";

export const DAEMON_DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER =
  "DAEMON_DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER" as const;

export const DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER_CODES = Object.freeze([
  "DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER_CONFIG_INVALID",
  "DELIVERY_V2_SOURCE_SNAPSHOT_CATALOG_CONFIG_ABSENT",
  "DELIVERY_V2_SOURCE_SNAPSHOT_CATALOG_CONFIG_UNREADABLE",
  "DELIVERY_V2_SOURCE_SNAPSHOT_GIT_OBSERVER_UNREADABLE",
  "DELIVERY_V2_SOURCE_SNAPSHOT_OBSERVATION_BASE_MISMATCH",
  "DELIVERY_V2_SOURCE_SNAPSHOT_CLOCK_UNREADABLE",
] as const);

export const DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER_PRINCIPAL_DOMAIN =
  "moe-delivery-v2-source-snapshot-publisher-principal/1" as const;
export const DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISH_COMMAND_ID_DOMAIN =
  "moe-delivery-v2-source-snapshot-publish-command/1" as const;
export const DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISH_CORRELATION_ID_DOMAIN =
  "moe-delivery-v2-source-snapshot-publish-correlation/1" as const;

export type DeliveryV2SourceSnapshotPublisherCode =
  (typeof DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER_CODES)[number];

export interface DeliveryV2SourceSnapshotPublisherRefusal {
  readonly code: DeliveryV2SourceSnapshotPublisherCode;
  readonly layer: typeof DAEMON_DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER;
  readonly ok: false;
}

export type DeliveryV2SourceSnapshotPublishResult =
  | DeliveryV2SourceSnapshotAppendResult
  | DeliveryV2SourceSnapshotPublisherRefusal
  | FoundationRepositoryScopeRefused
  | SourceSnapshotGitRefusal
  | SourceSnapshotRefusal;

export interface DeliveryV2SourceSnapshotPublisher {
  publishCurrent(): DeliveryV2SourceSnapshotPublishResult;
}

export interface DeliveryV2SourceSnapshotPublisherConfig {
  readonly catalogSource: () => unknown;
  readonly clock: () => string;
  readonly observerFactory?: ((sourceRepositoryRoot: string) => SourceSnapshotGitObserver)
    | undefined;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

const REQUIRED_CONFIG_KEYS = Object.freeze([
  "catalogSource", "clock", "projectId", "store",
] as const);
const OPTIONAL_CONFIG_KEY = "observerFactory" as const;

const refuse = (
  code: DeliveryV2SourceSnapshotPublisherCode,
): DeliveryV2SourceSnapshotPublisherRefusal => Object.freeze({
  code,
  layer: DAEMON_DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER,
  ok: false as const,
});

function captureConfig(value: unknown): DeliveryV2SourceSnapshotPublisherConfig | undefined {
  if (value === null || typeof value !== "object") return undefined;
  try {
    if (isProxy(value)) return undefined;
    if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")
      || keys.length < REQUIRED_CONFIG_KEYS.length
      || keys.length > REQUIRED_CONFIG_KEYS.length + 1
      || !REQUIRED_CONFIG_KEYS.every((key) => keys.includes(key))
      || keys.some((key) => !REQUIRED_CONFIG_KEYS.includes(
        key as (typeof REQUIRED_CONFIG_KEYS)[number],
      ) && key !== OPTIONAL_CONFIG_KEY)) return undefined;
    const captured = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return undefined;
      }
      captured[key] = descriptor.value;
    }
    if (typeof captured["catalogSource"] !== "function"
      || isProxy(captured["catalogSource"])
      || typeof captured["clock"] !== "function"
      || isProxy(captured["clock"])
      || typeof captured["projectId"] !== "string"
      || captured["store"] === null || typeof captured["store"] !== "object"
      || isProxy(captured["store"])
      || (captured[OPTIONAL_CONFIG_KEY] !== undefined
        && (typeof captured[OPTIONAL_CONFIG_KEY] !== "function"
          || isProxy(captured[OPTIONAL_CONFIG_KEY])))) return undefined;
    return Object.freeze({
      catalogSource: captured["catalogSource"] as () => unknown,
      clock: captured["clock"] as () => string,
      ...(captured[OPTIONAL_CONFIG_KEY] === undefined ? {} : {
        observerFactory: captured[OPTIONAL_CONFIG_KEY] as
          (sourceRepositoryRoot: string) => SourceSnapshotGitObserver,
      }),
      projectId: captured["projectId"],
      store: captured["store"] as SqliteEventStore,
    });
  } catch {
    return undefined;
  }
}

export function deriveDeliveryV2SourceSnapshotPublisherPrincipalId(projectId: string): string {
  return `delivery-v2:source-snapshot-publisher:${deliveryV2Digest(
    DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER_PRINCIPAL_DOMAIN,
    projectId,
  )}`;
}

/**
 * The logical command is one durable repository binding, not the observed tree.
 * If an observer contradicts itself under that binding, changed request bytes
 * reuse this command and the store refuses an idempotency conflict.
 */
export function deriveDeliveryV2SourceSnapshotPublishCommandId(
  projectId: string,
  repositoryRef: string,
  scopeRef: string,
  baseRevisionHash: string,
): string {
  return `delivery-v2:source-snapshot-publish-command:${deliveryV2Digest(
    DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISH_COMMAND_ID_DOMAIN,
    projectId,
    repositoryRef,
    scopeRef,
    baseRevisionHash,
  )}`;
}

/** Correlation follows the exact immutable content, unlike the logical command. */
export function deriveDeliveryV2SourceSnapshotPublishCorrelationId(
  projectId: string,
  sourceSnapshotDigest: string,
): string {
  return `delivery-v2:source-snapshot-publish-correlation:${deliveryV2Digest(
    DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISH_CORRELATION_ID_DOMAIN,
    projectId,
    sourceSnapshotDigest,
  )}`;
}

function defaultObserverFactory(sourceRepositoryRoot: string): SourceSnapshotGitObserver {
  return createNodeSourceSnapshotGitObserver(
    sourceRepositoryRoot,
    hermeticGitEnvironment(process.env),
  );
}

interface CapturedObservation {
  readonly baseRevisionHash: string;
  readonly realRepositoryRoot: string;
  readonly repositoryBaseTree: string;
}

type CapturedGitResult =
  | Readonly<{ readonly kind: "OBSERVED"; readonly observation: CapturedObservation }>
  | Readonly<{ readonly kind: "REFUSED"; readonly refusal: SourceSnapshotGitRefusal }>
  | Readonly<{ readonly kind: "UNREADABLE" }>;

const UNREADABLE_GIT_RESULT: CapturedGitResult = Object.freeze({ kind: "UNREADABLE" });

function exactOwnData(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  try {
    if (isProxy(value) || Array.isArray(value)) return undefined;
    if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string")
      || !keys.every((key) => ownKeys.includes(key))) return undefined;
    const values: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return undefined;
      }
      values[key] = descriptor.value;
    }
    return Object.freeze(values);
  } catch {
    return undefined;
  }
}

function captureGitResult(value: unknown): CapturedGitResult {
  const accepted = exactOwnData(value, ["observation", "ok"]);
  if (accepted !== undefined && accepted["ok"] === true) {
    const observation = exactOwnData(accepted["observation"], [
      "baseRevisionHash", "realRepositoryRoot", "repositoryBaseTree",
    ]);
    if (observation === undefined
      || typeof observation["baseRevisionHash"] !== "string"
      || typeof observation["realRepositoryRoot"] !== "string"
      || typeof observation["repositoryBaseTree"] !== "string") return UNREADABLE_GIT_RESULT;
    return Object.freeze({
      kind: "OBSERVED" as const,
      observation: Object.freeze({
        baseRevisionHash: observation["baseRevisionHash"],
        // Validated and retained as runner provenance. It is deliberately not
        // raw-compared with the catalog spelling: a proven symlink resolves to
        // this real root, and the runner already owns that ownership decision.
        realRepositoryRoot: observation["realRepositoryRoot"],
        repositoryBaseTree: observation["repositoryBaseTree"],
      }),
    });
  }
  const refused = exactOwnData(value, ["code", "layer", "ok"]);
  if (refused !== undefined && refused["ok"] === false
    && Object.isFrozen(value)
    && refused["layer"] === RUNNER_SOURCE_SNAPSHOT_GIT_LAYER
    && RUNNER_SOURCE_SNAPSHOT_GIT_CODES.some((code) => code === refused["code"])) {
    return Object.freeze({
      kind: "REFUSED" as const,
      // The exact frozen upstream object survives; validation does not restamp it.
      refusal: value as SourceSnapshotGitRefusal,
    });
  }
  return UNREADABLE_GIT_RESULT;
}

function invalidPublisher(): DeliveryV2SourceSnapshotPublisher {
  return Object.freeze({
    publishCurrent: (): DeliveryV2SourceSnapshotPublisherRefusal =>
      refuse("DELIVERY_V2_SOURCE_SNAPSHOT_PUBLISHER_CONFIG_INVALID"),
  });
}

/**
 * Creates an inert, zero-caller-fact publisher. Merely creating this port does
 * not read Git or durable state; only an explicit internal `publishCurrent()`
 * call performs the observation and append.
 */
export function createDeliveryV2SourceSnapshotPublisher(
  value: DeliveryV2SourceSnapshotPublisherConfig,
): DeliveryV2SourceSnapshotPublisher {
  const config = captureConfig(value);
  if (config === undefined) return invalidPublisher();
  const observerFactory = config.observerFactory ?? defaultObserverFactory;

  return Object.freeze({
    publishCurrent(): DeliveryV2SourceSnapshotPublishResult {
      const current = readCurrentFoundationRepositoryScopeRequest(
        config.store,
        config.projectId,
      );
      if (!current.ok) return current;

      let configured: unknown;
      try {
        configured = config.catalogSource();
      } catch {
        return refuse("DELIVERY_V2_SOURCE_SNAPSHOT_CATALOG_CONFIG_UNREADABLE");
      }
      if (configured === undefined) {
        return refuse("DELIVERY_V2_SOURCE_SNAPSHOT_CATALOG_CONFIG_ABSENT");
      }
      const decoded = decodeFoundationRepositoryScopeCatalog(configured);
      if (!decoded.ok) return decoded;
      const resolved = resolveFoundationRepositoryScope(
        config.store,
        decoded.catalog,
        current.request,
      );
      if (!resolved.ok) return resolved;

      let gitResult: unknown;
      try {
        gitResult = observerFactory(resolved.authority.sourceRepositoryRoot)
          .observe(resolved.authority.baseRevisionHash);
      } catch {
        return refuse("DELIVERY_V2_SOURCE_SNAPSHOT_GIT_OBSERVER_UNREADABLE");
      }
      const capturedGit = captureGitResult(gitResult);
      if (capturedGit.kind === "REFUSED") return capturedGit.refusal;
      if (capturedGit.kind !== "OBSERVED") {
        return refuse("DELIVERY_V2_SOURCE_SNAPSHOT_GIT_OBSERVER_UNREADABLE");
      }
      const { observation } = capturedGit;
      if (observation.baseRevisionHash !== resolved.authority.baseRevisionHash) {
        return refuse("DELIVERY_V2_SOURCE_SNAPSHOT_OBSERVATION_BASE_MISMATCH");
      }
      const authority = resolved.authority;
      const draft = Object.freeze({
        baseRevisionHash: authority.baseRevisionHash,
        projectId: authority.projectId,
        repositoryBaseTree: observation.repositoryBaseTree,
        repositoryRef: authority.repositoryRef,
        scopeRef: authority.scopeRef,
      });
      const created = createSourceSnapshot(draft);
      if (!created.ok) return created;

      let decidedAt: string;
      try {
        decidedAt = config.clock();
      } catch {
        return refuse("DELIVERY_V2_SOURCE_SNAPSHOT_CLOCK_UNREADABLE");
      }
      // Optimistic final fence: after every injected read/effect, prove the
      // original durable request is still current. The store has no cross-
      // aggregate transaction spanning project state and this material append,
      // so an unavoidable race remains after this last read.
      const currentAtAppend = resolveFoundationRepositoryScope(
        config.store,
        decoded.catalog,
        current.request,
      );
      if (!currentAtAppend.ok) return currentAtAppend;
      const authorityAtAppend = currentAtAppend.authority;
      return appendDeliveryV2SourceSnapshot(config.store, Object.freeze({
        commandId: deriveDeliveryV2SourceSnapshotPublishCommandId(
          authorityAtAppend.projectId,
          authorityAtAppend.repositoryRef,
          authorityAtAppend.scopeRef,
          authorityAtAppend.baseRevisionHash,
        ),
        correlationId: deriveDeliveryV2SourceSnapshotPublishCorrelationId(
          authorityAtAppend.projectId,
          created.snapshot.sourceSnapshotDigest,
        ),
        decidedAt,
        expectedVersion: 0,
        principalId: deriveDeliveryV2SourceSnapshotPublisherPrincipalId(
          authorityAtAppend.projectId,
        ),
        projectId: authorityAtAppend.projectId,
      }), draft);
    },
  });
}
