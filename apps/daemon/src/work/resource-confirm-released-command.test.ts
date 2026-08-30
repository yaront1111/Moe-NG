import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { handleCommandRequest } from "../http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import { PRINCIPAL_ID, PROJECT_ID, seedReadyProject } from "../recovery/restore-test-harness.js";
import {
  ATTEMPT_RESOURCE_BOUND_EVENT_TYPE, ATTEMPT_RESOURCE_TRANSITION_EVENT_TYPE,
  DAEMON_ATTEMPT_RESOURCE, SCHEDULER_RESOURCE_AUTHORITY, deriveAttemptResourceAggregateId,
} from "./attempt-resource-authority-contracts.js";
import { readAttemptResources } from "./attempt-resource-reader.js";
import {
  ACTIVATION_AGGREGATE, DURABLE_ATTEMPT_REF, activationBytes, canonicalBytes, cleanRows,
  plantResourceEvent, resourceBody, resourceRow,
} from "./attempt-resource-test-harness.js";
import { deriveReleaseTerminalEvidence } from "./release-terminal-evidence.js";
import { RESOURCE_RECONCILE_COMMAND_KIND } from "./resource-reconcile-command.js";
import {
  DAEMON_RESOURCE_CONFIRM_RELEASED, RESOURCE_CONFIRM_RELEASED_COMMAND_KIND,
  RESOURCE_CONFIRM_RELEASED_PAYLOAD_KEYS,
} from "./resource-confirm-released-command.js";

/**
 * `resource.confirm_released` — the OPERATOR-authenticated proven-release ingress,
 * driven end to end (task-7eceb55b87164f4ca5cf39a40aa77633).
 *
 * WHY THIS COMMAND EXISTS. The scheduler quarantines a resource whenever release is
 * uncertain, and the strict readiness reader correctly treats QUARANTINED as
 * NON-terminal because `grantSuccessorCapacity` can still move it. That reducer is
 * the ONLY thing that clears QUARANTINED -> RELEASED, and it demands a proof
 * reference. Before this ingress no production path could supply one, so any attempt
 * that quarantined a resource could never become release-ready.
 *
 * EVERY ARM GOES THROUGH `handleCommandRequest`, never through
 * `runResourceConfirmReleasedCommand` or `applyAttemptResourceReport` directly: the
 * whole point of the row is that the seam authenticates, authorizes, gates on the
 * configured OPERATOR principal and shape-checks BEFORE any payload field is read. A
 * direct call would skip exactly the four stages this row adds.
 *
 * NOTHING HERE IS SEEDED BY HAND WHERE PRODUCTION CAN SEED IT. Every quarantine below
 * is reached by driving the real `effect.activate` bind and then the real registry
 * `resource.reconcile` command. Two arms plant a durable precondition the production
 * path cannot construct — a MIXED set that keeps a non-terminal member past a clear,
 * and a second bind event — and each says at its call site why.
 *
 * WHAT IS NOT ASSERTED HERE, AND WHERE IT IS. A read horizon that moves DURING one
 * dispatch cannot be produced from outside a synchronous command call; that refusal
 * (ATTEMPT_RESOURCE_COMMIT_UNAVAILABLE with upstream EXPECTED_VERSION_CONFLICT) is
 * asserted against the production authority surface in
 * `attempt-resource-transition.test.ts`. This file asserts the seam-visible
 * neighbours instead: a replayed envelope and a repeated valid GRANT.
 */

const CREDENTIAL = "resource-confirm-released-operator";
const DECIDED_AT = "2026-08-23T00:00:00.000Z";
const CLOCK = (): string => DECIDED_AT;
const encoder = new TextEncoder();
const roots: string[] = [];
const closers: (() => void)[] = [];

afterAll(() => {
  // Every handle first, then the files: Windows keeps a SQLite file locked while
  // any handle on it is still open, and rmSync would fail with EPERM.
  while (closers.length > 0) closers.pop()?.();
  for (const root of roots) rmSync(root, { force: true, recursive: true });
});

/** res-2 and res-3 cannot be fenced, so an UNKNOWN failure on res-1 quarantines
 *  ALL THREE — the set a single proven release has to clear whole. */
const unfenceableRows = (): Record<string, unknown>[] => [
  resourceRow("res-1"), resourceRow("res-2", { fenceable: false }),
  resourceRow("res-3", { fenceable: false }),
];

interface World {
  readonly deps: ReturnType<ReturnType<typeof createStoreDependencies>["provide"]>;
  /** Opens a SHORT-LIVED read handle and closes it before returning: a held handle
   *  outlives the assertion and kills the worker on Windows. */
  read: <Result>(run: (store: SqliteEventStore) => Result) => Result;
}

/**
 * The provider FIRST, on a store with no history at all, then the world seeded through
 * a second handle that is closed before any assertion runs. The order is forced and was
 * measured, not guessed: `ensureGenesisRecoveryBinding` inside the provider refuses
 * RECOVERY_INITIAL_INSTALL_HISTORY_PRESENT once the store carries history.
 */
function world(label: string, rows: readonly unknown[] = cleanRows()): World {
  const root = mkdtempSync(join(tmpdir(), `moe-confirm-released-${label}-`));
  roots.push(root);
  const storePath = join(root, "project.db");
  const provider = createStoreDependencies({
    clock: CLOCK, credential: CREDENTIAL, principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID, storePath,
  });
  closers.push(() => { provider.close(); });
  const seed = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  try {
    seedReadyProject(seed);
    const activated = runEffectActivateCommand(seed, activationBytes(rows));
    if (!activated.ok) throw new Error(`activation refused: ${activated.code}`);
  } finally {
    seed.close();
  }
  return {
    deps: provider.provide(),
    read: (run) => {
      const store = SqliteEventStore.openForProject(storePath, PROJECT_ID);
      try { return run(store); } finally { store.close(); }
    },
  };
}

function send(
  target: World,
  commandId: string,
  payload: Readonly<Record<string, unknown>>,
  credential: string = CREDENTIAL,
  commandKind: string = RESOURCE_CONFIRM_RELEASED_COMMAND_KIND,
): ReturnType<typeof handleCommandRequest> {
  return handleCommandRequest(target.deps, {
    body: encoder.encode(JSON.stringify({
      commandId, commandKind, correlationId: "corr-confirm-released",
      expectedVersion: 0, payload, requestDigest: "c".repeat(64),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, sessionCredential: credential,
      targetAggregateId: ACTIVATION_AGGREGATE,
    })),
    credential,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  }, "HTTP_LISTENER");
}

/** The real reconciliation ingress, used only to REACH a quarantine through production. */
function reconcile(
  target: World, commandId: string, resourceId: string, disposition: string,
): ReturnType<typeof handleCommandRequest> {
  return send(target, commandId, {
    activationAggregateId: ACTIVATION_AGGREGATE, disposition, epoch: 1, kind: "FAIL", resourceId,
  }, CREDENTIAL, RESOURCE_RECONCILE_COMMAND_KIND);
}

const released = (proofRef: unknown): Record<string, unknown> =>
  ({ activationAggregateId: ACTIVATION_AGGREGATE, proofRef });

/** The member states the DURABLE reader answers with, by resource id. */
function statesOf(target: World): Record<string, string> {
  return target.read((store) => {
    const current = readAttemptResources(store, ACTIVATION_AGGREGATE, PROJECT_ID);
    if (!current.ok) throw new Error(`resource set unreadable: ${current.code}`);
    return Object.fromEntries(current.members.map((member) => [member.resourceId, member.state]));
  });
}

const resourceEventCount = (target: World): number =>
  target.read((store) =>
    store.readEvents(deriveAttemptResourceAggregateId(ACTIVATION_AGGREGATE)).length);

/** Durable COMMAND DECISIONS, store-wide: a suppressed no-op must mint none. */
const decisionCount = (target: World): number =>
  target.read((store) => store.readCommandDecisionsAfter(0n, 1_000).items.length);

/** Readiness as the release finalizer will read it — through the production strict
 *  surface, never recomputed here. */
function readiness(target: World): { nonTerminal: readonly string[]; terminal: boolean } {
  return target.read((store) => {
    const evidence = deriveReleaseTerminalEvidence(
      store, { attemptRef: DURABLE_ATTEMPT_REF, projectId: PROJECT_ID });
    if (!evidence.ok) throw new Error(`readiness refused: ${evidence.code}`);
    return { nonTerminal: evidence.nonTerminalResourceRefs, terminal: evidence.resourcesTerminal };
  });
}

function refusalOf(answered: ReturnType<typeof handleCommandRequest>): unknown {
  return (answered as { refusal?: unknown }).refusal;
}

/** A scoped session with exactly these capabilities, minted by the operator. */
function openSession(
  target: World, commandId: string, sessionId: string, secret: string,
  capabilities: readonly string[],
): string {
  const opened = handleCommandRequest(target.deps, {
    body: encoder.encode(JSON.stringify({
      commandId, commandKind: "session.open", correlationId: "corr-confirm-released",
      expectedVersion: 0,
      payload: {
        capabilities,
        credentialSha256: createHash("sha256").update(secret, "utf8").digest("hex"),
        expiresAt: "2027-01-01T00:00:00.000Z", sessionId,
      },
      requestDigest: "c".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: CREDENTIAL, targetAggregateId: ACTIVATION_AGGREGATE,
    })),
    credential: CREDENTIAL,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  }, "HTTP_LISTENER");
  expect(opened).toMatchObject({ outcome: "ACCEPTED" });
  return secret;
}

/** A world whose whole set is QUARANTINED, reached only through production commands. */
function quarantined(label: string): World {
  const target = world(label, unfenceableRows());
  expect(reconcile(target, `cmd-seed-${label}`, "res-1", "UNKNOWN"))
    .toMatchObject({ outcome: "ACCEPTED" });
  // The precondition, asserted rather than assumed: without it every arm below
  // would be exercising a set the grant reducer settles without reading a proof.
  expect(statesOf(target)).toEqual({
    "res-1": "QUARANTINED", "res-2": "QUARANTINED", "res-3": "QUARANTINED",
  });
  expect(readiness(target).terminal).toBe(false);
  return target;
}

describe("resource.confirm_released — the operator-proven release ingress", () => {
  it("clears EVERY quarantined member on one proof and turns readiness terminal", () => {
    const target = quarantined("clears-all");
    const before = resourceEventCount(target);

    const answered = send(target, "cmd-release-1", released("proof-operator-1"));

    expect(answered).toMatchObject({ decision: { disposition: "DECIDED" }, outcome: "ACCEPTED" });
    // RELEASED is the REDUCER's verdict; the payload carried no state to copy.
    expect(statesOf(target)).toEqual({
      "res-1": "RELEASED", "res-2": "RELEASED", "res-3": "RELEASED",
    });
    expect(resourceEventCount(target)).toBe(before + 1);
    expect(readiness(target)).toEqual({ nonTerminal: [], terminal: true });
  });

  it("reports the set terminal only when EVERY member is, not merely the cleared ones", () => {
    const target = world("partial-terminality");
    // THE ONE PLANTED PRECONDITION, and only the precondition: a MIXED durable set
    // whose non-quarantined member is still ACTIVE. `adapterFail` moves every row at
    // once, so no production path can leave an ACTIVE member beside a QUARANTINED
    // one — and without that shape a cleared set is trivially all-RELEASED and the
    // "every member" clause could never be observed failing.
    target.read((store) => {
      plantResourceEvent(store, ATTEMPT_RESOURCE_TRANSITION_EVENT_TYPE, canonicalBytes(
        resourceBody({
          members: [
            resourceRow("res-1", { state: "QUARANTINED" }), resourceRow("res-2"),
            resourceRow("res-3", { state: "RELEASED" }),
          ],
        })), 1, "partial-terminality");
    });
    expect(readiness(target)).toEqual({ nonTerminal: ["res-1", "res-2"], terminal: false });

    const answered = send(target, "cmd-release-partial", released("proof-operator-2"));

    expect(answered).toMatchObject({ decision: { disposition: "DECIDED" }, outcome: "ACCEPTED" });
    // The quarantine cleared, and the answer is STILL not terminal: one ACTIVE member
    // the reducers can still move keeps the whole set non-terminal.
    expect(statesOf(target)).toEqual({
      "res-1": "RELEASED", "res-2": "ACTIVE", "res-3": "RELEASED",
    });
    expect(readiness(target)).toEqual({ nonTerminal: ["res-2"], terminal: false });
  });

  it("is idempotent: a repeated valid proof writes nothing and moves nothing", () => {
    const target = quarantined("repeated");
    expect(send(target, "cmd-repeat-1", released("proof-operator-3")))
      .toMatchObject({ outcome: "ACCEPTED" });
    const cleared = statesOf(target);
    const afterFirst = resourceEventCount(target);

    // A DIFFERENT command id, so idempotency never sees this as a replay: the
    // reducer accepts a set with no quarantine and returns it unchanged, and an
    // accepted no-op must not append a transition carrying the states already held.
    const again = send(target, "cmd-repeat-2", released("proof-operator-4"));

    expect(again).toMatchObject({ decision: { disposition: "DECIDED" }, outcome: "ACCEPTED" });
    expect(resourceEventCount(target)).toBe(afterFirst);
    expect(statesOf(target)).toEqual(cleared);
    expect(readiness(target).terminal).toBe(true);
  });

  it("decides a replayed envelope once: no second event and no second decision", () => {
    const target = quarantined("replay");
    expect(send(target, "cmd-replay-1", released("proof-operator-5")))
      .toMatchObject({ outcome: "ACCEPTED" });
    const afterFirst = resourceEventCount(target);
    const decisionsAfterFirst = decisionCount(target);

    const replayed = send(target, "cmd-replay-1", released("proof-operator-5"));

    // MEASURED, and it differs from the reconcile seam on purpose. There a replay is
    // PORT_REFUSED because the reducer's state guard rejects a second failure report
    // over an already-released row. A second PROVEN RELEASE is not incoherent — the
    // set is simply already clear — so the authority's no-op suppression answers and
    // this is an idempotent success. The load-bearing half is what did NOT happen:
    // no transition event, and no second durable command decision, because the
    // suppressed path never reaches `commitExpectedVersionDecision` at all.
    expect(replayed).toMatchObject({
      decision: { disposition: "DECIDED" }, httpStatus: 200, ok: true, outcome: "ACCEPTED",
    });
    expect(resourceEventCount(target)).toBe(afterFirst);
    expect(decisionCount(target)).toBe(decisionsAfterFirst);
    expect(statesOf(target)).toEqual({
      "res-1": "RELEASED", "res-2": "RELEASED", "res-3": "RELEASED",
    });
  });
});

describe("resource.confirm_released — the operator is the fence", () => {
  it("refuses an ADMIN-capable non-operator and admits the configured operator", () => {
    const target = quarantined("operator-fence");
    const before = resourceEventCount(target);
    const secret = openSession(
      target, "cmd-open-admin", "sess-admin-not-operator", "secret-admin-not-operator",
      ["project.admin"]);

    // ADMIN reaches DISPATCH — the capability fence is satisfied — and is refused
    // there by the operator gate. A CAPABILITY_DENIED here would mean this arm
    // never reached the fence it claims to test.
    const refused = send(target, "cmd-nonoperator-1", released("proof-forged"), secret);

    expect(refused).toMatchObject({
      httpStatus: 403, ok: false, outcome: "PORT_REFUSED", stage: "DISPATCH",
    });
    expect(refusalOf(refused)).toMatchObject({
      code: "OPERATOR_PRINCIPAL_REQUIRED", layer: "DAEMON_AUTHORIZATION",
    });
    expect(resourceEventCount(target)).toBe(before);
    expect(statesOf(target)["res-1"]).toBe("QUARANTINED");

    // THE IDENTICAL FIXTURE AND AN IDENTICAL PAYLOAD SHAPE, as the operator. Without
    // this half the refusal above could be any unrelated fault on this world.
    const admitted = send(target, "cmd-operator-1", released("proof-forged"));

    expect(admitted).toMatchObject({ outcome: "ACCEPTED" });
    expect(statesOf(target)["res-1"]).toBe("RELEASED");
    expect(resourceEventCount(target)).toBe(before + 1);
  });
});

describe("resource.confirm_released — the operator may not state an outcome", () => {
  /** Keys the exact allow-list does not carry. Each is a way of asserting the ANSWER
   *  rather than supplying identity plus evidence, and the seam refuses all of them
   *  structurally, one stage above any handler. */
  const SMUGGLED: readonly (readonly [string, Record<string, unknown>])[] = [
    ["a resource id", { resourceId: "res-1" }],
    ["a state", { state: "RELEASED" }],
    ["a terminal flag", { terminal: true }],
    ["a member list", { members: [{ resourceId: "res-1", state: "RELEASED" }] }],
    ["an epoch", { epoch: 1 }],
    ["a caller project", { projectId: "project-foreign" }],
  ];

  it("sweeps every transcribed smuggled key", () => {
    expect(SMUGGLED).toHaveLength(6);
  });

  it.each(SMUGGLED)("refuses %s at the payload allow-list and writes nothing", (label, extra) => {
    const target = quarantined(`smuggled-${label.replaceAll(" ", "-")}`);
    const before = resourceEventCount(target);

    const answered = send(
      target, `cmd-smuggled-${label.replaceAll(" ", "-")}`,
      { ...released("proof-smuggled"), ...extra });

    expect(answered).toMatchObject({
      error: { code: "INPUT_INVALID" }, httpStatus: 400, ok: false, outcome: "REFUSED",
      stage: "PAYLOAD_SHAPE",
    });
    expect(resourceEventCount(target)).toBe(before);
    expect(statesOf(target)["res-1"]).toBe("QUARANTINED");
  });

  it("carries exactly the two admitted keys, in sorted order", () => {
    // The roster itself, so a key added later is a deliberate edit and not a drift.
    expect([...RESOURCE_CONFIRM_RELEASED_PAYLOAD_KEYS])
      .toEqual(["activationAggregateId", "proofRef"]);
  });
});

describe("resource.confirm_released — a request that cannot become a report", () => {
  /** Refused by THIS ingress, at its own layer, before a typed report exists. */
  const MALFORMED: readonly (readonly [string, Record<string, unknown>])[] = [
    ["no proof at all", { activationAggregateId: ACTIVATION_AGGREGATE }],
    ["a numeric proof", { activationAggregateId: ACTIVATION_AGGREGATE, proofRef: 7 }],
    ["a null proof", { activationAggregateId: ACTIVATION_AGGREGATE, proofRef: null }],
    ["an object proof", { activationAggregateId: ACTIVATION_AGGREGATE, proofRef: { ref: "p" } }],
    ["no activation", { proofRef: "proof-orphan" }],
    ["a numeric activation", { activationAggregateId: 7, proofRef: "proof-orphan" }],
    // IDENTITY MUST BE NAMEABLE, and this is the asymmetry with `proofRef` above:
    // an empty proof is admitted because the SCHEDULER owns what a proof is, while
    // an empty activation names no aggregate at all and can only be refused here.
    ["an empty activation", { activationAggregateId: "", proofRef: "proof-orphan" }],
    ["nothing at all", {}],
  ];

  it("sweeps every transcribed malformed request", () => {
    expect(MALFORMED).toHaveLength(8);
  });

  it.each(MALFORMED)("refuses %s at its own layer and writes nothing", (label, payload) => {
    const target = quarantined(`malformed-${label.replaceAll(" ", "-")}`);
    const before = resourceEventCount(target);

    const answered = send(target, `cmd-malformed-${label.replaceAll(" ", "-")}`, payload);

    expect(answered).toMatchObject({
      httpStatus: 422, ok: false, outcome: "PORT_REFUSED", stage: "DISPATCH",
    });
    // THE LAYER IS THE DISCRIMINATOR: a SCHEDULER_RESOURCE_AUTHORITY layer here
    // would mean an untyped request had been forwarded to the reducer.
    expect(refusalOf(answered)).toMatchObject({
      code: "RESOURCE_CONFIRM_RELEASED_REQUEST_MALFORMED",
      layer: DAEMON_RESOURCE_CONFIRM_RELEASED,
    });
    expect(resourceEventCount(target)).toBe(before);
    expect(statesOf(target)["res-1"]).toBe("QUARANTINED");
  });

  it("forwards an EMPTY proof to the scheduler, which refuses it and its layer shows", () => {
    const target = quarantined("empty-proof");
    const before = resourceEventCount(target);

    // An empty string IS a string, so this ingress admits it and the SCHEDULER is
    // what refuses. Refusing it locally would move the boundary and hide which
    // authority decides what counts as a proof.
    const answered = send(target, "cmd-empty-proof", released(""));

    expect(refusalOf(answered)).toMatchObject({
      code: "ATTEMPT_RESOURCE_SET_REFUSED", detail: "AUTHORITY_STALE_LEASE",
      layer: SCHEDULER_RESOURCE_AUTHORITY,
    });
    expect(resourceEventCount(target)).toBe(before);
    expect(statesOf(target)["res-1"]).toBe("QUARANTINED");
  });
});

describe("resource.confirm_released — refusals keep their owning source's code", () => {
  it("refuses an activation this project cannot read, and writes nothing anywhere", () => {
    const target = quarantined("foreign-activation");
    const foreign = `${ACTIVATION_AGGREGATE}-foreign`;
    const before = resourceEventCount(target);

    const answered = send(
      target, "cmd-foreign-1", { activationAggregateId: foreign, proofRef: "proof-foreign" });

    expect(refusalOf(answered)).toMatchObject({
      code: "ATTEMPT_RESOURCE_ACTIVATION_UNREADABLE", layer: DAEMON_ATTEMPT_RESOURCE,
    });
    expect(target.read((store) =>
      store.readEvents(deriveAttemptResourceAggregateId(foreign)).length)).toBe(0);
    expect(resourceEventCount(target)).toBe(before);
    expect(statesOf(target)["res-1"]).toBe("QUARANTINED");
  });

  it("refuses an AMBIGUOUS durable set rather than picking one of its binds", () => {
    const target = quarantined("ambiguous");
    const before = resourceEventCount(target);
    // Planted because production cannot emit it: a second bind event is exactly the
    // durable ambiguity the strict reader exists to refuse, and a grant over it must
    // not resolve the ambiguity by writing a third opinion.
    target.read((store) => {
      plantResourceEvent(store, ATTEMPT_RESOURCE_BOUND_EVENT_TYPE, canonicalBytes(
        resourceBody()), before, "ambiguous-second-bind");
    });

    const answered = send(target, "cmd-ambiguous-1", released("proof-ambiguous"));

    expect(refusalOf(answered)).toMatchObject({
      code: "ATTEMPT_RESOURCE_RECORD_AMBIGUOUS", layer: DAEMON_ATTEMPT_RESOURCE,
    });
    expect(resourceEventCount(target)).toBe(before + 1);
  });

  it("refuses a principal without project.admin before any payload field is read", () => {
    const target = quarantined("capability");
    const before = resourceEventCount(target);
    const secret = openSession(
      target, "cmd-open-work-only", "sess-work-only", "secret-work-only", ["work.write"]);

    // A payload that would otherwise be ACCEPTED, so the refusal can only be the
    // capability fence and not a shape, operator or reducer verdict.
    const answered = send(target, "cmd-capability-1", released("proof-scoped"), secret);

    expect(answered).toMatchObject({
      error: { code: "CAPABILITY_DENIED" }, httpStatus: 403, ok: false, outcome: "REFUSED",
      stage: "AUTHORIZE",
    });
    expect(resourceEventCount(target)).toBe(before);
    expect(statesOf(target)["res-1"]).toBe("QUARANTINED");
  });
});
