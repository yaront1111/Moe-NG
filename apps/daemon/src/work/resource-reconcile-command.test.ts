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
  ATTEMPT_RESOURCE_TRANSITION_EVENT_TYPE, DAEMON_ATTEMPT_RESOURCE,
  SCHEDULER_RESOURCE_AUTHORITY, deriveAttemptResourceAggregateId,
} from "./attempt-resource-authority-contracts.js";
import { readAttemptResources } from "./attempt-resource-reader.js";
import {
  ACTIVATION_AGGREGATE, DURABLE_ATTEMPT_REF, activationBytes, canonicalBytes, cleanRows,
  failableRows, plantResourceEvent, resourceBody, resourceRow,
} from "./attempt-resource-test-harness.js";
import { deriveAttemptReleaseAggregateId } from "./attempt-release-store.js";
import { deriveReleaseTerminalEvidence } from "./release-terminal-evidence.js";
import {
  DAEMON_RESOURCE_RECONCILE, RESOURCE_RECONCILE_COMMAND_KIND, RESOURCE_RECONCILE_PAYLOAD_KEYS,
} from "./resource-reconcile-command.js";

/**
 * The AUTHENTICATED reconciliation ingress, driven end to end.
 *
 * EVERY ARM GOES THROUGH `handleCommandRequest`, never through
 * `applyAttemptResourceReport`: DoD 4 forbids a helper-only proof, and the whole
 * point of this row is that the seam authenticates, authorizes and shape-checks
 * BEFORE any payload field is read. A direct call would skip exactly the three
 * stages the row exists to add.
 *
 * WHY ONE ARM PLANTS ITS SEED, stated here rather than hidden at the call site.
 * `admitBind` refuses `ATTEMPT_RESOURCE_SET_NOT_ACTIVE` unless the reducer answers
 * `allActive`, so every member of a durably BOUND set is ACTIVE — and
 * `adapterConfirm` only admits an `external` row in PENDING_ACQUIRE. An accepted
 * CONFIRM is therefore unreachable from any set the production activation path can
 * bind today. The accepted-CONFIRM arm plants that ONE durable precondition (the
 * harness's own documented technique) and still sends the REPORT through the real
 * registry handler, so the ingress-to-reducer mapping is proven without a
 * fixture-only accepted control. The honest-path CONFIRM is a REFUSAL arm below.
 */

const CREDENTIAL = "resource-reconcile-operator";
const DECIDED_AT = "2026-08-22T00:00:00.000Z";
const CLOCK = (): string => DECIDED_AT;
const encoder = new TextEncoder();
const roots: string[] = [];
const closers: (() => void)[] = [];

afterAll(() => {
  while (closers.length > 0) closers.pop()?.();
  for (const root of roots) rmSync(root, { force: true, recursive: true });
});

interface World {
  readonly deps: ReturnType<ReturnType<typeof createStoreDependencies>["provide"]>;
  /** Opens a SHORT-LIVED read handle and closes it before returning: a held handle
   *  outlives the assertion and kills the worker on Windows. */
  read: <Result>(run: (store: SqliteEventStore) => Result) => Result;
  readonly storePath: string;
}

/**
 * The provider FIRST, on a store with no history at all, then the world seeded through a
 * second handle that is closed before any assertion runs. The order is forced and was
 * measured, not guessed: `ensureGenesisRecoveryBinding` inside the provider refuses
 * RECOVERY_INITIAL_INSTALL_HISTORY_PRESENT once the store carries history, and a
 * test-installed binding instead leaves every activation refused
 * RECOVERY_RECONCILIATION_REQUIRED by the activation embargo.
 */
function world(label: string, rows: readonly unknown[] = cleanRows()): World {
  const root = mkdtempSync(join(tmpdir(), `moe-reconcile-${label}-`));
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
    storePath,
  };
}

function send(
  target: World,
  commandId: string,
  payload: Readonly<Record<string, unknown>>,
  credential: string = CREDENTIAL,
): ReturnType<typeof handleCommandRequest> {
  return handleCommandRequest(target.deps, {
    body: encoder.encode(JSON.stringify({
      commandId, commandKind: RESOURCE_RECONCILE_COMMAND_KIND, correlationId: "corr-reconcile",
      expectedVersion: 0, payload, requestDigest: "b".repeat(64),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, sessionCredential: credential,
      targetAggregateId: ACTIVATION_AGGREGATE,
    })),
    credential,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  }, "HTTP_LISTENER");
}

const confirm = (resourceId: string, epoch = 1): Record<string, unknown> => ({
  activationAggregateId: ACTIVATION_AGGREGATE, epoch, kind: "CONFIRM", resourceId,
});

const fail = (
  resourceId: string, disposition: string, epoch = 1,
): Record<string, unknown> => ({
  activationAggregateId: ACTIVATION_AGGREGATE, disposition, epoch, kind: "FAIL", resourceId,
});

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

/** `resourcesTerminal` as the finalizer will read it — through the production
 *  readiness surface, never recomputed here. */
function resourcesTerminal(target: World): boolean {
  return target.read((store) => {
    const evidence = deriveReleaseTerminalEvidence(
      store, { attemptRef: DURABLE_ATTEMPT_REF, projectId: PROJECT_ID });
    if (!evidence.ok) throw new Error(`readiness refused: ${evidence.code}`);
    return evidence.resourcesTerminal;
  });
}

function refusalOf(answered: ReturnType<typeof handleCommandRequest>): unknown {
  return (answered as { refusal?: unknown }).refusal;
}

describe("resource.reconcile — the authenticated ingress", () => {
  it("applies a CONFIRM to the reducer and stores the REDUCER's rows", () => {
    const target = world("confirm-accepted");
    // The one planted precondition, and only the precondition: an external member
    // still acquiring, which no production bind can produce (see the module note).
    target.read((store) => {
      plantResourceEvent(store, ATTEMPT_RESOURCE_TRANSITION_EVENT_TYPE, canonicalBytes(
        resourceBody({
          members: [
            resourceRow("res-1", { external: true, state: "PENDING_ACQUIRE" }),
            resourceRow("res-2"), resourceRow("res-3"),
          ],
        })), 1, "confirm-accepted");
    });
    expect(statesOf(target)["res-1"]).toBe("PENDING_ACQUIRE");

    const answered = send(target, "cmd-confirm-1", confirm("res-1"));

    expect(answered).toMatchObject({ decision: { disposition: "DECIDED" }, outcome: "ACCEPTED" });
    // ACTIVE is the REDUCER's verdict, and the untouched siblings prove the row
    // list was not rebuilt from the payload: a report names one resource.
    expect(statesOf(target)).toEqual({ "res-1": "ACTIVE", "res-2": "ACTIVE", "res-3": "ACTIVE" });
    expect(resourceEventCount(target)).toBe(3);
  });

  it("applies a FAILED report and turns the readiness answer terminal", () => {
    const target = world("fail-terminal");
    // BEFORE control: without it the arm would pass on a surface that answered
    // TRUE for every set, including the ACTIVE one no release may proceed over.
    expect(resourcesTerminal(target)).toBe(false);

    const answered = send(target, "cmd-fail-1", fail("res-1", "FAILED"));

    expect(answered).toMatchObject({ decision: { disposition: "DECIDED" }, outcome: "ACCEPTED" });
    expect(statesOf(target)).toEqual({
      "res-1": "RELEASED", "res-2": "RELEASED", "res-3": "RELEASED",
    });
    expect(resourcesTerminal(target)).toBe(true);
  });

  it("keeps an UNKNOWN disposition NON-terminal — the caller cannot forge a release", () => {
    const target = world("fail-unknown");
    expect(resourcesTerminal(target)).toBe(false);

    const answered = send(target, "cmd-unknown-1", fail("res-1", "UNKNOWN"));

    // ACCEPTED and yet NOT terminal: the report was admitted, and the reducer —
    // not the reporter — decided what an uncertain outcome means.
    expect(answered).toMatchObject({ decision: { disposition: "DECIDED" }, outcome: "ACCEPTED" });
    expect(statesOf(target)["res-1"]).toBe("QUARANTINED");
    expect(resourcesTerminal(target)).toBe(false);
  });

  it("quarantines a sibling that cannot be fenced instead of releasing it", () => {
    const target = world("fail-unfenceable", failableRows());

    expect(send(target, "cmd-fail-2", fail("res-1", "FAILED"))).toMatchObject({
      outcome: "ACCEPTED",
    });

    expect(statesOf(target)).toEqual({
      "res-1": "RELEASED", "res-2": "QUARANTINED", "res-3": "RELEASED",
    });
    expect(resourcesTerminal(target)).toBe(false);
  });

  it("refuses an activation this project cannot read, and writes nothing", () => {
    const target = world("foreign");
    const foreign = `${ACTIVATION_AGGREGATE}-foreign`;

    const answered = send(target, "cmd-foreign-1", {
      ...fail("res-1", "FAILED"), activationAggregateId: foreign,
    });

    expect(answered).toMatchObject({
      httpStatus: 422, ok: false, outcome: "PORT_REFUSED", stage: "DISPATCH",
    });
    expect(refusalOf(answered)).toMatchObject({
      code: "ATTEMPT_RESOURCE_ACTIVATION_UNREADABLE", layer: DAEMON_ATTEMPT_RESOURCE,
    });
    expect(target.read((store) =>
      store.readEvents(deriveAttemptResourceAggregateId(foreign)).length)).toBe(0);
    expect(resourceEventCount(target)).toBe(1);
    expect(statesOf(target)["res-1"]).toBe("ACTIVE");
  });

  it("carries the SCHEDULER's refusal for a stale epoch, layer and upstream code intact", () => {
    const target = world("stale-epoch");

    const answered = send(target, "cmd-stale-1", fail("res-1", "FAILED", 9));

    // The LAYER is the discriminator: a DAEMON_ATTEMPT_RESOURCE layer here would
    // mean this ingress kept an epoch check of its own beside the reducer's.
    expect(refusalOf(answered)).toMatchObject({
      code: "ATTEMPT_RESOURCE_SET_REFUSED", detail: "AUTHORITY_STALE_EPOCH",
      layer: SCHEDULER_RESOURCE_AUTHORITY,
    });
    expect(resourceEventCount(target)).toBe(1);
  });

  it("carries the SCHEDULER's refusal for a resource outside the bound set", () => {
    const target = world("unknown-resource");

    const answered = send(target, "cmd-unknown-2", fail("res-9", "FAILED"));

    expect(refusalOf(answered)).toMatchObject({
      code: "ATTEMPT_RESOURCE_SET_REFUSED", detail: "AUTHORITY_STALE_LEASE",
      layer: SCHEDULER_RESOURCE_AUTHORITY,
    });
    expect(resourceEventCount(target)).toBe(1);
  });

  it("refuses a CONFIRM against an already-ACTIVE member, and writes nothing", () => {
    const target = world("confirm-incoherent");

    const answered = send(target, "cmd-confirm-2", confirm("res-1"));

    expect(refusalOf(answered)).toMatchObject({
      code: "ATTEMPT_RESOURCE_SET_REFUSED", detail: "AUTHORITY_STALE_LEASE",
      layer: SCHEDULER_RESOURCE_AUTHORITY,
    });
    expect(resourceEventCount(target)).toBe(1);
    expect(statesOf(target)["res-1"]).toBe("ACTIVE");
  });

  it("refuses a report whose kind the vocabulary does not carry", () => {
    const target = world("malformed-kind");

    const answered = send(target, "cmd-malformed-1", {
      ...confirm("res-1"), kind: "GRANT",
    });

    expect(refusalOf(answered)).toMatchObject({
      code: "RESOURCE_RECONCILE_REQUEST_MALFORMED", layer: DAEMON_RESOURCE_RECONCILE,
    });
    expect(resourceEventCount(target)).toBe(1);
  });

  it("refuses a FAIL that states no disposition rather than inventing one", () => {
    const target = world("missing-disposition");

    const answered = send(target, "cmd-malformed-2", {
      activationAggregateId: ACTIVATION_AGGREGATE, epoch: 1, kind: "FAIL", resourceId: "res-1",
    });

    expect(refusalOf(answered)).toMatchObject({
      code: "RESOURCE_RECONCILE_REQUEST_MALFORMED", layer: DAEMON_RESOURCE_RECONCILE,
    });
    expect(resourceEventCount(target)).toBe(1);
  });

  it("refuses a CONFIRM that ALSO carries a disposition, and writes nothing", () => {
    const target = world("incoherent-confirm-key");

    // `disposition` IS in RESOURCE_RECONCILE_PAYLOAD_KEYS, so `checkPayload` admits the key and
    // the refusal can only come from `reportOf`'s coherence branch. An INPUT_INVALID / 400 here
    // would mean this arm had re-tested the allow-list (see the smuggled-STATE arm below) rather
    // than the rule that one request must not carry two readings of itself.
    const answered = send(target, "cmd-malformed-3", {
      ...confirm("res-1"), disposition: "FAILED",
    });

    expect(refusalOf(answered)).toMatchObject({
      code: "RESOURCE_RECONCILE_REQUEST_MALFORMED", layer: DAEMON_RESOURCE_RECONCILE,
    });
    expect(resourceEventCount(target)).toBe(1);
  });

  // The epoch is an acquisition COUNTER and the reducer compares it for EQUALITY, so a number
  // that is not a count must be refused rather than coerced to a neighbouring one. Both cases
  // reach `reportOf`: `epoch` is in the allow-list, so `checkPayload` admits the key, and both
  // values survive the bounded decode unchanged. An unsafe integer does NOT reach it — the arm
  // below this one records which layer answers that instead.
  it.each<readonly [string, number]>([
    ["fractional", 1.5],
    ["negative", -1],
  ])("refuses a %s epoch, and writes nothing", (label, epoch) => {
    const target = world(`bad-epoch-${label.replaceAll(" ", "-")}`);

    const answered = send(target, `cmd-epoch-${label.replaceAll(" ", "-")}`, {
      ...confirm("res-1", epoch),
    });

    expect(refusalOf(answered)).toMatchObject({
      code: "RESOURCE_RECONCILE_REQUEST_MALFORMED", layer: DAEMON_RESOURCE_RECONCILE,
    });
    expect(resourceEventCount(target)).toBe(1);
  });

  it("refuses an epoch beyond the safe-integer range EARLIER, at the bounded decode", () => {
    const target = world("unsafe-epoch");

    // MEASURED, and recorded so nobody folds this case into the it.each above and reads its
    // green as coverage of `isEpoch`: 9007199254740992 (MAX_SAFE_INTEGER + 1) never reaches
    // `reportOf` at all. The bounded decode refuses it first, one layer up, with a different
    // shape entirely — `error` + `stage`, not the `refusal` the reconcile seam emits.
    const answered = send(target, "cmd-epoch-unsafe", {
      ...confirm("res-1", Number.MAX_SAFE_INTEGER + 1),
    });

    expect(refusalOf(answered)).toBeUndefined();
    expect(answered).toMatchObject({
      error: { code: "INPUT_INVALID" }, httpStatus: 400, ok: false,
      outcome: "REFUSED", stage: "DECODE",
    });
    expect(resourceEventCount(target)).toBe(1);
  });

  it("cannot be told a STATE: the exact allow-list refuses it before dispatch", () => {
    const target = world("smuggled-state");

    const answered = send(target, "cmd-smuggled-1", {
      ...fail("res-1", "FAILED"), state: "RELEASED",
    });

    expect(answered).toMatchObject({
      error: { code: "INPUT_INVALID" }, httpStatus: 400, ok: false, outcome: "REFUSED",
      stage: "PAYLOAD_SHAPE",
    });
    expect(resourceEventCount(target)).toBe(1);
    // The roster itself, so a key added later is a deliberate edit and not a drift.
    expect([...RESOURCE_RECONCILE_PAYLOAD_KEYS]).toEqual([
      "activationAggregateId", "disposition", "epoch", "kind", "resourceId",
    ]);
  });

  it("refuses a principal without work.write before any payload field is read", () => {
    const target = world("capability");
    const secret = "reconcile-scoped-secret";
    const opened = handleCommandRequest(target.deps, {
      body: encoder.encode(JSON.stringify({
        commandId: "cmd-open-session", commandKind: "session.open",
        correlationId: "corr-reconcile", expectedVersion: 0,
        payload: {
          capabilities: ["project.admin"],
          credentialSha256: createHash("sha256").update(secret, "utf8").digest("hex"),
          expiresAt: "2027-01-01T00:00:00.000Z", sessionId: "session-scoped",
        },
        requestDigest: "b".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
        sessionCredential: CREDENTIAL, targetAggregateId: ACTIVATION_AGGREGATE,
      })),
      credential: CREDENTIAL,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    }, "HTTP_LISTENER");
    expect(opened).toMatchObject({ outcome: "ACCEPTED" });

    // A payload that would otherwise be ACCEPTED, so the refusal can only be the
    // capability fence and not a shape or reducer verdict.
    const answered = send(target, "cmd-capability-1", fail("res-1", "FAILED"), secret);

    expect(answered).toMatchObject({
      error: { code: "CAPABILITY_DENIED" }, httpStatus: 403, ok: false, outcome: "REFUSED",
      stage: "AUTHORIZE",
    });
    expect(resourceEventCount(target)).toBe(1);
  });

  it("serializes two reports on one attempt without losing the first", () => {
    const target = world("race");

    const first = send(target, "cmd-race-1", fail("res-1", "FAILED"));
    // A SECOND report over the now-RELEASED set. The reducer's state guard is what
    // answers — the inner command key embeds the expected version, so idempotency
    // never sees this as a replay.
    const second = send(target, "cmd-race-2", fail("res-1", "FAILED"));

    expect(first).toMatchObject({ outcome: "ACCEPTED" });
    expect(refusalOf(second)).toMatchObject({
      code: "ATTEMPT_RESOURCE_SET_REFUSED", layer: SCHEDULER_RESOURCE_AUTHORITY,
    });
    expect(resourceEventCount(target)).toBe(2);
    expect(statesOf(target)["res-1"]).toBe("RELEASED");
  });

  it("re-sending the SAME envelope neither writes a second event nor moves a member", () => {
    const target = world("replay");

    expect(send(target, "cmd-replay-1", fail("res-1", "FAILED"))).toMatchObject({
      outcome: "ACCEPTED",
    });
    const replayed = send(target, "cmd-replay-1", fail("res-1", "FAILED"));

    expect(replayed).toMatchObject({ httpStatus: 422, ok: false, outcome: "PORT_REFUSED" });
    expect(resourceEventCount(target)).toBe(2);
    expect(statesOf(target)).toEqual({
      "res-1": "RELEASED", "res-2": "RELEASED", "res-3": "RELEASED",
    });
  });

  it("still reconciles an attempt whose release aggregate already holds a row", () => {
    const target = world("draining");
    // Design 312 admits `resource.reconcile` from a FENCED attempt. The row is
    // planted rather than recorded: the point is that this ingress consults the
    // release aggregate at all — a well-meant "no mutations while draining" guard
    // would have to read it, and this arm reds the moment one does.
    target.read((store) => {
      const payload = encoder.encode(JSON.stringify({ draining: true }));
      store.commitExpectedVersionDecision({
        commandKind: "test.plant_release", committedResultBytes: payload,
        correlationId: "plant-draining", decidedAt: DECIDED_AT,
        events: [{ eventId: "plant-draining", eventType: "AttemptReleaseRecorded", payload }],
        expectedVersion: 0,
        key: { commandId: "plant-draining", principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
        requestBytes: payload,
        targetAggregateId: deriveAttemptReleaseAggregateId(ACTIVATION_AGGREGATE),
      });
    });

    const answered = send(target, "cmd-draining-1", fail("res-1", "FAILED"));

    expect(answered).toMatchObject({ decision: { disposition: "DECIDED" }, outcome: "ACCEPTED" });
    expect(statesOf(target)["res-1"]).toBe("RELEASED");
  });
});
