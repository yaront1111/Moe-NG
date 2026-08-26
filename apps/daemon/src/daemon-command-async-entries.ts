import type { SqliteEventStore } from "@moe/store";

import { createFoundationDispatchHandler, foundationSyncHandler }
  from "./daemon-foundation-command.js";
import { createFoundationVerificationHandler }
  from "./daemon-foundation-verification-command.js";
import { FOUNDATION_VERIFICATION_COMMAND_KIND }
  from "./evidence/foundation-verification-contracts.js";
import type { CommandRegistryEntry } from "./http/http-contract.js";
import { createFoundationCaptureLifecycle } from "./work/foundation-capture-lifecycle.js";
import { unconfiguredFoundationContextSealPort } from "./work/foundation-context-record.js";
import type { FoundationContextSealPort } from "./work/foundation-context-record.js";
import type { FoundationCaptureLifecycle } from "./work/foundation-capture-lifecycle.js";
import { FOUNDATION_DISPATCH_COMMAND_KIND } from "./work/foundation-attempt-contracts.js";
import { CAPABILITIES, PAYLOAD_KEYS } from "./daemon-command-vocabulary.js";

/**
 * The registry entries whose services are genuinely ASYNCHRONOUS. They are kept apart
 * from the synchronous wiring because none of it applies to them: each carries an async
 * handler and they share one synchronous handler that refuses, since the seam refuses
 * above it before it can be called.
 */
export type AsyncCommandKind =
  | typeof FOUNDATION_DISPATCH_COMMAND_KIND
  | typeof FOUNDATION_VERIFICATION_COMMAND_KIND;

export interface AsyncCommandEntryOptions {
  /** The daemon-startup workspace catalog, shared with the capture lifecycle so the
   *  dispatch-time derivation resolves the SAME repository scope authority. */
  readonly foundationCatalogSource?: () => unknown;
  /** The pre-launch context seal. ABSENT means unconfigured, which is not the same as
   *  "skip the seal": the fallback below refuses every seal, so an unconfigured daemon
   *  cannot launch a provider with no durably recorded context manifest. */
  readonly foundationContextSeal?: FoundationContextSealPort;
  readonly foundationLifecycle?: FoundationCaptureLifecycle;
  readonly projectId: string;
  readonly store: SqliteEventStore;
  readonly verificationCatalogSource?: () => unknown;
}

/** The two async entries, keyed by kind so the registry can answer one lookup and stop. */
export function createAsyncCommandEntries(
  options: AsyncCommandEntryOptions,
): Readonly<Record<AsyncCommandKind, CommandRegistryEntry>> {
  const { projectId, store } = options;
  const foundationCatalogSource = options.foundationCatalogSource ?? ((): unknown => undefined);
  const dispatchFoundationAttempt = createFoundationDispatchHandler({
    catalogSource: foundationCatalogSource,
    contextSeal: options.foundationContextSeal ?? unconfiguredFoundationContextSealPort(),
    lifecycle: options.foundationLifecycle
      ?? createFoundationCaptureLifecycle({ catalogSource: foundationCatalogSource, store }),
    store,
  });
  const verifyFoundationAttempt = createFoundationVerificationHandler({
    projectId, store,
    // Spread rather than assigned: under exactOptionalPropertyTypes an explicit
    // `undefined` is a DIFFERENT thing from an absent key, and only the absent
    // key means "no catalog configured".
    ...(options.verificationCatalogSource === undefined
      ? {} : { verificationCatalogSource: options.verificationCatalogSource }),
  });
  return Object.freeze({
    [FOUNDATION_DISPATCH_COMMAND_KIND]: Object.freeze({
      asyncHandler: dispatchFoundationAttempt, handler: foundationSyncHandler,
      kind: FOUNDATION_DISPATCH_COMMAND_KIND,
      payloadKeys: PAYLOAD_KEYS[FOUNDATION_DISPATCH_COMMAND_KIND],
      requiredCapability: CAPABILITIES.WORK,
    }),
    [FOUNDATION_VERIFICATION_COMMAND_KIND]: Object.freeze({
      asyncHandler: verifyFoundationAttempt, handler: foundationSyncHandler,
      kind: FOUNDATION_VERIFICATION_COMMAND_KIND,
      payloadKeys: PAYLOAD_KEYS[FOUNDATION_VERIFICATION_COMMAND_KIND],
      requiredCapability: CAPABILITIES.WORK,
    }),
  });
}
