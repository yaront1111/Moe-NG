import { MAX_SUPERVISOR_COUNT } from "@moe/runner";
import type { MirroredLeaseKind, MirroredLeaseState } from "@moe/runner";
import type { AuthorityErrorCode, LeaseKind, LeaseState } from "@moe/scheduler";

/**
 * The shared lease table the supervisor mirror and the scheduler authority are
 * compared over.
 *
 * `@moe/runner` depends only on `@moe/contracts`, so `lease-mirror.ts` clones
 * the design-749 fence rather than calling it. A clone drifts silently; this
 * table exists so the drift is loud. Every expectation below is HAND-WRITTEN
 * from the published check order (token, epoch, authority hash, session,
 * version, state) and from the two parsers read side by side — never recorded
 * from a run, which could only ever agree with itself.
 */

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

export const BASE_RECORD: Readonly<Record<string, unknown>> = Object.freeze({
  authorityHashRef: DIGEST_A,
  bootId: "boot-1",
  epoch: 3,
  kind: "ASSIGNMENT",
  leaseId: "lease-1",
  leaseToken: "token-1",
  monotonicObservation: 500,
  ownerSessionRef: "session-1",
  serverWallDeadline: 1_000,
  state: "ACTIVE",
  version: 7,
});

export const BASE_PROOF: Readonly<Record<string, unknown>> = Object.freeze({
  authorityHashRef: DIGEST_A,
  epoch: 3,
  expectedVersion: 7,
  leaseToken: "token-1",
  ownerSessionRef: "session-1",
});

export function leaseRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...BASE_RECORD, ...overrides };
}

export function leaseProof(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...BASE_PROOF, ...overrides };
}

/**
 * Compile-time vocabulary parity in BOTH directions.
 *
 * `Record<LeaseState, MirroredLeaseState>` demands one key per scheduler state
 * and one mirrored state per value, so a state added on either side turns
 * `pnpm --filter @moe/daemon typecheck` red. Neither closed set is published as
 * a runtime array from `@moe/scheduler`, so the type system is the only place
 * the two names can be compared; the identity of each entry is asserted at
 * runtime by `work-races.test.ts` so a transposed pair cannot pass either.
 */
export const LEASE_STATE_PARITY: Readonly<Record<LeaseState, MirroredLeaseState>> = Object.freeze({
  ACTIVE: "ACTIVE",
  DRAINING: "DRAINING",
  RELEASED: "RELEASED",
  REVOKED: "REVOKED",
  SUSPECT: "SUSPECT",
});

export const LEASE_KIND_PARITY: Readonly<Record<LeaseKind, MirroredLeaseKind>> = Object.freeze({
  ASSIGNMENT: "ASSIGNMENT",
  RESOURCE: "RESOURCE",
  WORKSPACE: "WORKSPACE",
});

/**
 * `EQUAL` — both surfaces must return the same verdict, code and message.
 * `MIRROR_STRICTER` — the mirror refuses input the authority accepts, because
 * its `isRef` additionally demands well-formed NFC text within 400 chars. That
 * direction fails closed. The reverse direction is a fencing bypass and is
 * asserted never to occur anywhere in this table.
 */
export type DriftParity = "EQUAL" | "MIRROR_STRICTER";

export interface DriftCase {
  readonly name: string;
  readonly parity: DriftParity;
  readonly record: unknown;
  readonly proof: unknown;
  readonly commandKind: string;
  readonly legalStates: readonly string[];
  /** Hand-written authority verdict: a code, or `FENCED` when it accepts. */
  readonly authorityCode: AuthorityErrorCode | "FENCED";
  /** Hand-written refusal message; `null` when the case is accepted. */
  readonly message: string | null;
}

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
