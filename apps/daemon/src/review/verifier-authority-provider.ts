import { evaluatePolicy } from "@moe/core";
import type { PolicyEvaluationInput } from "@moe/core";
import type { JsonValue } from "@moe/contracts";
import type { ReviewPackageItemInput } from "@moe/review";
import type { SqliteEventStore } from "@moe/store";

import { aggregateIdFor, readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import type { BootstrapRequest } from "../bootstrap/bootstrap-contracts.js";
import type { NodeMission } from "../orchestrator/agent-wrapper.js";
import { readReviewLedger } from "./review-read-model.js";
import { verifyStoredPackageItems } from "./review-package-restore.js";
import { readReviewerCalibration } from "./reviewer-calibration-record.js";
import { NODE_VERIFIER_PRINCIPAL_ID } from "./verifier-receipt-contracts.js";
import type { VerifierAuthorityFacts } from "./verifier-receipt-contracts.js";

/**
 * The production producer of `VerifierAuthorityFacts` — the value the agent wrapper hands to
 * `createNodeVerifier`, replacing the shipped `() => null` that made every node refuse with
 * VERIFICATION_AUTHORITY_UNAVAILABLE.
 *
 * EVERY FIELD IS READ FROM THE DURABLE STORE. Nothing is minted here, nothing is defaulted, and
 * nothing comes from the caller: the `brief` parameter exists only to satisfy the port's shape and
 * is structurally unreachable from the implementation below, so no `NodeMission` field can ever
 * reach a fact. `nodeRef` and `projectId` are ADDRESSES — which subject to read — never values
 * that are returned.
 *
 * THE REFUSAL IS PRESERVED, ITS CAUSE MOVES. `NodeVerifierConfig.verificationAuthority` has one
 * refusal channel, `null`, and node-verifier.ts:166-172 still turns it into the same stable
 * VERIFICATION_AUTHORITY_UNAVAILABLE outcome before any test runs or any row is written. What
 * changes is only why: previously "nothing is wired", now "nothing is durably installed".
 *
 * IT WRITES NOTHING and holds no store handle past its own call.
 */

/**
 * The well-known address of the verifier's policy slice, deliberately NOT 64 hex for the same
 * reason `REVIEWER_CALIBRATION_SLICE_REF` is not: `validateEvaluationInput` refuses any
 * `policyRevisionRef` that is not 64 hex, so this ref can never be named as a policy revision by a
 * caller who noticed it in the installed set.
 */
export const VERIFIER_POLICY_SLICE_REF = "moe-verifier-policy/1";

/** The action and actor the receipt contract re-checks on read-back (verifier-receipt-contracts). */
const ACCEPTANCE_ACTION = "integration.accept_output";

export interface VerifierAuthorityProviderConfig {
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

/** Exactly `NodeVerifierConfig.verificationAuthority`, so the call site needs no type change. */
export type VerifierAuthorityProvider = (
  nodeRef: string,
  brief: NodeMission,
) => VerifierAuthorityFacts | null;

/** Objects decoded from the ledger have a NULL prototype, so no inherited-key check is safe. */
function asObject(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | null {
  if (value === null || value === undefined || typeof value !== "object") return null;
  if (Array.isArray(value)) return null;
  return value as Readonly<Record<string, JsonValue>>;
}

/**
 * The policy aggregate this project's slices live on, asked of production's own mapping rather
 * than restated. `aggregateIdFor` reads only `kind` and `projectId`; the cast supplies those two
 * and nothing else, so a change to the policy case follows here instead of detaching.
 */
function policyAggregateId(projectId: string): string {
  const request = { kind: "policy.install", projectId } as unknown as BootstrapRequest;
  return aggregateIdFor(request, null);
}

/**
 * The installed evaluation input, minus its address.
 *
 * `installPolicy` requires every slice to carry a `sliceRef`, and `validateEvaluationInput`
 * accepts EXACTLY the thirteen input keys, so the address must come off before the core sees it —
 * it is where the record lives, not something the policy says.
 *
 * Admissibility is decided by `evaluatePolicy` itself, never restated here. Anything less would be
 * a second copy of the core's hostile-input boundary that could drift from the one that will
 * re-decide these same bytes when the receipt is read back.
 */
function readVerifierPolicy(
  store: SqliteEventStore,
  projectId: string,
): PolicyEvaluationInput | null {
  const ledger = readDurableLedger(store, projectId);
  const state = asObject(stateOf(ledger, policyAggregateId(projectId)));
  const slices = state === null ? null : asObject(state["slices"]);
  if (slices === null || !Object.hasOwn(slices, VERIFIER_POLICY_SLICE_REF)) return null;
  const slice = asObject(slices[VERIFIER_POLICY_SLICE_REF]);
  if (slice === null) return null;
  // A NULL-prototype accumulator, not `{}`. A stored slice carrying an own `__proto__` key would
  // hit the setter on a plain object and silently reshape the accumulator instead of adding a key;
  // with no prototype there is no setter to hit, so an exotic key stays an ordinary key and
  // `validateEvaluationInput`'s exact-key check is what refuses it.
  const candidate = Object.create(null) as Record<string, JsonValue>;
  for (const [key, value] of Object.entries(slice)) {
    if (key !== "sliceRef") candidate[key] = value;
  }
  const evaluated = evaluatePolicy(candidate);
  // The four conditions `decodeVerifierReceiptBytes` re-checks. Refusing them here means an
  // unusable policy never reaches `recordVerifierReceipt`, which would otherwise flatten it into
  // VERIFIER_AUTHORITY_REFUSED with nothing left to say which of the four failed.
  if (!evaluated.ok || evaluated.record.decision !== "ALLOW") return null;
  if (evaluated.record.action !== ACCEPTANCE_ACTION) return null;
  if (evaluated.record.actor !== NODE_VERIFIER_PRINCIPAL_ID) return null;
  return Object.freeze(candidate) as unknown as PolicyEvaluationInput;
}

/**
 * The host-owned package facts for the round the receipt will bind.
 *
 * ROUND SELECTION IS NOT A CHOICE. `node-verifier.ts:137-138` takes `rounds.at(-1)` and requires
 * its routing to be ACCEPT — it does not search backwards for the newest clean round — and the
 * receipt is keyed on that round's `decisionId`. Reading any other round here would attach stale
 * evidence to a newer decision while every value assertion still passed.
 *
 * THE DIGEST GATE IS THE WHOLE POINT. `record.packageItems.items` is reachable and typechecks, but
 * items that never passed `verifyStoredPackageItems` are present-and-unattested: a substituted set
 * is well-shaped and answers every structural question identically. Only the digest the HANDLER
 * stored beside them can tell, so the items are bound from the VERIFIED result and never from the
 * record.
 */
function readHostPackageItems(
  store: SqliteEventStore,
  projectId: string,
  nodeRef: string,
): readonly ReviewPackageItemInput[] | null {
  const ledger = readReviewLedger(store, projectId, nodeRef);
  if (ledger.unreadable) return null;
  const latest = ledger.rounds[ledger.rounds.length - 1];
  if (latest === undefined || latest.routing.route !== "ACCEPT") return null;
  const verified = verifyStoredPackageItems(latest);
  if (!verified.ok) return null;
  // The round's OWN daemon receipt is withheld rather than forwarded. `buildReviewPackage`
  // requires every stored round to carry one, and `recordVerifierReceipt` refuses
  // VERIFIER_AUTHORITY_REFUSED if the authority hands one back, because the daemon appends the
  // receipt for the run it just performed itself. These are the facts BEFORE that append.
  return Object.freeze(verified.items.filter((item) => item.kind !== "DAEMON_RECEIPT"));
}

/**
 * Builds the durable authority provider for one project.
 *
 * There is no partial answer. A missing calibration, a missing or inadmissible policy slice, an
 * unreadable review ledger, a latest round that is not clean, absent items and items that fail the
 * digest comparison all produce the SAME `null`, because the port has one refusal channel and a
 * fabricated stand-in for any one field would assert authority that no durable record supports.
 */
export function createVerifierAuthorityProvider(
  config: VerifierAuthorityProviderConfig,
): VerifierAuthorityProvider {
  const { projectId, store } = config;
  // Declared without `brief`: the port's second argument is caller input, and a parameter that
  // does not exist cannot be read by a later edit.
  return (nodeRef: string): VerifierAuthorityFacts | null => {
    try {
      const calibration = readReviewerCalibration(store, projectId);
      if (!calibration.ok) return null;
      const policy = readVerifierPolicy(store, projectId);
      if (policy === null) return null;
      const packageItems = readHostPackageItems(store, projectId, nodeRef);
      if (packageItems === null) return null;
      return Object.freeze({
        calibration: calibration.calibration,
        packageItems,
        policy,
      });
    } catch {
      // A read that throws is evidence nobody can verify, so it stays unavailable rather than
      // becoming an exception the verifier loop would have to interpret.
      return null;
    }
  };
}

/** The STANDING half of verifier authority: the two installed slices, independent of any round. */
export interface VerifierStandingAuthority {
  /** `moe-reviewer-calibration/1` is installed and reads back. */
  readonly calibration: boolean;
  /** `moe-verifier-policy/1` is installed and evaluates to ALLOW for the verifier's acceptance. */
  readonly policy: boolean;
}

/**
 * What the board can say BEFORE a round exists. The provider above answers one `null` for every
 * missing fact by design; a project whose seed never installed these slices then sits with every
 * delivered node "awaiting verification" forever and nothing durable names the cause (measured on
 * the first real project, 2026-09-02). The affordance surface reads this so the stall is legible.
 */
export function readVerifierStandingAuthority(
  store: SqliteEventStore,
  projectId: string,
): VerifierStandingAuthority {
  try {
    return Object.freeze({
      calibration: readReviewerCalibration(store, projectId).ok,
      policy: readVerifierPolicy(store, projectId) !== null,
    });
  } catch {
    return Object.freeze({ calibration: false, policy: false });
  }
}
