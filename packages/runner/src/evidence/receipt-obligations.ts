import type { ArtifactRef } from "../artifacts/artifact-contract.js";
import { isHex64 } from "../canonical.js";
import {
  EVIDENCE_OBLIGATION_KINDS,
  evidenceFailure,
  evidenceRefRejection,
  MAX_EVIDENCE_OBLIGATIONS,
  type DischargedObligation,
  type EvidenceFailure,
  type ObligationSupport,
} from "./evidence-contract.js";

const LAYER = "OBLIGATION" as const;

/** Only facts the receipt itself binds may back an obligation. */
export interface ObligationContext {
  readonly outputRefs: readonly ArtifactRef[];
  readonly resultTreeSha256: string;
  readonly runtimeObservationSha256: string;
}

type SupportCheck = { readonly ok: true; readonly support: ObligationSupport } | EvidenceFailure;

const unsupported = (message: string): EvidenceFailure =>
  evidenceFailure("RUNNER_EVIDENCE_OBLIGATION_SUPPORT_INVALID", LAYER, message);

const bindsRef = (context: ObligationContext, ref: ArtifactRef): boolean =>
  context.outputRefs.some(
    (bound) => bound.sha256 === ref.sha256 && bound.byteLength === ref.byteLength,
  );

/**
 * THE SINGLE SOURCE of DoD 1's runtime backstop.
 *
 * The primary enforcement is structural: `buildEvidenceReceipt` has no parameter
 * through which prose could arrive, and `AGENT_REPORT` carries only an author and
 * a digest. This is the nearest legal attempt — a perfectly well-formed support
 * record whose only backing is something an agent wrote — and it is refused
 * before any of its fields are even inspected, so no shape gate can answer first
 * and quietly take this rule's place.
 *
 * Each accepted branch returns a rebuilt record, so a caller-supplied extra key
 * can never reach the digest.
 */
function checkSupport(support: ObligationSupport, context: ObligationContext): SupportCheck {
  if (typeof support !== "object" || support === null) {
    return unsupported("obligation support must be a record");
  }
  if (support.kind === "AGENT_REPORT") {
    return evidenceFailure(
      "RUNNER_EVIDENCE_AGENT_TEXT_UNSUPPORTED",
      LAYER,
      "agent-reported text cannot satisfy a verification obligation",
    );
  }
  if (support.kind === "ARTIFACT") {
    const refFailure = evidenceRefRejection(support.ref, LAYER);
    if (refFailure !== null) {
      return refFailure;
    }
    if (!bindsRef(context, support.ref)) {
      return unsupported(`artifact ${support.ref.sha256} is not an output this receipt binds`);
    }
    return {
      ok: true as const,
      support: {
        kind: "ARTIFACT",
        ref: { sha256: support.ref.sha256, byteLength: support.ref.byteLength },
      },
    };
  }
  if (support.kind === "RESULT_TREE") {
    if (!isHex64(support.manifestSha256) || support.manifestSha256 !== context.resultTreeSha256) {
      return unsupported("result-tree support does not name the result tree this receipt binds");
    }
    return { ok: true as const, support: { kind: "RESULT_TREE", manifestSha256: support.manifestSha256 } };
  }
  if (support.kind === "RUNTIME_OBSERVATION") {
    if (
      !isHex64(support.observationSha256) ||
      support.observationSha256 !== context.runtimeObservationSha256
    ) {
      return unsupported("runtime support does not name the observation this receipt binds");
    }
    return {
      ok: true as const,
      support: { kind: "RUNTIME_OBSERVATION", observationSha256: support.observationSha256 },
    };
  }
  return unsupported(
    `unknown obligation support kind ${JSON.stringify((support as { kind: unknown }).kind)}`,
  );
}

/** Normalizes to a fresh sorted list so nothing the caller still holds can change what was bound. */
export function canonicalObligations(
  obligations: readonly DischargedObligation[],
  context: ObligationContext,
): readonly DischargedObligation[] | EvidenceFailure {
  if (!Array.isArray(obligations)) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_OBLIGATION_KIND_INVALID",
      LAYER,
      "obligations must be a list",
    );
  }
  if (obligations.length > MAX_EVIDENCE_OBLIGATIONS) {
    return evidenceFailure(
      "RUNNER_EVIDENCE_OBLIGATION_LIMIT",
      LAYER,
      `obligations must be a list of at most ${MAX_EVIDENCE_OBLIGATIONS} entries`,
    );
  }
  const canonical: DischargedObligation[] = [];
  // Read by index: the validated entry and the bound entry must be the same one.
  for (let index = 0; index < obligations.length; index += 1) {
    const obligation = obligations[index] as DischargedObligation;
    if (typeof obligation !== "object" || obligation === null) {
      return evidenceFailure(
        "RUNNER_EVIDENCE_OBLIGATION_KIND_INVALID",
        LAYER,
        "every obligation must be a record",
      );
    }
    if (!EVIDENCE_OBLIGATION_KINDS.includes(obligation.kind)) {
      return evidenceFailure(
        "RUNNER_EVIDENCE_OBLIGATION_KIND_INVALID",
        LAYER,
        `unknown obligation kind ${JSON.stringify(obligation.kind)}`,
      );
    }
    const checked = checkSupport(obligation.support, context);
    if (!checked.ok) {
      return checked;
    }
    canonical.push({ kind: obligation.kind, support: checked.support });
  }
  return canonical.sort((left, right) =>
    left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0,
  );
}
