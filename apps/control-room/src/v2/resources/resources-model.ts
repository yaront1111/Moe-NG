import type { ActivationReadOutcome, ActivationReceiptView } from "../../live/live-activation.js";
import type { HealthOutcome, PolicyOutcome } from "../../live/live-ops.js";
import type { RepositoryRemoteOutcome } from "../../live/live-repository-remote.js";
import type { SessionsOutcome } from "../../live/live-sessions.js";
import { CREDENTIAL_SOURCE_UNRECOGNISED, RESOURCES_LAYER, credentialSource, credentialSourceWords } from "./resources-credential.js";
import type { CredentialSource } from "./resources-credential.js";

/**
 * THE PROJECT'S MEASURED FACTS, one fact per row, folded from the reads the daemon
 * ALREADY serves. Pure: no fetch, no clock, every arm assertable by value. Three
 * properties this module exists to hold.
 *
 * NO CREDENTIAL VALUE EVER REACHES A ROW. The provider row states the credential's
 * SOURCE - an environment variable's NAME, or that a sign-in file was found - built ONLY
 * from `credentialSource()`, a CLOSED grammar over the credential ref the daemon carries in
 * the provider receipt's `reason` (see `providerSection`). Anything the grammar does not
 * recognise renders as a refusal code, so a value that rides in on a field renders NOTHING
 * instead of itself. The daemon scrubs values at the boundary that publishes
 * (activation-read.ts, `secretValues`/`scrub`); this is the second fence, not a second
 * scrub. No `reason` is RENDERED here: the provider receipt's is parsed, no other is read.
 *
 * A FACT IS NEVER SILENTLY OMITTED. A read that refuses turns ITS OWN facts into REFUSED
 * rows carrying the daemon's code and layer, and leaves every other fact standing: an
 * omitted fact would say "this project has no such resource", a different and false claim.
 *
 * NOT EVERY UNMEASURED FACT IS A FAILURE. A fact no read serves is UNSERVED; the backup
 * the activation READ deliberately never takes is DEFERRED. Both stay on the page in their
 * section, carry no code because nothing refused, and stay out of the screen's "could not
 * be read" count: on a healthy daemon those three rows were counted as three failed reads.
 */

/** The activation roster answered without the receipt this fact is folded from. */
export const RECEIPT_ABSENT = "RESOURCES_RECEIPT_ABSENT";
/** A carrier stated the store path as an empty string, which is not a path. */
export const STORE_PATH_EMPTY = "RESOURCES_STORE_PATH_EMPTY";

export interface ResourceRefusal { readonly code: string; readonly layer: string }

export type ResourceFactState =
  | { readonly kind: "MEASURED"; readonly value: string }
  | { readonly kind: "PENDING" }
  | { readonly kind: "REFUSED"; readonly refusal: ResourceRefusal; readonly said: string }
  /** No read this build consumes carries the fact: stated, never omitted, never a failure. */
  | { readonly kind: "UNSERVED" }
  /** The read answered and, by its own design, did not measure this: stated, never a failure. */
  | { readonly kind: "DEFERRED"; readonly said: string };

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

const measured = (value: string): ResourceFactState => Object.freeze({ kind: "MEASURED" as const, value });
const pending = (): ResourceFactState => Object.freeze({ kind: "PENDING" as const });
const refused = (code: string, layer: string, said: string): ResourceFactState =>
  Object.freeze({ kind: "REFUSED" as const, refusal: Object.freeze({ code, layer }), said });
const unserved = (): ResourceFactState => Object.freeze({ kind: "UNSERVED" as const });
const deferred = (said: string): ResourceFactState => Object.freeze({ kind: "DEFERRED" as const, said });
type ActivationAnswer = Extract<ActivationReadOutcome, { status: "ACTIVATION" }>;

const fact = (id: string, label: string, state: ResourceFactState): ResourceFact => Object.freeze({ id, label, state });
const receiptOf = (members: readonly ActivationReceiptView[], member: string): ActivationReceiptView | undefined =>
  members.find((row) => row.member === member);

/**
 * A receipt's own answer: measured hands the caller the receipt to fold, unmeasured renders
 * its stable code and layer. Reads no `reason`; only the provider fold parses (never renders) one.
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
  fold: (answer: ActivationAnswer) => ResourceFactState,
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
      // No read this daemon serves states the checked-out branch.
      fact("branch", "Checked-out branch", unserved()),
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
 * Both rows parse the receipt's `reason`, not its `ref`: `measureProvider` builds
 * `measuredReceipt("provider", probeRef, credential.ref)` and activation-read.ts `receiptRow`
 * publishes that `detail` as `reason`, while `ref` is the probe envelope ref `provider-profile-1`.
 */
function providerSection(reads: ResourceReads): ResourceSection {
  const source = (pick: (parsed: CredentialSource) => string): ResourceFactState =>
    activationState(reads.activation, PROVIDER_SAID, (answer) => fromReceipt(
      answer.members, "provider", PROVIDER_SAID, (receipt) => {
        const parsed = credentialSource(receipt.reason);
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
 * from one does not blank the row while the other still states it. The carriers are not
 * equally strict: `/activation/read`'s decoder requires a NON-EMPTY path (live-activation.ts,
 * `nonEmptyString`), so an empty one fails the whole frame; `/health/read`'s checks only the
 * TYPE (live-ops.ts, `typeof daemon.storePath !== "string"`), so `""` decodes and reaches
 * here. An empty answer falls through to the other carrier, and the row refuses with a code
 * when neither states a path, rather than rendering a blank that reads as a bug.
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

const BACKUP_DEFERRED_SAID = "Not measured by a read; the backup is written when project.activate runs.";

/**
 * `/activation/read` never takes a backup (activation-read.ts, `readOnlyActivationPorts`): it
 * answers the member under its OWN layer as ACTIVATION_READ_BACKUP_DEFERRED and keeps it out of
 * `blocking`. That exact code+layer pair is DEFERRED here. Any other unmeasured backup receipt -
 * ACTIVATION_BACKUP_FAILED @ DAEMON_ACTIVATION_RECEIPTS is a backup that FAILED - stays refused.
 */
function backupState(answer: ActivationAnswer): ResourceFactState {
  const receipt = receiptOf(answer.members, "backup");
  const deferredByRead = receipt !== undefined && !receipt.measured
    && receipt.code === "ACTIVATION_READ_BACKUP_DEFERRED" && receipt.layer === "ACTIVATION_READ";
  if (deferredByRead) return deferred(BACKUP_DEFERRED_SAID);
  return fromReceipt(answer.members, "backup", STORE_SAID, (row) => measured(row.ref ?? "taken, with no ref stated"));
}

function storeSection(reads: ResourceReads): ResourceSection {
  return Object.freeze({
    facts: Object.freeze([
      fact("path", "Store file", storePath(reads)),
      // No read this daemon serves measures the store's size on disk.
      fact("size", "Store size on disk", unserved()),
      fact("backup", "Last store backup", activationState(reads.activation, STORE_SAID, backupState)),
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
  return Object.freeze([repositorySection(reads), providerSection(reads), storeSection(reads), governanceSection(reads)]);
}
