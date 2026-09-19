import type { SqliteEventStore } from "@moe/store";
import { DomainRefusal, domainRefusalOf } from "../daemon-command-dispatch.js";
import { foundationSyncHandler } from "../daemon-foundation-command.js";
import { CAPABILITIES, OPERATOR_PRINCIPAL_KINDS, PAYLOAD_KEYS }
  from "../daemon-command-vocabulary.js";
import { DAEMON_COMMAND_SEAM } from "../http/http-async-contract.js";
import type { CommandHandlerInput, CommandRegistryEntry, DurableDecision }
  from "../http/http-contract.js";
import { ref } from "../json-record-shape.js";
import { PUBLISH_RESOLVE_COMMAND_KIND } from "./publish-resolve-contracts.js";
import { PUBLISH_RESOLVED_CODES, resolvePublish } from "./publish-resolve-service.js";
import type { PublishResolution } from "./publish-resolve-service.js";

const isResolution = (value: unknown): value is PublishResolution =>
  typeof value === "string" && Object.hasOwn(PUBLISH_RESOLVED_CODES, value);

/**
 * The registry entry for `repository.publish_resolve`. It lives beside `repository-recovery-command.ts`,
 * its sibling in REPOSITORY_RECOVERY_FAMILY, rather than inline in `daemon-command-async-entries.ts`,
 * which sits at the 400-line split line.
 *
 * FENCED AT ENTRY, ON THE REGISTRY'S OWN TERMS. An async entry never reaches the registry's
 * synchronous operator check (daemon-command-registry.ts), so the handler applies that same check
 * -- OPERATOR_PRINCIPAL_KINDS membership plus the configured operator principal -- with its code
 * and layer, as `release.decide`'s stub does. The vocabulary stays the one place that says the
 * kind is human-only; the same membership keeps it off the seats' MCP roster.
 *
 * THEN THE SERVICE (publish-resolve-service.ts): it records the operator's resolution as ONE
 * REFUSED receipt and never touches the repository hold, which its owning publisher gives back.
 * Every refusal it mints is row 2's; a malformed payload is refused here, before it reads anything.
 */
export function createPublishResolveCommandEntry(options: {
  readonly operatorPrincipalId: string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}): CommandRegistryEntry {
  return Object.freeze({
    asyncHandler: async ({ envelope, principal }: CommandHandlerInput): Promise<DurableDecision> => {
      if (OPERATOR_PRINCIPAL_KINDS.has(PUBLISH_RESOLVE_COMMAND_KIND)
        && principal.principalId !== options.operatorPrincipalId) {
        throw new DomainRefusal("OPERATOR_PRINCIPAL_REQUIRED", "DAEMON_AUTHORIZATION",
          "this command requires the configured operator principal", 403);
      }
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
    // ADMIN, matching REPOSITORY_RECOVERY_FAMILY: it fences REACH only. The entry fence above is
    // the human gate.
    requiredCapability: CAPABILITIES.ADMIN,
  });
}
