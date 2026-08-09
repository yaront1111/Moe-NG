import { applyEffectCommand } from "@moe/runner";

import { applied, contextView, deepFreeze, refused, workFailure } from "./work-kernel.js";
import { fenceWorkLease, isRecord } from "./work-lease.js";
import type { WorkAuthorityLabel, WorkResult } from "./work-kernel.js";

/**
 * `work.renew | release | resume | cancel | get_context`.
 *
 * Every handler revalidates the CURRENT lease token and epoch through the
 * scheduler fencing surface BEFORE composing any successor. Codes come from
 * `work-kernel.ts`; none is declared locally, because the vocabulary is closed.
 *
 * No mutable module-level state: the caller supplies the current records and
 * receives successors, so a refused command leaves no residue anywhere.
 */

interface CommandSpec {
  /** Lease states this command may be applied from. */
  readonly legalStates: readonly string[];
  /** The lease state the successor carries; `null` keeps the current one. */
  readonly successorState: string | null;
  readonly authority: Exclude<WorkAuthorityLabel, "NONE">;
}

const LIFECYCLE_COMMANDS: Readonly<Record<string, CommandSpec>> = Object.freeze({
  cancel: {
    authority: "CLAIM_CANCELLED",
    legalStates: ["ACTIVE", "SUSPECT", "DRAINING"],
    successorState: "DRAINING",
  },
  release: {
    authority: "CLAIM_RELEASED",
    legalStates: ["ACTIVE", "SUSPECT", "DRAINING"],
    successorState: "RELEASED",
  },
  renew: {
    authority: "CLAIM_RENEWED",
    legalStates: ["ACTIVE"],
    successorState: null,
  },
  resume: {
    authority: "CLAIM_RESUMED",
    legalStates: ["SUSPECT", "DRAINING"],
    successorState: "ACTIVE",
  },
});

/** Read-only, so it fences against every state a mutation may start from. */
const CONTEXT_LEGAL_STATES: readonly string[] = ["ACTIVE", "SUSPECT", "DRAINING", "RELEASED"];

function malformed(message: string): WorkResult {
  return refused(workFailure("WORK_PAYLOAD_MALFORMED", null, "AUTHORITY", message));
}

function readLease(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  const lease = payload["lease"];
  return isRecord(lease) ? lease : null;
}

/**
 * The successor lease record: the version advances by exactly one so a
 * concurrent command holding the pre-mutation proof is fenced out, which is
 * what makes an interleaving resolve to exactly one legal state.
 */
function successorLease(
  current: Record<string, unknown>,
  successorState: string | null,
): Record<string, unknown> {
  const version = current["version"];
  return {
    ...current,
    state: successorState ?? current["state"],
    version: typeof version === "number" ? version + 1 : version,
  };
}

/**
 * Cancel additionally asks the supervisor to move the effect intent. A
 * MUST_DRAIN answer is NOT a refusal — design 13.1 requires an activated
 * effect to be drained rather than cancelled outright — so it is reported as
 * a distinct state conflict, never folded into an intent refusal.
 */
function cancelIntent(payload: Record<string, unknown>): WorkResult | null {
  const effect = payload["effect"];
  if (!isRecord(effect)) return null;
  const outcome = applyEffectCommand(effect["intent"], { kind: "requestCancel" });
  if (outcome.kind === "TRANSITIONED") return null;
  if (outcome.kind === "MUST_DRAIN") {
    return refused(
      workFailure(
        "WORK_STATE_CONFLICT",
        "effectIntent",
        "AUTHORITY",
        "an activated effect must be drained rather than cancelled",
      ),
    );
  }
  return refused(
    workFailure(
      "WORK_INTENT_REFUSED",
      "effectIntent",
      "AUTHORITY",
      outcome.failure.message,
      outcome.failure.code,
    ),
  );
}

/**
 * Structural copy of plain data.
 *
 * `get_context` must own the values it publishes. Handing the caller's own
 * object to `deepFreeze` would freeze THEIR record — a read-only command
 * silently making the caller's state immutable. A JSON-equality test cannot
 * see that, because freezing does not change serialized content; this was
 * found by adversarial review.
 */
function snapshot(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => snapshot(item));
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    copy[key] = snapshot((value as Record<string, unknown>)[key]);
  }
  return copy;
}

function readContext(payload: Record<string, unknown>, lease: Record<string, unknown>): WorkResult {
  const effect = payload["effect"];
  const intent = isRecord(effect) ? effect["intent"] : null;
  return contextView(
    deepFreeze({
      effectIntent: intent === undefined ? null : snapshot(intent),
      lease: snapshot(lease),
      readOnly: true,
    }),
  );
}

/**
 * Applies one lifecycle command. Returns a frozen result carrying either the
 * successor record or a single refusal — never both, and never a partial.
 */
export function applyWorkLifecycle(command: string, payload: unknown): WorkResult {
  const isContext = command === "get_context";
  // Object.hasOwn, never a bare index: a bare lookup walks the prototype chain,
  // so "constructor" / "toString" / "valueOf" would resolve to an inherited
  // member, read as a declared command, and be applied with an undefined
  // authority label. Found by adversarial review, not by a failing test.
  const spec = Object.hasOwn(LIFECYCLE_COMMANDS, command)
    ? LIFECYCLE_COMMANDS[command]
    : undefined;
  if (spec === undefined && !isContext) {
    return refused(
      workFailure(
        "WORK_REQUEST_INVALID",
        null,
        "INGRESS",
        `${command} is not a work lifecycle command`,
      ),
      "REQUEST_INVALID",
    );
  }

  const lease = readLease(payload);
  if (lease === null || !isRecord(payload)) {
    return malformed("work lifecycle payload must carry a lease record and proof");
  }

  const gate = fenceWorkLease(
    lease,
    `work.${command}`,
    spec?.legalStates ?? CONTEXT_LEGAL_STATES,
  );
  if (!gate.ok) return gate.result;

  if (isContext || spec === undefined) return readContext(payload, gate.lease);

  if (command === "cancel") {
    const refusal = cancelIntent(payload);
    if (refusal !== null) return refusal;
  }

  return applied(
    command as never,
    spec.authority,
    deepFreeze({ lease: successorLease(gate.lease, spec.successorState) }),
  );
}
