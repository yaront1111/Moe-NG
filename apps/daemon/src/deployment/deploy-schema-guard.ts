import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";
import { identifyReplayRequest } from "@moe/store";
import type {
  CommandDecisionKey, CommandDecisionRecord, ExpectedVersionDecisionLeg, SqliteEventStore,
} from "@moe/store";

import { decisionKey } from "../bootstrap/bootstrap-ledger.js";
import type { BootstrapRequest } from "../bootstrap/bootstrap-contracts.js";
import type { DeployMigrationPort, DeployMigrationResult } from "./deploy-ports.js";

/**
 * `deployment.deploy`'s HALF OF THE SHARED PER-ENVIRONMENT SCHEMA GUARD: the durable intent that
 * records which stream this request reserved, and the legs that take and give it back.
 *
 * IT IS A LEAF WITH NO REFUSAL VOCABULARY OF ITS OWN. Every function here answers with a STATUS or
 * a null, never a `DomainRefusal`, and `deploy-command.ts` maps those onto the seam's codes. That
 * is not tidiness: the seam module is the one place a reader can see deploy's whole refusal
 * vocabulary at once, and a leaf that threw its own codes would both hide half of it and force a
 * circular import back into the module that owns them.
 *
 * WHY DEPLOY NEEDS AN INTENT AT ALL, since it did not have one before. `deployment.rollback` and
 * `deployment.migrate_down` each commit TWICE — an intent decision at admission whose legs reserve
 * the guard, and a terminal that releases it. `deployment.deploy` commits ONCE, at the very end:
 * `admitBootstrapCommand` commits nothing, and `commitReport` is the only durable write. A
 * reservation with no durable record of what it took cannot be released by a later attempt, so
 * fencing deploy means giving it the intent it never had. This module is that intent.
 *
 * THE KEY SEPARATION IS THE SAME ONE THE OTHER TWO RELY ON. `decisionKey` is
 * (commandId, principalId, projectId) and does NOT include the kind (`bootstrap-ledger.ts`:68), so
 * re-keying the same commandId under `INTENT_PRINCIPAL` yields a decision row that is distinct from
 * the terminal's without inventing an id. `replayOf` looks up the TERMINAL key only
 * (`bootstrap-ledger.ts`:258), so an interrupted deploy is NOT replayed and its commandId re-runs
 * the whole handler — which is exactly why the intent has to be readable on that second pass.
 */

/** The intent decision's kind. UNROSTERED ON PURPOSE, exactly as `internal.deployment.rollback_requested`
 *  and `internal.deployment.migrate_down_requested` are: it is a decision-ledger kind, absent from
 *  `daemon-command-vocabulary.ts` and from every served command roster, so it adds no dispatchable
 *  command and no contract-digest mirror has to be re-censused for it. */
export const DEPLOY_SCHEMA_INTENT_KIND = "internal.deployment.deploy_requested" as const;

/** The principal the intent decision is keyed under. Its two precedents are
 *  `daemon:rollback-command` (`rollback-command.ts`:36) and `daemon:migrate-down-command`
 *  (`migrate-down-admission.ts`:13); this is the third member of that convention and is never a
 *  principal any caller can authenticate as. */
export const DEPLOY_SCHEMA_INTENT_PRINCIPAL = "daemon:deploy-command" as const;

/** The guard stream's reserve event. Named for the COMMAND that took it so a stream's history
 *  reads as which command held it when, which is the one question an operator staring at an odd
 *  guard actually has. */
export const DEPLOY_SCHEMA_RESERVED_EVENT = "EnvironmentDeploySchemaReserved" as const;

/** The guard stream's release event, the even-parity twin of the reserve. */
export const DEPLOY_SCHEMA_RELEASED_EVENT = "EnvironmentDeploySchemaReleased" as const;

const encoder = new TextEncoder();

/** WHICH STREAM THIS REQUEST RESERVED, AND AT WHAT VERSION. Both halves are recorded durably and
 *  read back rather than re-derived: the release leg's `expectedVersion` has to be the version this
 *  request TOOK, and its aggregate has to be the stream this request really reserved, or the
 *  terminal can never agree with the store and the commandId is stranded forever. */
export interface DeploySchemaReservation {
  readonly guardId: string;
  readonly guardVersion: number;
}

/**
 * THE INTENT'S REQUEST PREIMAGE, AND IT DELIBERATELY CARRIES NO CLOCK.
 *
 * `bootstrapRequestBytes` folds `decidedAt` into its bytes, which is correct for a terminal decided
 * once — but an interrupted deploy re-runs its handler and calls `clock()` again, so those bytes
 * differ between the attempt that reserved and the attempt that must release. Keying the intent's
 * replay proof on them would make every recovery look like a different request and strand exactly
 * the case this intent exists to rescue. Everything else that identifies the request is here —
 * kind, command id, correlation, offered version, principal, project and the full admitted payload,
 * which carries the environment and sha and the derived `goalId` — so two requests that differ in
 * any of those produce different bytes and a recovering attempt that is not the same request is
 * refused rather than handed a stream it never took.
 */
export function deployIntentRequestBytes(request: BootstrapRequest): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId: request.commandId,
    correlationId: request.correlationId,
    expectedVersion: request.expectedVersion,
    kind: DEPLOY_SCHEMA_INTENT_KIND,
    payload: request.payload,
    principalId: request.principalId,
    projectId: request.projectId,
  }));
}

/** The intent's decision key: the terminal's key re-principalled, never a separately minted id.
 *  Built through `decisionKey` rather than by hand so the two can never drift on the two fields
 *  they do share. */
export function deployIntentKey(request: BootstrapRequest): CommandDecisionKey {
  return { ...decisionKey(request), principalId: DEPLOY_SCHEMA_INTENT_PRINCIPAL };
}

/** The store surface this leaf touches, named rather than taking the whole store: it reads one
 *  aggregate version and commits one decision, and a narrower type is what keeps that true. */
export type DeploySchemaStore = Pick<SqliteEventStore,
  "commitExpectedVersionDecisionLegs" | "getAggregateVersion" | "getCommandDecision">;

/**
 * THE TAKE. Reads the shared guard's parity, and on an EVEN (free) stream commits the intent
 * decision whose single leg appends the reserve event — so the parity flip and the durable record
 * of what was taken are ONE commit and neither can exist without the other.
 *
 * ANSWERS `null` FOR EVERY WAY THIS CAN FAIL TO TAKE THE STREAM, and they are three: an ODD stream
 * (another command holds this environment's schema), a leg whose expected version was stale by the
 * time the commit ran (another command won the race between the read and the write — the store
 * reports it in `effectDisposition` rather than throwing), and a REPLAYED admission (another
 * process already committed this exact intent, so IT owns execution and this one must not migrate).
 * All three mean the same thing to the caller — this request does not hold the environment — and
 * the caller answers `DEPLOY_ENVIRONMENT_SCHEMA_BUSY` for all three.
 *
 * THE GUARD STREAM IS THE PRIMARY LEG, deliberately. `legs[0]` is the leg the decision record
 * describes and the one that must append an event, and the reserve IS this decision's whole
 * business effect: deploy has no request stream of its own to write, because its request is already
 * recorded by the terminal decision on the project stream. A second leg fencing the project
 * aggregate is NOT taken here — this reserve happens MID-FLIGHT rather than at admission, and the
 * project version was already agreed at admission (`deploy-command.ts`'s stale-version check) and
 * is agreed again by the terminal's own leg. Fencing it a third time here would refuse deploys for
 * project events that landed during a docker build, which this row is not about.
 */
export function reserveDeploySchemaGuard(
  store: DeploySchemaStore, request: BootstrapRequest, guardId: string, decidedAt: string,
): DeploySchemaReservation | null {
  const priorGuardVersion = store.getAggregateVersion(guardId);
  if (priorGuardVersion % 2 !== 0) return null;
  const guardVersion = priorGuardVersion + 1;
  const requestBytes = deployIntentRequestBytes(request);
  const admitted = store.commitExpectedVersionDecisionLegs({
    commandKind: DEPLOY_SCHEMA_INTENT_KIND,
    // THE STREAM THIS REQUEST ACTUALLY RESERVED, AND THE VERSION IT TOOK, recorded so a later
    // attempt releases THAT stream at THAT version rather than re-deriving either. Same shape and
    // same reason as `rollback-command.ts`:250.
    committedResultBytes: encoder.encode(JSON.stringify({ guardId, guardVersion })),
    correlationId: request.correlationId,
    decidedAt,
    key: deployIntentKey(request),
    legs: [{
      aggregateId: guardId, expectedVersion: priorGuardVersion,
      events: [{
        eventId: `${request.commandId}-deploy-schema-reserved`,
        eventType: DEPLOY_SCHEMA_RESERVED_EVENT, payload: requestBytes,
      }],
    }],
    requestBytes,
  });
  if (admitted.decision.effectDisposition !== "EFFECTS_COMMITTED") return null;
  if (admitted.disposition === "REPLAYED") return null;
  return { guardId, guardVersion };
}

/**
 * THE PUT, as a leg rather than a commit of its own: the release rides inside the terminal
 * decision, so a deploy cannot record its outcome without giving the environment back and cannot
 * give the environment back without recording its outcome. That is a property of the store's
 * multi-leg commit, not of a call site remembering to do both.
 *
 * `expectedVersion` IS THE RECORDED VERSION, never a fresh `getAggregateVersion` read. A re-read
 * would appear to work in a single-threaded arm and be wrong the moment anything else touched the
 * stream — the leg would then agree with a parity this request did not take and release someone
 * else's reservation.
 */
export function deploySchemaReleaseLeg(
  reservation: DeploySchemaReservation, commandId: string, result: unknown,
): ExpectedVersionDecisionLeg {
  return {
    aggregateId: reservation.guardId,
    expectedVersion: reservation.guardVersion,
    events: [{
      eventId: `${commandId}-deploy-schema-released`,
      eventType: DEPLOY_SCHEMA_RELEASED_EVENT,
      payload: encoder.encode(JSON.stringify(result)),
    }],
  };
}

/**
 * THE MUTABLE HOLD, and it exists because a deploy's reservation is taken DEEP INSIDE the engine's
 * sequence and released at the seam, with the engine between them. `reservation` travels forward to
 * the terminal; `busy` travels to the handler's tail.
 *
 * `busy` IS A FLAG RATHER THAN A THROW because a throw cannot carry this refusal out:
 * `migrateFor` (`deploy-service.ts`:157-161) catches anything the migrate port throws and flattens
 * it to a `DEPLOY_BUILD_FAILED` detail, so a `DomainRefusal` raised here would reach the operator
 * wearing the ENGINE's code and the ENGINE's layer. The refusal is RETURNED as an ordinary
 * migration result — honest, because the migration genuinely did not run — and the seam mints its
 * own code once the engine has reported.
 */
export interface DeploySchemaHold {
  busy: boolean;
  reservation: DeploySchemaReservation | null;
}

export interface GuardedDeployMigration {
  /** The migration result a busy guard answers with. The SEAM owns the code and the layer; this
   *  leaf only forwards the value, which is what keeps deploy's refusal vocabulary in one module. */
  readonly busy: DeployMigrationResult;
  readonly guardIdFor: (environment: string) => string;
  readonly hold: DeploySchemaHold;
  readonly inner: DeployMigrationPort;
  readonly now: () => string;
  readonly request: BootstrapRequest;
  readonly store: DeploySchemaStore;
}

/**
 * THE MIGRATION PORT, FENCED. Wraps whatever `migrate` member the composition supplies rather than
 * living inside the production one, because `options.ports` REPLACES the whole ports object: a
 * guard inside the production closure would fence the production path and silently fence nothing
 * else. Wrapping is also what makes "the inner migrate recorded zero calls" the literal meaning of
 * a refusal here — a busy environment is not touched, not even to discover that it is busy.
 *
 * A RESERVATION ALREADY IN THE HOLD IS NOT RE-TAKEN. That is the recovery case: a re-issued command
 * id whose intent was read before the engine ran already holds this environment, and re-checking
 * parity there would make the request refuse the reservation its OWN earlier attempt committed.
 */
export function guardDeployMigration(guarded: GuardedDeployMigration): DeployMigrationPort {
  const { busy, guardIdFor, hold, inner, now, request, store } = guarded;
  return async (environment: string, sha: string, decisionId: string) => {
    if (hold.reservation === null) {
      hold.reservation = reserveDeploySchemaGuard(
        store, request, guardIdFor(environment), now(),
      );
      if (hold.reservation === null) {
        hold.busy = true;
        return busy;
      }
    }
    return inner(environment, sha, decisionId);
  };
}

/**
 * WHAT A PRIOR ATTEMPT OF THIS COMMAND ID LEFT BEHIND. Answers the reservation it recorded, a hold
 * with no reservation when there is no prior attempt, or `null` when the intent on record is not
 * this request's — which the seam turns into `DEPLOY_ENVIRONMENT_SCHEMA_INTENT_CONFLICT`.
 *
 * IT RUNS IN THE HANDLER, BEFORE THE ENGINE, NOT INSIDE THE MIGRATE WRAPPER, and that placement is
 * the whole difference between a recoverable environment and a permanently unavailable one.
 * `readReplay` (`deploy-service.ts`:274) returns BEFORE the migration whenever a deploy receipt for
 * this decision id already exists. So a deploy that reserved, migrated, recorded its receipt and
 * then died before its terminal would — on the re-issue its recovery depends on — never reach the
 * wrapper at all, commit a terminal with no release leg, and leave the guard ODD FOREVER. Read
 * here, the reservation reaches the terminal down every path the engine can take, including the
 * replay one.
 *
 * NO LEGACY FALLBACK, AND THAT IS NOT AN OMISSION. `rollback-command.ts` and
 * `migrate-down-admission.ts` each accept an intent carrying no `guardId` because theirs predate
 * the shared stream and would otherwise be stranded. `deployment.deploy` was NEVER fenced before
 * this change, so no deploy intent without a `guardId` can exist; accepting one would mean
 * deriving a stream from thin air and releasing something this request never took. The roster is
 * closed to exactly `{guardId, guardVersion}` and anything else fails closed.
 *
 * THE UNKNOWN-OUTCOME WINDOW IS NOT WIDENED HERE. A throw escaping between the reserve and the
 * terminal still leaves the guard ODD on purpose — the schema's state is unknown, so nothing else
 * may move it. What this reader buys is that re-issuing the SAME command id finishes the request
 * and gives the environment back, which is the recovery the other two commands already have.
 */
export function openDeploySchemaHold(
  store: Pick<DeploySchemaStore, "getCommandDecision">, request: BootstrapRequest,
): DeploySchemaHold | null {
  const intent = store.getCommandDecision(deployIntentKey(request));
  if (intent === null) return { busy: false, reservation: null };
  const reservation = recordedReservation(intent, request);
  return reservation === null ? null : { busy: false, reservation };
}

/**
 * THE INTENT'S IDENTITY AND ITS RECORDED PAIR, both or neither.
 *
 * The identity assert is the same one `rollback-command.ts`:64-72 and
 * `migrate-down-admission.ts`:50-62 perform, and it is load-bearing rather than hygienic: the same
 * command id resubmitted under a DIFFERENT payload runs this handler from the top, and without the
 * byte compare it would adopt the earlier request's reservation and release a stream it never took.
 *
 * `targetAggregateId` IS COMPARED TO THE RECORDED ID rather than to a fresh derivation. A fresh one
 * would re-answer the question the record exists to answer, and would refuse every request that
 * reserved before any future change to the derivation — the exact stranding the predecessor's
 * upgrade-hazard note describes.
 */
function recordedReservation(
  intent: CommandDecisionRecord, request: BootstrapRequest,
): DeploySchemaReservation | null {
  if (intent.commandKind !== DEPLOY_SCHEMA_INTENT_KIND
    || intent.effectDisposition !== "EFFECTS_COMMITTED"
    || identifyReplayRequest(intent, deployIntentRequestBytes(request)) !== intent.replayRequestSha256) {
    return null;
  }
  const decoded = decodeBoundedJsonBytes(intent.resultBytes);
  if (!decoded.ok || decoded.value === null || typeof decoded.value !== "object"
    || Array.isArray(decoded.value)) return null;
  // Cast after `Array.isArray` has excluded the array arm, exactly as `migrate-down-admission.ts`:81
  // does: the decoder's value type is `JsonObject | readonly JsonValue[]` and the narrowing does not
  // survive an index read.
  const value = decoded.value as JsonObject;
  if (Object.keys(value).sort().join(",") !== "guardId,guardVersion") return null;
  const guardId = value["guardId"], guardVersion = value["guardVersion"];
  if (typeof guardId !== "string" || guardId.length === 0 || guardId !== intent.targetAggregateId
    || typeof guardVersion !== "number" || !Number.isSafeInteger(guardVersion)
    || guardVersion <= 0 || guardVersion % 2 !== 1) return null;
  return { guardId, guardVersion };
}
