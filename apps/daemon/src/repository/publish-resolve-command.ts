import { DomainRefusal, domainRefusalOf } from "../daemon-command-dispatch.js";
import { foundationSyncHandler } from "../daemon-foundation-command.js";
import { CAPABILITIES, OPERATOR_PRINCIPAL_KINDS, PAYLOAD_KEYS }
  from "../daemon-command-vocabulary.js";
import type { CommandHandlerInput, CommandRegistryEntry, DurableDecision }
  from "../http/http-contract.js";
import { PUBLISH_RESOLVE_COMMAND_KIND, publishResolveRefusal } from "./publish-resolve-contracts.js";

/**
 * The registry entry for `repository.publish_resolve`, REGISTERED AND REFUSING until task-a47babf8
 * lands the resolve service. It lives beside `repository-recovery-command.ts`, its sibling in
 * REPOSITORY_RECOVERY_FAMILY, rather than inline in `daemon-command-async-entries.ts`, which sits
 * at the 400-line split line.
 *
 * FENCED AT ENTRY, ON THE REGISTRY'S OWN TERMS. An async entry never reaches the registry's
 * synchronous operator check (daemon-command-registry.ts), so the handler applies that same check
 * -- OPERATOR_PRINCIPAL_KINDS membership plus the configured operator principal -- with its code
 * and layer, as `release.decide`'s stub does. The vocabulary stays the one place that says the
 * kind is human-only; the same membership keeps it off the seats' MCP roster.
 *
 * THEN REFUSED, under row 2's closed vocabulary. It never accepts and never no-ops, so an operator
 * can never believe a publish was resolved when nothing was recorded. DECISION_NOT_FOUND is the one
 * code of the three that cannot be read as "your publish is settled": NOT_UNKNOWN and
 * REMOTE_HOLDS_SHA both would be.
 */
export function createPublishResolveCommandEntry(options: {
  readonly operatorPrincipalId: string;
}): CommandRegistryEntry {
  return Object.freeze({
    asyncHandler: async ({ principal }: CommandHandlerInput): Promise<DurableDecision> => {
      if (OPERATOR_PRINCIPAL_KINDS.has(PUBLISH_RESOLVE_COMMAND_KIND)
        && principal.principalId !== options.operatorPrincipalId) {
        throw new DomainRefusal("OPERATOR_PRINCIPAL_REQUIRED", "DAEMON_AUTHORIZATION",
          "this command requires the configured operator principal", 403);
      }
      throw domainRefusalOf(publishResolveRefusal("PUBLISH_RESOLVE_DECISION_NOT_FOUND",
        "no publish-resolve service is composed for this daemon: nothing was recorded"));
    },
    handler: foundationSyncHandler,
    kind: PUBLISH_RESOLVE_COMMAND_KIND,
    payloadKeys: PAYLOAD_KEYS[PUBLISH_RESOLVE_COMMAND_KIND],
    // ADMIN, matching REPOSITORY_RECOVERY_FAMILY: it fences REACH only. The entry fence above is
    // the human gate.
    requiredCapability: CAPABILITIES.ADMIN,
  });
}
