import type { SqliteEventStore } from "@moe/store";
import { DomainRefusal, domainRefusalOf } from "../daemon-command-dispatch.js";
import { foundationSyncHandler } from "../daemon-foundation-command.js";
import { CAPABILITIES, PAYLOAD_KEYS } from "../daemon-command-vocabulary.js";
import { DAEMON_COMMAND_SEAM } from "../http/http-async-contract.js";
import type { CommandHandlerInput, CommandRegistryEntry, DurableDecision }
  from "../http/http-contract.js";
import { isDurableHumanPrincipal } from "../identity/human-approver.js";
import { ref } from "../json-record-shape.js";
import { PUBLISH_RESOLVE_COMMAND_KIND } from "./publish-resolve-contracts.js";
import { PUBLISH_RESOLVED_CODES, resolvePublish } from "./publish-resolve-service.js";
import type { PublishResolution } from "./publish-resolve-service.js";

const isResolution = (value: unknown): value is PublishResolution =>
  typeof value === "string" && Object.hasOwn(PUBLISH_RESOLVED_CODES, value);

type ResolvePrincipalOptions = Readonly<{
  operatorPrincipalId: string;
  projectId: string;
  store: SqliteEventStore;
}>;

/**
 * The registry entry for `repository.publish_resolve`. It lives beside `repository-recovery-command.ts`,
 * its sibling in REPOSITORY_RECOVERY_FAMILY, rather than inline in `daemon-command-async-entries.ts`,
 * which sits at the 400-line split line.
 *
 * FENCED AT ENTRY. An async entry never reaches the registry's synchronous operator check
 * (daemon-command-registry.ts:379-381), so the handler carries its own fence. Owner ruling
 * comment-00ce6540 on task-4f16c331: the configured operator, OR a paired durable HUMAN on
 * this project holding ADMIN, may resolve. The kind stays MCP-excluded and never-delegated.
 *
 * THEN THE SERVICE (publish-resolve-service.ts): it records the resolution as ONE REFUSED
 * receipt and never touches the repository hold, which its owning publisher gives back.
 * Every refusal it mints is row 2's; a malformed payload is refused here, before it reads anything.
 */
export function createPublishResolveCommandEntry(options: {
  readonly operatorPrincipalId: string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}): CommandRegistryEntry {
  return Object.freeze({
    asyncHandler: async (input: CommandHandlerInput): Promise<DurableDecision> => {
      assertResolvePrincipal(input, options);
      const { envelope } = input;
      const { decisionId, resolution } = envelope.payload;
      if (!ref(decisionId) || !isResolution(resolution)) {
        throw new DomainRefusal("INPUT_INVALID", DAEMON_COMMAND_SEAM,
          "repository.publish_resolve takes exactly {decisionId, resolution: NOT_TRANSMITTED | ABANDON}", 422);
      }
      const resolved = resolvePublish(options.store, { projectId: options.projectId, decisionId, resolution,
        decidedAt: new Date().toISOString() });
      if (!resolved.ok) throw domainRefusalOf(resolved);
      return { commandId: envelope.commandId, disposition: resolved.replayed ? "REPLAYED" : "DECIDED",
        effectId: resolved.receipt.receiptId, resultCode: PUBLISH_RESOLVED_CODES[resolution] };
    },
    handler: foundationSyncHandler,
    kind: PUBLISH_RESOLVE_COMMAND_KIND,
    payloadKeys: PAYLOAD_KEYS[PUBLISH_RESOLVE_COMMAND_KIND],
    requiredCapability: CAPABILITIES.ADMIN,
  });
}

function assertResolvePrincipal(
  input: CommandHandlerInput, options: ResolvePrincipalOptions,
): void {
  if (input.principal.principalId !== options.operatorPrincipalId
    && !resolveByPairedAdmin(input, options)) {
    throw new DomainRefusal("OPERATOR_PRINCIPAL_REQUIRED", "DAEMON_AUTHORIZATION",
      "this command requires the configured operator principal", 403);
  }
}

/** ADMIN is defence in depth (drill M2 removes it); ingress already demands it. */
function resolveByPairedAdmin(
  input: CommandHandlerInput, options: ResolvePrincipalOptions,
): boolean {
  const { principal } = input;
  if (principal.projectId !== options.projectId
    || !principal.capabilities.includes(CAPABILITIES.ADMIN)) {
    return false;
  }
  try {
    // The throwing-store arm proxies readEvents; a throw here is fail-closed (drill M4).
    options.store.readEvents(principal.principalId);
    return isDurableHumanPrincipal(options.store, principal.principalId);
  } catch {
    return false;
  }
}
