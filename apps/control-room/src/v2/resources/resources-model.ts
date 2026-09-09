import type { ActivationReadOutcome, ActivationReceiptView } from "../../live/live-activation.js";
import type { HealthOutcome, PolicyOutcome } from "../../live/live-ops.js";
import type { RepositoryRemoteOutcome } from "../../live/live-repository-remote.js";
import type { SessionsOutcome } from "../../live/live-sessions.js";
import { CREDENTIAL_SOURCE_UNRECOGNISED, RESOURCES_LAYER, credentialSource, credentialSourceWords } from "./resources-credential.js";
import type { CredentialSource } from "./resources-credential.js";

/**
 * THE PROJECT'S MEASURED FACTS, one fact per row, folded from the reads the daemon
 * ALREADY serves. Pure: no fetch, no clock, every arm assertable by value.
 *
 * Two properties this module exists to hold.
 *
 * NO CREDENTIAL VALUE EVER REACHES A ROW. The provider row states the credential's
 * SOURCE - an environment variable's NAME, or that a sign-in file was found - and is
 * built ONLY from `credentialSource()`, a CLOSED grammar over the activation receipt's
 * ref. Anything the grammar does not recognise renders as a refusal code rather than as
 * text, so a value that rides in on a field renders NOTHING instead of rendering itself.
 * The daemon already scrubs values at the boundary that publishes
 * (apps/daemon/src/http/activation-read.ts, `secretValues`/`scrub`); this is the second
 * fence, not a second scrub, and no free-form `reason` from any read is rendered here.
 *
 * A FACT IS NEVER SILENTLY OMITTED. A read that refuses turns ITS OWN facts into
 * REFUSED rows carrying the daemon's code and layer, and leaves every other fact
 * standing. Omitting a fact would say "this project has no such resource", which is a
 * different and false claim from "I could not read it".
 */

/** No read this build consumes carries the fact. Stated, never omitted. */
export const FACT_NOT_SERVED = "RESOURCES_FACT_NOT_SERVED";
/** The activation roster answered without the receipt this fact is folded from. */
export const RECEIPT_ABSENT = "RESOURCES_RECEIPT_ABSENT";
/** A carrier stated the store path as an empty string, which is not a path. */
export const STORE_PATH_EMPTY = "RESOURCES_STORE_PATH_EMPTY";

export interface ResourceRefusal { readonly code: string; readonly layer: string }

export type ResourceFactState =
  | { readonly kind: "MEASURED"; readonly value: string }
  | { readonly kind: "PENDING" }
  | { readonly kind: "REFUSED"; readonly refusal: ResourceRefusal; readonly said: string };

export interface ResourceFact {
  readonly id: string;
  readonly label: string;
  readonly state: ResourceFactState;
}

export interface ResourceSection {
  readonly id: string;
  readonly title: string;
  readonly facts: readonly ResourceFact[];
}

/** Every read the screen folds. `null` means that read has not answered yet. */
export interface ResourceReads {
  readonly activation: ActivationReadOutcome | null;
  readonly health: HealthOutcome | null;
  readonly policy: PolicyOutcome | null;
  readonly remote: RepositoryRemoteOutcome | null;
  readonly sessions: SessionsOutcome | null;
}

const measured = (value: string): ResourceFactState =>
  Object.freeze({ kind: "MEASURED" as const, value });
const pending = (): ResourceFactState => Object.freeze({ kind: "PENDING" as const });
const refused = (code: string, layer: string, said: string): ResourceFactState =>
  Object.freeze({ kind: "REFUSED" as const, refusal: Object.freeze({ code, layer }), said });
const unserved = (said: string): ResourceFactState => refused(FACT_NOT_SERVED, RESOURCES_LAYER, said);

const fact = (id: string, label: string, state: ResourceFactState): ResourceFact =>
  Object.freeze({ id, label, state });

const receiptOf = (
  members: readonly ActivationReceiptView[], member: string,
): ActivationReceiptView | undefined => members.find((row) => row.member === member);

/**
 * A receipt's own answer, folded WITHOUT its free-form `reason`: measured hands the
 * caller its value, unmeasured renders the receipt's stable code and layer verbatim.
 */
function fromReceipt(
  members: readonly ActivationReceiptView[], member: string, said: string,
  value: (receipt: ActivationReceiptView) => ResourceFactState,
): ResourceFactState {
  const receipt = receiptOf(members, member);
  if (receipt === undefined) return refused(RECEIPT_ABSENT, RESOURCES_LAYER, said);
  if (!receipt.measured) {
    return refused(receipt.code ?? RECEIPT_ABSENT, receipt.layer ?? RESOURCES_LAYER, said);
  }
  return value(receipt);
}

/** Applies an activation read's refusal to every fact folded from it. */
function activationState(
  activation: ActivationReadOutcome | null, said: string,
  fold: (answer: Extract<ActivationReadOutcome, { status: "ACTIVATION" }>) => ResourceFactState,
): ResourceFactState {
  if (activation === null) return pending();
  if (activation.status !== "ACTIVATION") return refused(activation.code, activation.layer, said);
  return fold(activation);
}

const REPO_SAID = "The repository facts could not be read right now.";
const PROVIDER_SAID = "The provider facts could not be read right now.";
const STORE_SAID = "The store facts could not be read right now.";

function repositorySection(reads: ResourceReads): ResourceSection {
  const repo = (
    id: string, label: string, pick: (view: { readonly headSha: string; readonly toplevel: string }) => string,
  ): ResourceFact => fact(id, label, activationState(reads.activation, REPO_SAID, (answer) => (
    answer.repository === null
      ? fromReceipt(answer.members, "repository", REPO_SAID, () => refused(RECEIPT_ABSENT, RESOURCES_LAYER, REPO_SAID))
      : measured(pick(answer.repository))
  )));
  const remote = reads.remote;
  return Object.freeze({
    facts: Object.freeze([
      repo("root", "Repository root", (view) => view.toplevel),
      repo("head", "HEAD commit", (view) => view.headSha),
      fact("branch", "Checked-out branch", unserved(
        "No read this daemon serves states the checked-out branch, so this build cannot show it.",
      )),
      fact("remote", "Bound git remote", remote === null
        ? pending()
        : remote.status !== "REMOTE"
          ? refused(remote.code, remote.layer, "The bound remote could not be read right now.")
          : measured(remote.remoteUrl ?? "none bound")),
    ]),
    id: "repository",
    title: "Repository",
  });
}

/**
 * THE PROVIDER SECTION. Both rows are built from `credentialSource()` alone. No field
 * of the receipt other than its stable code, its layer and the parsed source is read.
 */
function providerSection(reads: ResourceReads): ResourceSection {
  const source = (pick: (parsed: CredentialSource) => string): ResourceFactState =>
    activationState(reads.activation, PROVIDER_SAID, (answer) => fromReceipt(
      answer.members, "provider", PROVIDER_SAID, (receipt) => {
        const parsed = credentialSource(receipt.ref);
        return parsed === null
          ? refused(CREDENTIAL_SOURCE_UNRECOGNISED, RESOURCES_LAYER,
            "The provider credential's source was not stated in a form this screen can show.")
          : measured(pick(parsed));
      },
    ));
  return Object.freeze({
    facts: Object.freeze([
      fact("cli", "Agent CLI", source((parsed) => parsed.cli)),
      fact("credential", "Credential source", source((parsed) => credentialSourceWords(parsed.source))),
    ]),
    id: "provider",
    title: "Provider",
  });
}

/**
 * The store path is carried by BOTH `/activation/read` and `/health/read`, and a refusal
 * from one does not blank the row while the other still states it.
 *
 * THE TWO CARRIERS ARE NOT EQUALLY STRICT, which is why the empty case is handled here
 * rather than assumed away. `/activation/read`'s decoder requires a NON-EMPTY path
 * (live-activation.ts:204-206, `nonEmptyString`), so an empty one there fails the whole
 * frame and never reaches this fold. `/health/read`'s checks only the TYPE
 * (live-ops.ts:244, `typeof daemon.storePath !== "string"`), so `""` decodes cleanly and
 * does reach here. Rendering it would give the operator a blank row that reads as a bug
 * rather than as a fact, so an empty answer falls through to the other carrier, and the
 * row refuses with a code when neither states a path.
 */
function storePath(reads: ResourceReads): ResourceFactState {
  const health = reads.health;
  const healthPath = health !== null && health.status === "HEALTH" ? health.daemon.storePath : "";
  if (healthPath !== "") return measured(healthPath);
  const fromActivation = activationState(reads.activation, STORE_SAID, (answer) => (
    answer.store === null
      ? fromReceipt(answer.members, "store", STORE_SAID, () => refused(RECEIPT_ABSENT, RESOURCES_LAYER, STORE_SAID))
      : measured(answer.store.storePath)
  ));
  if (fromActivation.kind === "MEASURED" || health === null) return fromActivation;
  return health.status === "HEALTH"
    ? refused(STORE_PATH_EMPTY, RESOURCES_LAYER, STORE_SAID)
    : refused(health.code, health.layer, STORE_SAID);
}

function storeSection(reads: ResourceReads): ResourceSection {
  return Object.freeze({
    facts: Object.freeze([
      fact("path", "Store file", storePath(reads)),
      fact("size", "Store size on disk", unserved(
        "No read this daemon serves measures the store's size on disk, so this build cannot show it.",
      )),
      fact("backup", "Last store backup", activationState(reads.activation, STORE_SAID, (answer) => fromReceipt(
        answer.members, "backup", STORE_SAID, (receipt) => measured(receipt.ref ?? "taken, with no ref stated"),
      ))),
      fact("distribution", "Distribution", activationState(reads.activation, STORE_SAID, (answer) => (
        answer.distribution === null
          ? fromReceipt(answer.members, "distribution", STORE_SAID, () => refused(RECEIPT_ABSENT, RESOURCES_LAYER, STORE_SAID))
          : measured(`${answer.distribution.kind} at ${answer.distribution.root}`)
      ))),
    ]),
    id: "store",
    title: "Store",
  });
}

function governanceSection(reads: ResourceReads): ResourceSection {
  const policy = reads.policy;
  const sessions = reads.sessions;
  const seats = (pick: (concurrency: SessionsConcurrencyView) => number): ResourceFactState =>
    sessions === null
      ? pending()
      : sessions.status !== "SESSIONS"
        ? refused(sessions.code, sessions.layer, "The seat facts could not be read right now.")
        : measured(String(pick(sessions.concurrency)));
  return Object.freeze({
    facts: Object.freeze([
      fact("policy", "Policy revision", policy === null
        ? pending()
        : policy.status !== "POLICY"
          ? refused(policy.code, policy.layer, "The policy revision could not be read right now.")
          : measured(String(policy.aggregateVersion))),
      fact("seatlimit", "Configured seat limit", seats((concurrency) => concurrency.configuredAgentLimit)),
      fact("seatsactive", "Seats in use", seats((concurrency) => concurrency.activeSeats)),
    ]),
    id: "governance",
    title: "Policy and seats",
  });
}

type SessionsConcurrencyView = Extract<SessionsOutcome, { status: "SESSIONS" }>["concurrency"];

/** Every section, in screen order. Always the same rows: a fact is refused, never dropped. */
export function resourceSections(reads: ResourceReads): readonly ResourceSection[] {
  return Object.freeze([
    repositorySection(reads),
    providerSection(reads),
    storeSection(reads),
    governanceSection(reads),
  ]);
}
