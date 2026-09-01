/** Durable verification: identities -> sealed recipe -> bound candidate tree ->
 *  activation -> run -> receipt. */

import {
  buildEvidenceReceipt, buildVerificationRecipe, createNodeProcessLauncher,
  hermeticVerifierEnvironment, recipeSealMatches, runVerifierProcess,
} from "@moe/runner";
import type {
  ProcessLauncher, RunVerifierProcessResult, VerifierCapture, VerifierClock,
} from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";

import { exactKeys } from "../work/foundation-attempt-codec.js";
import { bindCandidateTree } from "./foundation-verification-candidate.js";
import {
  FOUNDATION_VERIFICATION_REQUEST_KEYS, carryEvidenceRefusal, carryWrapperRefusal,
  refuseVerification, verificationReceiptBody, verificationRefusalBody,
} from "./foundation-verification-contracts.js";
import {
  commitPhase, deriveRecipeAggregateId, deriveVerificationAggregateId, eventsOf, loadDurable,
  nonEmpty, readStoredReceipt, storedRecipe,
} from "./foundation-verification-store.js";
import type { CommitIdentity, PhaseCommit } from "./foundation-verification-store.js";

export { deriveRecipeAggregateId, deriveVerificationAggregateId };

/** Injected so nothing here reads a clock directly: `now` stamps evidence and
 *  `monotonicMs` measures it, matching the wrapper's own VerifierClock. */
function defaultClock(): VerifierClock {
  return {
    monotonicMs: () => Number(process.hrtime.bigint() / 1_000_000n),
    now: () => new Date().toISOString(),
  };
}
import type {
  FoundationRecipeOutcome, FoundationRecipeRegistration, FoundationVerificationAnswer,
  FoundationVerificationCode, FoundationVerificationLayer, FoundationVerificationOutcome,
  FoundationVerificationRefused, FoundationVerificationVerdict,
} from "./foundation-verification-contracts.js";

/** Every sealed recipe is the FIRST event on its own derived aggregate. */
const RECIPE_EXPECTED_VERSION = 0;

/**
 * Maps a phase commit onto this service's answer. COMMITTED needs none. REJECTED
 * is the store's RETURNED expected-version rejection -- zero rows, the store's
 * own word for it -- and is the ONLY disposition answered with `code`, whose
 * documented meaning is exactly that. FAILED is the producer's refusal and
 * travels as-is: a thrown OUTCOME_UNKNOWN reported as UNCOMMITTED would tell a
 * reviewer the row is certainly absent when the store itself cannot say.
 */
function uncommitted(
  commit: PhaseCommit, code: FoundationVerificationCode, layer: FoundationVerificationLayer,
): FoundationVerificationRefused | null {
  if (commit.kind === "COMMITTED") return null;
  return commit.kind === "FAILED" ? commit.refused : refuseVerification(code, layer);
}

export interface FoundationVerificationDeps {
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  readonly clock?: VerifierClock;
  /** Defaults to the shipped node launcher; the physical boundary is real. */
  readonly launcher?: ProcessLauncher;
  /** The commit identity this daemon writes under; the store validates it. */
  readonly principalId: string;
  readonly projectId: string;
  readonly reapGraceMs?: number;
  readonly store: SqliteEventStore;
  readonly timeoutMs?: number;
}

export function createFoundationVerificationService(deps: FoundationVerificationDeps): {
  readReceipt(verificationId: string): FoundationVerificationOutcome;
  sealRecipe(input: FoundationRecipeRegistration): FoundationRecipeOutcome;
  verify(input: unknown): Promise<FoundationVerificationOutcome>;
} {
  const { store } = deps;
  const launcher = deps.launcher ?? createNodeProcessLauncher();
  const clock = deps.clock ?? defaultClock();
  const who: CommitIdentity = { principalId: deps.principalId, projectId: deps.projectId };

  /** The aggregate's head, read fresh before each commit. A read the store
   *  refuses is carried: answering 0 would aim a first-event commit at an
   *  aggregate nobody could see. */
  function headVersion(aggregate: string): number | FoundationVerificationRefused {
    const read = eventsOf(store, aggregate);
    return read.ok ? read.events.length : read;
  }

  /**
   * A recipe identity seals ONCE. A second registration is answered from the
   * DURABLE seal, never from the caller's bytes: the same recipe sha256 is a
   * replay and the first seal answers, a different one is a conflict and the
   * first seal's bytes stay exactly where they are. The commit itself is pinned
   * at version 0, so a seal racing another under the same identity is decided by
   * the store -- same bytes replay, different bytes refuse under ITS code -- and
   * a rejection means the identity was already taken, not that nothing exists.
   */
  function sealRecipe(input: FoundationRecipeRegistration): FoundationRecipeOutcome {
    const built = buildVerificationRecipe({
      argv: input.argv, declaredInputs: input.declaredInputs,
      declaredOutputPaths: input.declaredOutputPaths, verifierIdentity: input.verifierIdentity,
    });
    if (!built.ok) return carryEvidenceRefusal(built.code, built.layer);
    const prior = storedRecipe(store, input.recipeAggregateId);
    if (prior !== null && "ok" in prior) return prior;
    if (prior !== null) {
      return prior.recipe.sha256 === built.recipe.sha256
        ? { ok: true as const, recipeAggregateId: input.recipeAggregateId, sha256: prior.recipe.sha256 }
        : refuseVerification(
          "FOUNDATION_VERIFICATION_RECIPE_CONFLICT", "DAEMON_VERIFICATION_IDENTITY");
    }
    const aggregate = deriveRecipeAggregateId(input.recipeAggregateId);
    const refused = uncommitted(commitPhase(store, who, aggregate, "RECIPE_SEALED", {
      recipe: built.recipe as unknown as Record<string, unknown>,
      recipeAggregateId: input.recipeAggregateId,
      runtimeObservation: input.runtimeObservation as unknown as Record<string, unknown>,
    }, RECIPE_EXPECTED_VERSION, "SEALED"),
    "FOUNDATION_VERIFICATION_RECIPE_UNCOMMITTED", "DAEMON_VERIFICATION_IDENTITY");
    return refused
      ?? { ok: true as const, recipeAggregateId: input.recipeAggregateId, sha256: built.recipe.sha256 };
  }

  /** Persists the honest UNKNOWN, then answers with the producer's own refusal.
   *  The UNKNOWN row is best effort: the producer's refusal is the answer whether
   *  or not the store took the row, so a store that will not even say where the
   *  aggregate stands leaves no row rather than a second, competing refusal. */
  function refuseDurably(
    aggregate: string, verificationId: string, refused: FoundationVerificationRefused,
    capture: VerifierCapture | null,
  ): FoundationVerificationRefused {
    const version = headVersion(aggregate);
    if (typeof version === "number") {
      commitPhase(store, who, aggregate, "REFUSED",
        verificationRefusalBody(verificationId, refused, capture), version, "REFUSED");
    }
    return refused;
  }

  async function verify(input: unknown): Promise<FoundationVerificationOutcome> {
    const request = exactKeys(input, FOUNDATION_VERIFICATION_REQUEST_KEYS);
    if (request === null || !Object.values(request).every(nonEmpty)) {
      return refuseVerification(
        "FOUNDATION_VERIFICATION_REQUEST_MALFORMED", "DAEMON_VERIFICATION_REQUEST");
    }
    const verificationId = request["verificationId"] as string;
    const aggregate = deriveVerificationAggregateId(verificationId);
    const loaded = loadDurable(
      store, who, request["attemptAggregateId"] as string,
      request["expectedRecordDigest"] as string);
    if ("ok" in loaded) return loaded;
    const sealed = storedRecipe(store, request["recipeAggregateId"] as string);
    if (sealed === null) {
      return refuseVerification(
        "FOUNDATION_VERIFICATION_RECIPE_UNRESOLVED", "DAEMON_VERIFICATION_IDENTITY");
    }
    if ("ok" in sealed) return sealed;
    if (!recipeSealMatches(sealed.recipe)) {
      return refuseVerification(
        "FOUNDATION_VERIFICATION_RECIPE_SEAL_INVALID", "DAEMON_VERIFICATION_IDENTITY");
    }
    const prior = readStoredReceipt(store, verificationId);
    if (prior.ok) {
      // A replay answers from the DURABLE row, never from the caller's request,
      // and a materially different candidate is a conflict rather than an
      // overwrite: the first receipt's bytes stay exactly where they are.
      // candidateRoot is compared BECAUSE IT IS WHAT RAN — dropping it would let
      // a request naming an unverified root be answered by the prior receipt.
      return prior.row["recipeSha256"] === sealed.recipe.sha256
        && prior.row["recordDigest"] === request["expectedRecordDigest"]
        && prior.row["attemptAggregateId"] === request["attemptAggregateId"]
        && prior.row["candidateRoot"] === request["candidateRoot"]
        ? prior
        : refuseVerification(
          "FOUNDATION_VERIFICATION_REPLAY_CONFLICT", "DAEMON_VERIFICATION_RECEIPT");
    }
    // BEFORE activation, so a root that is not the durable tree leaves no row at
    // all: nothing was activated, nothing ran, and there is no UNKNOWN to record.
    // The base identity handed to the wrapper below is the one git read FROM
    // THE TREE: feeding it the manifest's own field would compare that field
    // against itself and make the wrapper's base gate unreachable.
    const candidate = bindCandidateTree({
      baseEnvironment: deps.baseEnvironment ?? process.env,
      candidateRoot: request["candidateRoot"] as string, inputManifest: loaded.inputManifest,
      observedAt: clock.now(),
    });
    if ("ok" in candidate) return candidate;
    const activationVersion = headVersion(aggregate);
    if (typeof activationVersion !== "number") return activationVersion;
    const unactivated = uncommitted(commitPhase(store, who, aggregate, "ACTIVATED", {
      attemptAggregateId: request["attemptAggregateId"],
      recipeSha256: sealed.recipe.sha256, verificationId,
    }, activationVersion, "ACTIVATED"),
    "FOUNDATION_VERIFICATION_ACTIVATION_UNCOMMITTED", "DAEMON_VERIFICATION_ACTIVATION");
    if (unactivated !== null) return unactivated;
    const run: RunVerifierProcessResult = await runVerifierProcess({
      activation: {
        attempt: loaded.activation.attempt, grant: loaded.activation.grant,
        intent: loaded.activation.effectIntent,
      },
      baseEnvironment: hermeticVerifierEnvironment(deps.baseEnvironment ?? process.env),
      candidateBaseIdentity: candidate.baseIdentity,
      candidateRoot: request["candidateRoot"] as string, clock,
      inputManifest: loaded.inputManifest, launcher, outputs: [],
      ...(deps.reapGraceMs === undefined ? {} : { reapGraceMs: deps.reapGraceMs }),
      recipe: sealed.recipe, runtimeObservation: sealed.runtime as never,
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      wrapperIdentity: String(loaded.record["wrapperIdentity"] ?? ""),
    });
    if (!run.ok) {
      return refuseDurably(aggregate, verificationId, carryWrapperRefusal(run), run.capture);
    }
    // The candidate is re-read AFTER the run: a record that moved underneath the
    // execution must not be handed to the receipt builder.
    const after = loadDurable(
      store, who, request["attemptAggregateId"] as string,
      request["expectedRecordDigest"] as string);
    if ("ok" in after) return refuseDurably(aggregate, verificationId, after, run.capture);
    const receipt = buildEvidenceReceipt({
      effectIdentity: loaded.activation.effectIntent.intentId,
      execution: run.execution, graphIdentity: String(loaded.record["nodeKey"] ?? ""),
      inputManifest: after.inputManifest, leaseIdentity: loaded.activation.lease.leaseId,
      obligations: [], recipe: sealed.recipe, resultManifest: after.resultManifest,
    });
    if (!receipt.ok) {
      return refuseDurably(
        aggregate, verificationId, carryEvidenceRefusal(receipt.code, receipt.layer), run.capture);
    }
    const verdict: FoundationVerificationVerdict =
      run.execution.disposition === "COMPLETED" ? "PASSED" : "FAILED";
    const receiptVersion = headVersion(aggregate);
    if (typeof receiptVersion !== "number") return receiptVersion;
    // ZERO rows written, which is NOT the ">1 row" AMBIGUOUS reads: sharing one
    // code would leave a reviewer unable to tell an empty aggregate from a
    // doubled one, and the two demand opposite repairs. Only the store's
    // RETURNED rejection earns it; a store that threw answers under its own code.
    const refused = uncommitted(commitPhase(store, who, aggregate, "RECEIPTED",
      verificationReceiptBody({
        attemptAggregateId: request["attemptAggregateId"] as string,
        candidateRoot: request["candidateRoot"] as string, capture: run.capture,
        receipt: receipt.receipt, recipeAggregateId: request["recipeAggregateId"] as string,
        recordDigest: request["expectedRecordDigest"] as string, verdict, verificationId,
      }), receiptVersion, "RECEIPTED"),
    "FOUNDATION_VERIFICATION_RECEIPT_UNCOMMITTED", "DAEMON_VERIFICATION_RECEIPT");
    return refused ?? readStoredReceipt(store, verificationId);
  }

  return {
    readReceipt: (verificationId: string): FoundationVerificationOutcome =>
      nonEmpty(verificationId)
        ? readStoredReceipt(store, verificationId)
        : refuseVerification(
          "FOUNDATION_VERIFICATION_REQUEST_MALFORMED", "DAEMON_VERIFICATION_REQUEST"),
    sealRecipe, verify,
  };
}

export type { FoundationVerificationAnswer };
