import { MAX_SUPERVISOR_COUNT } from "@moe/runner";
import { BASE_RECORD, leaseProof, leaseRecord } from "./work-race-fixtures.js";
import type { DriftCase } from "./work-race-fixtures.js";
import type { MirroredLeaseState } from "@moe/runner";
import type { AuthorityErrorCode } from "@moe/scheduler";

/**
 * The hand-written case table. Every expectation is transcribed from the
 * published check order and from the two parsers read side by side; none of it
 * was recorded from a run, which could only ever agree with itself
 * (`mem:gotcha-self-derived-universe-cannot-check-itself`).
 */

const DIGEST_B = "b".repeat(64);

const CLAIM = "work.claim";
const ACTIVE_ONLY: readonly string[] = ["ACTIVE"];
const MALFORMED_MESSAGE = `${CLAIM} received a malformed authority shape`;

function malformedCase(name: string, record: unknown, proof: unknown = leaseProof()): DriftCase {
  return {
    authorityCode: "AUTHORITY_MALFORMED_INPUT",
    commandKind: CLAIM,
    legalStates: ACTIVE_ONLY,
    message: MALFORMED_MESSAGE,
    name,
    parity: "EQUAL",
    proof,
    record,
  };
}

function staleCase(
  name: string,
  message: string,
  overrides: { readonly record?: Record<string, unknown>; readonly proof?: Record<string, unknown> },
  authorityCode: AuthorityErrorCode = "AUTHORITY_STALE_LEASE",
): DriftCase {
  return {
    authorityCode,
    commandKind: CLAIM,
    legalStates: ACTIVE_ONLY,
    message,
    name,
    parity: "EQUAL",
    proof: leaseProof(overrides.proof ?? {}),
    record: leaseRecord(overrides.record ?? {}),
  };
}

/** An own accessor: `readOwnDataProperty` refuses it on both sides. */
function withAccessor(): Record<string, unknown> {
  const value = leaseRecord();
  Object.defineProperty(value, "leaseToken", {
    configurable: true,
    enumerable: true,
    get: () => "token-1",
  });
  return value;
}

function withPrototype(): object {
  return Object.assign(Object.create({ smuggled: true }) as object, BASE_RECORD);
}

function illegalState(state: MirroredLeaseState): DriftCase {
  return staleCase(
    `illegal lease state ${state}`,
    `lease state ${state} cannot accept ${CLAIM}`,
    { record: { state } },
  );
}

function stricterCase(
  name: string,
  record: Record<string, unknown>,
  proof: Record<string, unknown>,
): DriftCase {
  return {
    authorityCode: "FENCED",
    commandKind: CLAIM,
    legalStates: ACTIVE_ONLY,
    message: null,
    name,
    parity: "MIRROR_STRICTER",
    proof,
    record,
  };
}

const LONE_SURROGATE = "tok\uD800en";
/** "séssion" written decomposed: equal to its NFC form only after normalizing. */
const DECOMPOSED = "séssion";

export const DRIFT_CASES: readonly DriftCase[] = Object.freeze([
  {
    authorityCode: "FENCED",
    commandKind: CLAIM,
    legalStates: ACTIVE_ONLY,
    message: null,
    name: "honest ACTIVE lease with a current proof",
    parity: "EQUAL",
    proof: leaseProof(),
    record: leaseRecord(),
  },
  {
    authorityCode: "FENCED",
    commandKind: "work.resume",
    legalStates: ["SUSPECT", "DRAINING"],
    message: null,
    name: "honest SUSPECT lease resumed from a legal state",
    parity: "EQUAL",
    proof: leaseProof(),
    record: leaseRecord({ state: "SUSPECT" }),
  },
  staleCase("stale token", "lease token is not current", { proof: { leaseToken: "token-2" } }),
  staleCase(
    "proof epoch ahead of the record",
    "lease epoch is not current",
    { proof: { epoch: 4 } },
    "AUTHORITY_STALE_EPOCH",
  ),
  staleCase(
    "proof epoch behind a live record",
    "lease epoch is not current",
    { proof: { epoch: 2 } },
    "AUTHORITY_STALE_EPOCH",
  ),
  staleCase(
    "proof epoch behind a REVOKED record",
    "authority was superseded by a revocation epoch",
    { proof: { epoch: 2 }, record: { state: "REVOKED" } },
    "AUTHORITY_SUPERSEDED_AUTHORITY",
  ),
  staleCase("authority hash does not bind", "authority hash does not bind this lease", {
    proof: { authorityHashRef: DIGEST_B },
  }),
  staleCase("session does not own", "session does not own this lease", {
    proof: { ownerSessionRef: "session-2" },
  }),
  staleCase("record version is stale", "lease record version is stale", {
    proof: { expectedVersion: 8 },
  }),
  // The six checks below fail TWO conditions at once. They are what pins the
  // published check ORDER: four distinct causes share AUTHORITY_STALE_LEASE, so
  // a clone with a reordered fence still answers the right code on any input
  // that violates only one condition, and single-cause rows would stay green.
  staleCase("token and epoch both diverge — token decides", "lease token is not current", {
    proof: { epoch: 4, leaseToken: "token-2" },
  }),
  staleCase(
    "epoch and hash both diverge — epoch decides",
    "lease epoch is not current",
    { proof: { authorityHashRef: DIGEST_B, epoch: 4 } },
    "AUTHORITY_STALE_EPOCH",
  ),
  staleCase("hash and session both diverge — hash decides", "authority hash does not bind this lease", {
    proof: { authorityHashRef: DIGEST_B, ownerSessionRef: "session-2" },
  }),
  staleCase("session and version both diverge — session decides", "session does not own this lease", {
    proof: { expectedVersion: 8, ownerSessionRef: "session-2" },
  }),
  staleCase("version and lease state both diverge — version decides", "lease record version is stale", {
    proof: { expectedVersion: 8 },
    record: { state: "RELEASED" },
  }),
  malformedCase(
    "an unparseable record outranks a stale token",
    leaseRecord({ extra: 1 }),
    leaseProof({ leaseToken: "token-2" }),
  ),
  illegalState("SUSPECT"),
  illegalState("DRAINING"),
  illegalState("RELEASED"),
  illegalState("REVOKED"),
  malformedCase("record carries an extra key", leaseRecord({ extra: 1 })),
  malformedCase("record is missing bootId", (() => {
    const value = leaseRecord();
    delete value["bootId"];
    return value;
  })()),
  malformedCase("record is null", null),
  malformedCase("proof is an array", leaseRecord(), [] as unknown as Record<string, unknown>),
  malformedCase("record smuggles a value through an accessor", withAccessor()),
  malformedCase("record inherits from a non-Object prototype", withPrototype()),
  malformedCase("record is a proxy", new Proxy(leaseRecord(), {})),
  malformedCase("authority hash is not a sha-256 digest", leaseRecord({ authorityHashRef: "no" })),
  malformedCase("epoch is negative", leaseRecord({ epoch: -1 })),
  malformedCase("version is minus zero", leaseRecord({ version: -0 })),
  malformedCase("lease kind is undeclared", leaseRecord({ kind: "PROVIDER" })),
  malformedCase("lease state is undeclared", leaseRecord({ state: "PAUSED" })),
  malformedCase("lease token is empty", leaseRecord({ leaseToken: "" })),
  malformedCase("bootId is not a string", leaseRecord({ bootId: 5 })),
  {
    authorityCode: "AUTHORITY_MALFORMED_INPUT",
    commandKind: CLAIM,
    legalStates: ACTIVE_ONLY,
    message: `${CLAIM} found an exhausted lease counter`,
    name: "version sits at the counter ceiling",
    parity: "EQUAL",
    proof: leaseProof({ expectedVersion: MAX_SUPERVISOR_COUNT }),
    record: leaseRecord({ version: MAX_SUPERVISOR_COUNT }),
  },
  {
    authorityCode: "AUTHORITY_MALFORMED_INPUT",
    commandKind: CLAIM,
    legalStates: ACTIVE_ONLY,
    message: `${CLAIM} found an exhausted lease counter`,
    name: "the counter ceiling outranks a stale token",
    parity: "EQUAL",
    proof: leaseProof({ expectedVersion: MAX_SUPERVISOR_COUNT, leaseToken: "token-2" }),
    record: leaseRecord({ version: MAX_SUPERVISOR_COUNT }),
  },
  stricterCase(
    "lease token holds a lone surrogate",
    leaseRecord({ leaseToken: LONE_SURROGATE }),
    leaseProof({ leaseToken: LONE_SURROGATE }),
  ),
  stricterCase(
    "session ref is not NFC-normalized",
    leaseRecord({ ownerSessionRef: DECOMPOSED }),
    leaseProof({ ownerSessionRef: DECOMPOSED }),
  ),
  stricterCase(
    "lease id exceeds the mirrored text ceiling",
    leaseRecord({ leaseId: "l".repeat(401) }),
    leaseProof(),
  ),
]);
