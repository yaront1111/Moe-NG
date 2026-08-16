/** Durable verification: identities -> sealed recipe -> activation -> run -> receipt. */

import {
  buildEvidenceReceipt, buildVerificationRecipe, createNodeProcessLauncher,
  hermeticVerifierEnvironment, recipeSealMatches, runVerifierProcess,
} from "@moe/runner";
import type {
  ProcessLauncher, RunVerifierProcessResult, VerifierCapture, VerifierClock,
} from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";

import { exactKeys } from "../work/foundation-attempt-codec.js";
import {
  FOUNDATION_VERIFICATION_REQUEST_KEYS, carryEvidenceRefusal, carryWrapperRefusal,
  refuseVerification, verificationReceiptBody, verificationRefusalBody,
} from "./foundation-verification-contracts.js";
import {
  commitPhase, deriveRecipeAggregateId, deriveVerificationAggregateId, eventsOf, loadDurable,
  nonEmpty, readStoredReceipt, storedRecipe,
} from "./foundation-verification-store.js";
import type { CommitIdentity } from "./foundation-verification-store.js";

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
  FoundationVerificationOutcome, FoundationVerificationRefused, FoundationVerificationVerdict,
} from "./foundation-verification-contracts.js";

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

  function sealRecipe(input: FoundationRecipeRegistration): FoundationRecipeOutcome {
    const built = buildVerificationRecipe({
      argv: input.argv, declaredInputs: input.declaredInputs,
      declaredOutputPaths: input.declaredOutputPaths, verifierIdentity: input.verifierIdentity,
    });
    if (!built.ok) return carryEvidenceRefusal(built.code, built.layer);
    const aggregate = deriveRecipeAggregateId(input.recipeAggregateId);
    const committed = commitPhase(store, who, aggregate, "RECIPE_SEALED", {
      recipe: built.recipe as unknown as Record<string, unknown>,
      recipeAggregateId: input.recipeAggregateId,
      runtimeObservation: input.runtimeObservation as unknown as Record<string, unknown>,
    }, eventsOf(store, aggregate).length, "SEALED");
    return committed
      ? { ok: true as const, recipeAggregateId: input.recipeAggregateId, sha256: built.recipe.sha256 }
      : refuseVerification(
        "FOUNDATION_VERIFICATION_ACTIVATION_UNCOMMITTED", "DAEMON_VERIFICATION_ACTIVATION");
  }

  /** Persists the honest UNKNOWN, then answers with the producer's own refusal. */
  function refuseDurably(
    aggregate: string, verificationId: string, refused: FoundationVerificationRefused,
    capture: VerifierCapture | null,
  ): FoundationVerificationRefused {
    commitPhase(store, who, aggregate, "REFUSED",
      verificationRefusalBody(verificationId, refused, capture),
      eventsOf(store, aggregate).length, "REFUSED");
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
    if (!recipeSealMatches(sealed.recipe)) {
      return refuseVerification(
        "FOUNDATION_VERIFICATION_RECIPE_SEAL_INVALID", "DAEMON_VERIFICATION_IDENTITY");
    }
    const prior = readStoredReceipt(store, verificationId);
    if (prior.ok) {
      // A replay answers from the DURABLE row, never from the caller's request,
      // and a materially different candidate is a conflict rather than an
      // overwrite: the first receipt's bytes stay exactly where they are.
      return prior.row["recipeSha256"] === sealed.recipe.sha256
        && prior.row["recordDigest"] === request["expectedRecordDigest"]
        && prior.row["attemptAggregateId"] === request["attemptAggregateId"]
        ? prior
        : refuseVerification(
          "FOUNDATION_VERIFICATION_REPLAY_CONFLICT", "DAEMON_VERIFICATION_RECEIPT");
    }
    if (!commitPhase(store, who, aggregate, "ACTIVATED", {
      attemptAggregateId: request["attemptAggregateId"],
      recipeSha256: sealed.recipe.sha256, verificationId,
    }, eventsOf(store, aggregate).length, "ACTIVATED")) {
      return refuseVerification(
        "FOUNDATION_VERIFICATION_ACTIVATION_UNCOMMITTED", "DAEMON_VERIFICATION_ACTIVATION");
    }
    const run: RunVerifierProcessResult = await runVerifierProcess({
      activation: {
        attempt: loaded.activation.attempt, grant: loaded.activation.grant,
        intent: loaded.activation.effectIntent,
      },
      baseEnvironment: hermeticVerifierEnvironment(deps.baseEnvironment ?? process.env),
      candidateBaseIdentity: loaded.inputManifest.baseIdentity,
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
    const committed = commitPhase(store, who, aggregate, "RECEIPTED", verificationReceiptBody({
      attemptAggregateId: request["attemptAggregateId"] as string, capture: run.capture,
      receipt: receipt.receipt, recipeAggregateId: request["recipeAggregateId"] as string,
      recordDigest: request["expectedRecordDigest"] as string, verdict, verificationId,
    }), eventsOf(store, aggregate).length, "RECEIPTED");
    return committed
      ? readStoredReceipt(store, verificationId)
      : refuseVerification(
        "FOUNDATION_VERIFICATION_RECEIPT_AMBIGUOUS", "DAEMON_VERIFICATION_RECEIPT");
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
