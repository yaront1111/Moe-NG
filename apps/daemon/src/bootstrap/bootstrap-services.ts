import { RUNTIME_LIFECYCLES } from "@moe/contracts";
import type { JsonValue } from "@moe/contracts";
import { reduceProject } from "@moe/core";
import type { ProjectCommand, ProjectState } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { decodeBootstrapRequestBytes } from "./bootstrap-contracts.js";
import type { BootstrapRequest } from "./bootstrap-contracts.js";
import {
  aggregateIdFor,
  commitAccepted,
  missingPrerequisites,
  payloadObject,
  payloadRef,
  readDurableLedger,
  refuse,
  refuseFromCore,
  replayOf,
  stateOf,
  versionOf,
} from "./bootstrap-ledger.js";
import type {
  CommandHandler,
  HandlerContext,
  HandlerTable,
  HumanReviewWitness,
  ServiceOutcome,
} from "./bootstrap-ledger.js";
import { activationWitnessOf, signingReceipt } from "./activation-receipts.js";
import type { ActivationReceipts } from "./activation-receipts.js";
import { installPolicy, validatePolicy } from "./bootstrap-policy-services.js";
import { admitProviderProfile } from "../provider-profile/provider-profile-codec.js";
import {
  PROFILE_REGISTRATION,
  PROVIDER_PROBED_EVENT,
  conflictsWithProfileHistory,
  providerProbePayload,
} from "../provider-profile/provider-profile-registration.js";
import { admitProviderRuntimeObservation } from "../provider-profile/provider-runtime-observation.js";
import type { ProviderRuntimeObservation } from "../provider-profile/provider-runtime-observation.js";

/**
 * Project-scoped bootstrap services and the pipeline every command in this task runs through.
 *
 * A service composes and never decides: it decodes, looks up a replay, reads durable state,
 * checks the durable sequence, and hands the command to the `@moe/core` reducer that owns it.
 * A core rejection is surfaced with the core's own reason code, never translated, so evidence
 * always shows which of the three layers refused.
 */

const TRUTH_CLASSES: ReadonlySet<string> = new Set<string>(RUNTIME_LIFECYCLES.TRUTH_CLASS);

function priorProject(context: HandlerContext, aggregateId: string): ProjectState | undefined {
  const state = stateOf(context.ledger, aggregateId);
  if (state === undefined || state === null) return undefined;
  return state as unknown as ProjectState;
}

/**
 * One shape for every project command: reduce, then commit only on acceptance.
 *
 * Passing a rejected verdict through to the store would still write a `NO_BUSINESS_EFFECT`
 * audit row, so refusing here is what keeps the durable decision count unchanged for a
 * hostile input.
 */
function reduceAndCommit(context: HandlerContext, command: ProjectCommand): ServiceOutcome {
  const { ledger, request, store } = context;
  const aggregateId = aggregateIdFor(request, null);
  const verdict = reduceProject(priorProject(context, aggregateId), command);
  if (!verdict.ok) return refuseFromCore(request.kind, verdict.error);
  const [event] = verdict.events;
  return commitAccepted(store, request, {
    aggregateId,
    eventPayload: (event ?? null) as unknown as JsonValue,
    eventType: event === undefined ? "ProjectChanged" : event.kind,
    expectedVersion: versionOf(ledger, aggregateId),
    result: verdict.state as unknown as JsonValue,
  });
}

const registerProject: CommandHandler = (context): ServiceOutcome => {
  const { request } = context;
  const owner = payloadRef(request.payload, "owner");
  if (owner === null) {
    return refuse(request.kind, "BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  return reduceAndCommit(context, {
    commandId: request.commandId,
    expectedVersion: request.expectedVersion,
    kind: "project.register",
    owner,
    projectId: request.projectId,
  });
};

const bindRepository: CommandHandler = (context): ServiceOutcome => {
  const { request } = context;
  const observation = payloadObject(request.payload, "observation");
  if (observation === null) {
    return refuse(request.kind, "BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  return reduceAndCommit(context, {
    commandId: request.commandId,
    expectedVersion: request.expectedVersion,
    kind: "project.bind_repository",
    observation,
  } as unknown as ProjectCommand);
};

/**
 * What a composition that wired NOTHING is judged against. Every member is absent, so
 * `activationWitnessOf` answers with all six refusals and the activation fails closed: an
 * unwired daemon gets an honest ACTIVATION_REPOSITORY_UNMEASURED rather than an invented ref.
 */
const UNMEASURED_RECEIPTS: ActivationReceipts = Object.freeze({
  distribution: null,
  measuredAt: "",
  members: Object.freeze([]),
  repository: null,
  schemaVersion: "moe-activation-receipts/1" as const,
  signing: signingReceipt(),
  store: null,
});

/**
 * THE DAEMON MINTS THE ACTIVATION WITNESS. IT NEVER ACCEPTS ONE.
 *
 * This handler used to read `payload.witness` and hand the CALLER'S OBJECT straight to the core
 * reducer, so any caller (the browser, the seed, an authenticated agent session) could invent an
 * artifact path, a backup ref and two digests and have the daemon commit them as DAEMON_VERIFIED
 * authority. The nine keys now come from receipts THIS daemon measured.
 *
 * A caller-supplied witness is REFUSED with its own code rather than silently ignored. The
 * distinction is not cosmetic: dropping the field would let an operator watch an activation
 * succeed and believe they had supplied the authority behind it, which is the same false belief
 * the old behaviour created, only quieter. `"witness"` therefore deliberately STAYS in the
 * command vocabulary's payload-key roster: the HTTP ingress allow-list refuses an UNLISTED key
 * with a generic INPUT_INVALID at PAYLOAD_SHAPE before any handler runs, and that generic
 * refusal is exactly the unhelpful answer this code exists to replace.
 *
 * FAIL CLOSED, WHOLE, PER MEMBER: one unmeasurable receipt refuses the ENTIRE activation with
 * that member's own code and its own layer, and commits nothing. There is no partial witness and
 * no defaulted key, because a padded member would be an invented ref wearing a measurement's
 * clothes. `activationWitnessOf` reports EVERY gap and the first is surfaced as the outcome's
 * code, so an operator is told which receipt to go and fix.
 */
const activateProject: CommandHandler = (context): ServiceOutcome => {
  const { receipts, request } = context;
  if (payloadObject(request.payload, "witness") !== null) {
    return refuse(request.kind, "ACTIVATION_WITNESS_CALLER_SUPPLIED", "DAEMON_INGRESS");
  }
  const assembly = activationWitnessOf(receipts ?? UNMEASURED_RECEIPTS);
  if (!assembly.ok) {
    const [first] = assembly.refusals;
    if (first === undefined) return refuse(request.kind, "UNKNOWN_ERROR", "DAEMON_INGRESS");
    return refuse(request.kind, first.code, first.layer);
  }
  return reduceAndCommit(context, {
    commandId: request.commandId,
    expectedVersion: request.expectedVersion,
    kind: "project.activate",
    witness: assembly.witness,
  } as unknown as ProjectCommand);
};

/**
 * Provider probe has no core reducer, but it is not therefore unowned: it is the ONLY seam
 * through which an operator-configured provider profile becomes durable authority. Nothing
 * else — no dispatch request, no runtime observation — may supply a model, an effort, a
 * concurrency ceiling or a limit.
 *
 * Four layers can refuse here and each names itself. The envelope shape stays with the
 * existing `DAEMON_INGRESS` guard, so a hostile `truthClass` still answers first and the new
 * codes cannot absorb it. The profile body is judged by the profile codec and the runtime
 * observation section by its own codec, each returning its own code and layer. Agreement
 * between the envelope's ref and the body's, and immutability of a `profileRevisionId` already
 * on record, are registration facts and refuse as such.
 *
 * The observation section is OPTIONAL — a probe predating it is legal and simply files no
 * runtime evidence — but a section that is PRESENT and inadmissible refuses the whole probe.
 * Dropping it would persist a profile the operator believes came with observed runtime facts.
 */
const recordProbe: CommandHandler = (context): ServiceOutcome => {
  const { ledger, request, store } = context;
  const aggregateId = aggregateIdFor(request, null);
  const observation = payloadObject(request.payload, "observation");
  const profileRef = observation === null ? null : payloadRef(observation, "providerMinimumProfileRef");
  const truthClass = observation === null ? null : payloadRef(observation, "truthClass");
  if (observation === null || profileRef === null || truthClass === null) {
    return refuse(request.kind, "BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  if (!TRUTH_CLASSES.has(truthClass)) {
    return refuse(request.kind, "BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  const admission = admitProviderProfile(observation.profile);
  if (!admission.ok) return refuse(request.kind, admission.issue.code, admission.issue.layer);
  const { revision } = admission;
  let runtime: ProviderRuntimeObservation | null = null;
  if (observation.runtime !== undefined) {
    const admitted = admitProviderRuntimeObservation(observation.runtime);
    if (!admitted.ok) return refuse(request.kind, admitted.issue.code, admitted.issue.layer);
    runtime = admitted.observation;
  }
  if (profileRef !== revision.providerMinimumProfileRef) {
    return refuse(request.kind, "PROVIDER_PROFILE_REF_MISMATCH", PROFILE_REGISTRATION);
  }
  if (request.expectedVersion !== versionOf(ledger, aggregateId)) {
    return refuse(request.kind, "BOOTSTRAP_EXPECTED_VERSION_STALE", "DAEMON_PREREQUISITE");
  }
  if (conflictsWithProfileHistory(store, aggregateId, revision, runtime)) {
    return refuse(request.kind, "PROVIDER_PROFILE_IMMUTABILITY_CONFLICT", PROFILE_REGISTRATION);
  }
  const persisted = providerProbePayload(profileRef, truthClass, revision, runtime);
  return commitAccepted(store, request, {
    aggregateId,
    eventPayload: persisted,
    eventType: PROVIDER_PROBED_EVENT,
    expectedVersion: versionOf(ledger, aggregateId),
    result: persisted,
  });
};

export const BOOTSTRAP_HANDLERS: HandlerTable = Object.freeze({
  "policy.install": installPolicy,
  "policy.validate": validatePolicy,
  "project.activate": activateProject,
  "project.bind_repository": bindRepository,
  "project.register": registerProject,
  "provider.probe": recordProbe,
});

/**
 * The pipeline. Replay lookup precedes the reducers deliberately: a reducer compares
 * `expectedVersion` against current version, so an identical second request would be rejected
 * by the core and could never be recognised as the replay it is.
 */
export function runBootstrapCommand(
  store: SqliteEventStore,
  input: unknown,
  handlers: HandlerTable = BOOTSTRAP_HANDLERS,
  humanReview?: HumanReviewWitness,
  receipts?: ActivationReceipts,
): ServiceOutcome {
  const admitted = admitBootstrapCommand(store, input, handlers);
  if ("outcome" in admitted) return admitted.outcome;
  const { handler, ledger, request } = admitted;
  // BOTH witnesses travel only from this call's own arguments — never off the decoded
  // bytes — so a payload can present neither the human review (see HumanReviewWitness)
  // nor the activation receipts the daemon measured for itself.
  return handler(Object.freeze({
    ledger,
    request,
    store,
    ...(humanReview === undefined ? {} : { humanReview }),
    ...(receipts === undefined ? {} : { receipts }),
  }));
}

export type BootstrapAdmission =
  | { readonly outcome: ServiceOutcome }
  | {
    readonly handler: CommandHandler;
    readonly ledger: HandlerContext["ledger"];
    readonly request: BootstrapRequest;
  };

/**
 * The gates that answer BEFORE any handler: ingress decode, the replay fence, a known kind and
 * the durable prerequisites. Exposed on its own so a caller whose witness is EXPENSIVE to make
 * (project.activate measures receipts, which takes a full store backup) can ask "would this
 * command reach its handler at all?" first and skip the measurement for a replay or a refusal —
 * every activate attempt used to take a backup, replays and payload-refused ones included.
 */
export function admitBootstrapCommand(
  store: SqliteEventStore,
  input: unknown,
  handlers: HandlerTable = BOOTSTRAP_HANDLERS,
): BootstrapAdmission {
  const decoded = decodeBootstrapRequestBytes(input);
  if (!decoded.ok) return { outcome: refuse(null, decoded.code, "DAEMON_INGRESS") };

  const request: BootstrapRequest = decoded.request;
  const replay = replayOf(store, request);
  if (replay !== null) return { outcome: replay };

  const handler = handlers[request.kind];
  if (handler === undefined) {
    return { outcome: refuse(request.kind, "BOOTSTRAP_COMMAND_UNKNOWN", "DAEMON_INGRESS") };
  }

  const ledger = readDurableLedger(store, request.projectId);
  const missing = missingPrerequisites(ledger, request.kind);
  if (missing.length > 0) {
    return { outcome: refuse(request.kind, "BOOTSTRAP_PREREQUISITE_MISSING", "DAEMON_PREREQUISITE") };
  }
  return { handler, ledger, request };
}
