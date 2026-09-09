import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, expect, it } from "vitest";
import { backupFileHash } from "../backups/backup-ports.js";
import { setEnvironmentVariable } from "../environment/environment-store.js";
import { MIGRATION_RECEIPT_VERSION, migrationReceiptId, recordMigrationReceipt }
  from "../repository/migrations/migration-receipt.js";
import type { MigrationReceipt } from "../repository/migrations/migration-receipt.js";
import { DAEMON_COMMAND_SEAM } from "../http/http-async-contract.js";
import type { CommandHandlerInput } from "../http/http-contract.js";
import { closeStores, openRestartableStore, openStore, reopen, PROJECT_ID } from "../review/review-test-fixtures.js";
import { deploymentInfrastructureFiles } from "../repository/deployment/deployment-infrastructure-templates.js";
import { recordDeployReceipt, readDeployReceipt } from "./deploy-ledger.js";
import { DEPLOY_MIGRATION_DATABASE_VARIABLE } from "./deploy-migration-context.js";
import { createDockerDouble } from "./deploy-ports.js";
import { candidateContainerName } from "./deploy-service.js";
import { deployReceiptId } from "./deploy-receipt-contracts.js";
import { createRollbackCommandHandler } from "./rollback-command.js";
import { ROLLBACK_RESTORE_DETAILS, ROLLBACK_RESTORE_STAMP } from "./rollback-restore.js";

/**
 * WHERE THE DATABASE RESTORE SITS RELATIVE TO THE FENCES, and nothing else.
 *
 * Its own file rather than more arms on rollback-command.test.ts, which is already 448 lines. The
 * harness below is a deliberate COPY of that file's `harness`/`boundHarness` with one knob changed
 * — `fail` counts attempts instead of being a latch — because duplicating a fixture is cheaper
 * than threading an option through a 448-line file every arm of which would have to be re-run.
 *
 * EVERY ARM ASSERTS TWO THINGS: the reason CODE (with the layer that minted it) and the restore
 * port's CALL COUNT. A refusal arm that only checks the code is green under a handler that
 * restored the database first and then refused, which is the exact defect this row closes.
 */

afterEach(closeStores);
const clock = () => "2026-09-06T01:00:00.000Z";
const environment = "production", sha = "a".repeat(40), digest = `sha256:${"b".repeat(64)}`;
const CREDENTIAL = "rollback-ordering-environment-credential";
/** Credential-shaped ON PURPOSE, so a leak onto any durable surface would be findable. */
const DATABASE_URL = "postgres://app:0rder1ng-s3cr3t@db.internal:5432/app";
const SECRET = "0rder1ng-s3cr3t";
const CURRENT_DECISION = "current-deploy";
const CURRENT_SHA = "d".repeat(40);
/** Every command id in this file that is expected to complete a rollback needs its candidate
 *  container marked HEALTHY, because the container name carries the command id. */
const COMMAND_IDS = ["rollback-ordering-1", "after-release-restore", "restore-after-failure",
  "retry-after-conflict"] as const;
const roots: string[] = [];
const encoder = new TextEncoder(), decoder = new TextDecoder();

const digestOf = (value: unknown): string =>
  createHash("sha256").update(encoder.encode(JSON.stringify(value))).digest("hex");
/**
 * MIRRORS THE HANDLER'S OWN DERIVATION, key order included. A drift between this and
 * rollback-command.ts can only produce an EMPTY read here and a loud red — never a false green.
 */
const requestStream = (commandId: string): string =>
  `rollback-request:${digestOf({ commandId, principalId: "operator", projectId: PROJECT_ID })}`;
const guardStream = (): string => `rollback-environment:${digestOf({ projectId: PROJECT_ID, environment })}`;
const commandKey = (commandId: string) => ({ commandId, principalId: "operator", projectId: PROJECT_ID });

/**
 * EVERY DURABLE SURFACE THIS COMMAND WRITES: the request stream's events, the environment guard's
 * events, and the result bytes of all three decisions it can mint (terminal, intent, restore
 * marker). Returned as decoded TEXT so a sweep reads the bytes themselves and not a re-encoding.
 */
function durableSurfaces(store: SqliteEventStore, commandIds: readonly string[]): readonly string[] {
  const surfaces: string[] = [];
  for (const stream of [guardStream(), ...commandIds.map(requestStream)]) {
    for (const event of store.readEvents(stream)) surfaces.push(decoder.decode(event.payload));
  }
  for (const commandId of commandIds) {
    for (const principalId of ["operator", "daemon:rollback-command", "daemon:rollback-restore"]) {
      const record = store.getCommandDecision({ commandId, principalId, projectId: PROJECT_ID });
      if (record !== null) surfaces.push(decoder.decode(record.resultBytes));
    }
  }
  // A sweep over ZERO surfaces would pass while asserting nothing at all.
  expect(surfaces.length).toBeGreaterThan(0);
  return surfaces;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root === undefined) continue;
    try { rmSync(root, { force: true, recursive: true }); }
    catch { /* a held handle on Windows must not mask a test failure */ }
  }
});

function harness(store = openStore()) {
  const source = recordDeployReceipt(store, { projectId: PROJECT_ID, environment, sha,
    imageDigest: digest, decisionId: "original", decidedAt: clock(), refusal: null, releaseDecision: null, url: null });
  if (!source.ok) throw new Error(source.code);
  const docker = createDockerDouble({ proxyConfig: deploymentInfrastructureFiles("", []).get("docker/Caddyfile") ?? "",
    running: { app: "HEALTHY" }, imageDigest: digest,
    health: Object.fromEntries(COMMAND_IDS.map(id => [candidateContainerName(environment, sha, id), ["HEALTHY"]])) });
  const options = { operatorPrincipalId: "operator", projectId: PROJECT_ID, store, clock,
    healthBudgetMs: 1, pollMs: 1, sleep: async () => {},
    ports: { build: docker.build, docker: docker.docker, ssh: docker.ssh, transfer: docker.transfer,
      target: () => ({ network: "product", sshTarget: null, url: null }), releaseDecision: () => null } };
  const input: CommandHandlerInput = { principal: { principalId: "operator", projectId: PROJECT_ID, capabilities: ["goal.write"] },
    envelope: { commandId: "rollback-ordering-1", commandKind: "deployment.rollback", correlationId: "rollback-ordering",
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, expectedVersion: store.getAggregateVersion(PROJECT_ID),
      targetAggregateId: PROJECT_ID, requestDigest: "c".repeat(64), sessionCredential: "test-credential",
      payload: { environment, toReceiptRef: source.receipt.receiptId, restoreDatabase: false } } };
  return { docker, store, options, input, handler: createRollbackCommandHandler(options) };
}

/**
 * A BOUND ENVIRONMENT with a real dump, assembled the way production assembles one.
 *
 * `fail` counts: `true` fails every attempt, a NUMBER fails the first N and then succeeds. The
 * number form is what lets an arm show that a FRESH command still completes after a failed one —
 * "the guard was released" is only proved by a later command getting through it.
 */
async function boundHarness(
  options: { readonly bind?: boolean; readonly fail?: boolean | number; readonly store?: SqliteEventStore } = {},
) {
  const h = harness(options.store);
  const root = mkdtempSync(join(tmpdir(), "moe-rollback-ordering-"));
  roots.push(root);
  const dump = join(root, "pre-migration.sql");
  writeFileSync(dump, "-- the schema the kept deploy ran against\nCREATE TABLE kept();\n");
  const current = recordDeployReceipt(h.store, { projectId: PROJECT_ID, environment, sha: CURRENT_SHA,
    imageDigest: `sha256:${"e".repeat(64)}`, decisionId: CURRENT_DECISION, decidedAt: clock(),
    refusal: null, releaseDecision: null, url: null });
  expect(current).toMatchObject({ ok: true });
  const receipt: MigrationReceipt = {
    applied: ["1700000000002_current.js"], backupRef: `${dump}@sha256:${await backupFileHash(dump)}`,
    decidedAt: clock(), environment, outcome: "APPLIED", projectId: PROJECT_ID,
    receiptId: migrationReceiptId(PROJECT_ID, CURRENT_DECISION), refusal: null,
    requestId: CURRENT_DECISION, sha: CURRENT_SHA, version: MIGRATION_RECEIPT_VERSION,
  };
  recordMigrationReceipt(h.store, receipt);
  const credential = (): string => CREDENTIAL;
  if (options.bind !== false) {
    // A silently refused seed would make every later assertion vacuous.
    expect(setEnvironmentVariable({ credential, now: clock, projectId: PROJECT_ID, store: h.store },
      { environment, name: DEPLOY_MIGRATION_DATABASE_VARIABLE, value: DATABASE_URL })).toMatchObject({ ok: true });
  }
  const calls: { connection: string; path: string }[] = [];
  const failures = options.fail === true ? Number.POSITIVE_INFINITY
    : typeof options.fail === "number" ? options.fail : 0;
  const bound = { ...h.options, environmentCredential: credential, migrationWorkspace: root,
    backupPorts: { restoreDatabaseInto: async (connection: string, path: string): Promise<void> => {
      calls.push({ connection, path });
      // The real port collapses every thrown message to `BACKUP_FAILED`; the double mirrors it.
      if (calls.length <= failures) throw new Error("BACKUP_FAILED");
    } } };
  const envelopeFor = (restore: boolean): CommandHandlerInput["envelope"] => ({ ...h.input.envelope,
    expectedVersion: h.store.getAggregateVersion(PROJECT_ID),
    payload: { ...h.input.envelope.payload, restoreDatabase: restore } });
  return { ...h, bound, calls, dump, envelopeFor, handler: createRollbackCommandHandler(bound) };
}

it("(i) a STALE expectedVersion refuses CONFLICT with the database never touched", async () => {
  const b = await boundHarness();
  const fresh = b.envelopeFor(true);
  // OFFERED ONE VERSION PAST THE TRUTH: the project leg inside the admission commit is the only
  // thing that can see this, and it sits AFTER the point the restore used to be performed at.
  const stale = { ...fresh, expectedVersion: fresh.expectedVersion + 1 };

  await expect(b.handler({ ...b.input, envelope: stale })).rejects.toMatchObject({
    code: "EXPECTED_VERSION_CONFLICT", layer: DAEMON_COMMAND_SEAM,
  });

  // THE WHOLE POINT OF THE ROW. A refused rollback has moved no bytes: the restore port recorded
  // no invocation at all, not a no-op one. Read from the recorded calls, never from a flag.
  expect(b.calls).toEqual([]);
  // ...and nothing else ran either, so the refusal is not being satisfied by an earlier guard.
  expect(b.docker.calls).toEqual([]);
  expect(b.docker.sshCalls).toEqual([]);
  expect(readDeployReceipt(b.store, PROJECT_ID,
    deployReceiptId(PROJECT_ID, environment, b.input.envelope.commandId)).ok).toBe(false);
});

it("(ii) a held environment refuses a RESTORING contender without touching the database", async () => {
  const b = await boundHarness();
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  // The holder requests NO restore, so the only restore-port call this arm could ever see would
  // have to come from the contender.
  const holder = createRollbackCommandHandler({ ...b.bound, ports: { ...b.bound.ports,
    docker: async (args: readonly string[], stdin?: string) => {
      entered(); await barrier; return b.docker.docker(args, stdin);
    } } });
  const first = holder({ ...b.input, envelope: b.envelopeFor(false) });
  try {
    await started;
    await expect(b.handler({ ...b.input, envelope: { ...b.envelopeFor(true), commandId: "concurrent-restore" } }))
      .rejects.toMatchObject({ code: "DEPLOY_ROLLBACK_IN_PROGRESS", layer: DAEMON_COMMAND_SEAM });
    // REFUSED WITH THE SCHEMA UNTOUCHED. Before the reorder the contender restored the dump and
    // only then discovered the environment was busy.
    expect(b.calls).toEqual([]);
  } finally { release(); await first; }
  expect((await first).disposition).toBe("DECIDED");

  // THE NON-VACUITY HALF. Without it, a port that is simply never reachable satisfies the clause
  // above for the wrong reason.
  //
  // ON A FRESH FIXTURE, and that is not a dodge. Once the holder's rollback LANDS it becomes the
  // environment's current deploy receipt, and a rollback records no migration -- so the very next
  // restore resolves to DEPLOY_ROLLBACK_RESTORE_MIGRATION_UNKNOWN and never reaches the port.
  // That is the binding refusing rather than substituting a dump it cannot identify, which is the
  // documented contract, but it means "the guard is free" cannot be shown by restoring twice in a
  // row. What has to be falsifiable is that a restore:true command against THIS fixture shape does
  // reach the port, and that is what the arm below shows.
  const reachable = await boundHarness();
  const after = await reachable.handler({ ...reachable.input,
    envelope: { ...reachable.envelopeFor(true), commandId: "after-release-restore" } });
  expect(after.disposition).toBe("DECIDED");
  expect(reachable.calls).toHaveLength(1);
  // ...and the contender's fixture recorded none, which is the contrast the arm exists for.
  expect(b.calls).toEqual([]);

  // WHAT THIS ARM DOES AND DOES NOT PROVE: it pins the guard-parity READ, the check that answers
  // when a prior command still holds the environment. It does NOT pin the two-process race where
  // both readers pass parity and the admission commit itself picks the winner. The reorder closes
  // that one too, since the apply now sits after the commit, but no single-process arm can exhibit
  // it and claiming otherwise here would be the vacuous half of this file.
});

it("(iii) a post-admission apply failure records a REFUSED terminal and frees the environment", async () => {
  const b = await boundHarness({ fail: 1 });
  const first = b.input.envelope.commandId;

  await expect(b.handler({ ...b.input, envelope: b.envelopeFor(true) })).rejects.toMatchObject({
    code: "DEPLOY_ROLLBACK_RESTORE_FAILED", layer: ROLLBACK_RESTORE_STAMP,
  });
  expect(b.calls).toHaveLength(1);
  expect(b.docker.calls).toEqual([]);
  expect(readDeployReceipt(b.store, PROJECT_ID, deployReceiptId(PROJECT_ID, environment, first)).ok).toBe(false);

  // THE DURABLE ANSWER IS A TERMINAL DECISION, not an absent one and not a deploy receipt.
  const terminal = b.store.getCommandDecision(commandKey(first));
  expect(terminal?.commandKind).toBe("deployment.rollback");
  expect(JSON.parse(decoder.decode(terminal?.resultBytes ?? new Uint8Array()))).toMatchObject({
    outcome: "REFUSED", receiptId: null, restoreApplied: false,
    refusal: { code: "DEPLOY_ROLLBACK_RESTORE_FAILED",
      detail: ROLLBACK_RESTORE_DETAILS.DEPLOY_ROLLBACK_RESTORE_FAILED, layer: ROLLBACK_RESTORE_STAMP },
  });

  // THE SAME ID ANSWERS FROM THAT RECORD rather than attempting again.
  await expect(b.handler({ ...b.input, envelope: b.envelopeFor(true) })).rejects.toMatchObject({
    code: "DEPLOY_ROLLBACK_RESTORE_FAILED", layer: ROLLBACK_RESTORE_STAMP,
  });
  expect(b.calls).toHaveLength(1);

  // A FRESH ID IS ADMITTED AND COMPLETES, the only proof the guard was released. This fixture
  // fails the FIRST attempt only, so the second reaches the port and succeeds.
  const second = "restore-after-failure";
  const decision = await b.handler({ ...b.input, envelope: { ...b.envelopeFor(true), commandId: second } });
  expect(decision.disposition).toBe("DECIDED");
  expect(b.calls).toHaveLength(2);
  const receipt = readDeployReceipt(b.store, PROJECT_ID, deployReceiptId(PROJECT_ID, environment, second));
  expect(receipt.ok && receipt.receipt.imageDigest).toBe(digest);

  // SECRET SWEEP, positive control FIRST: the resolved value really did carry the credential, so
  // an empty sweep cannot be mistaken for a clean one.
  expect(b.calls[0]?.connection).toContain(SECRET);
  for (const surface of durableSurfaces(b.store, [first, second])) expect(surface).not.toContain(SECRET);
});

it("(iv) a conflicted rollback restores nothing and its RETRY restores exactly once", async () => {
  const b = await boundHarness();
  const fresh = b.envelopeFor(true);

  await expect(b.handler({ ...b.input, envelope: { ...fresh, expectedVersion: fresh.expectedVersion + 1 } }))
    .rejects.toMatchObject({ code: "EXPECTED_VERSION_CONFLICT", layer: DAEMON_COMMAND_SEAM });
  // CHECKPOINT ONE, and it is why a single grand total would not do: a handler that restored on
  // the conflicted command and then skipped the retry also produces a total of one.
  expect(b.calls).toEqual([]);

  // CHECKPOINT TWO. The retry under a NEW id is admitted and applies the dump ONCE.
  const retry = "retry-after-conflict";
  const decision = await b.handler({ ...b.input, envelope: { ...b.envelopeFor(true), commandId: retry } });
  expect(decision.disposition).toBe("DECIDED");
  expect(b.calls).toHaveLength(1);
  expect(b.calls[0]).toEqual({ connection: DATABASE_URL, path: b.dump });

  // A REPLAY of that retry adds nothing: one dump, one application, across all three commands.
  const replayed = await b.handler({ ...b.input, envelope: { ...b.envelopeFor(true), commandId: retry } });
  expect(replayed.disposition).toBe("REPLAYED");
  expect(b.calls).toHaveLength(1);
});

it("(v) writes requested then restore-applied then decided, and a replay applies no second dump", async () => {
  const restartable = openRestartableStore();
  const b = await boundHarness({ store: restartable.store });
  const envelope = b.envelopeFor(true);
  const original = b.store.commitExpectedVersionDecisionLegs.bind(b.store);
  // Interrupts ONLY the terminal commit: the restore marker is a different command kind and lands.
  const interrupted = new Proxy(b.store, { get(target, property) {
    if (property === "commitExpectedVersionDecisionLegs") return (input: Parameters<typeof original>[0]) => {
      if (input.commandKind === "deployment.rollback") throw new Error("injected final write interruption");
      return original(input);
    };
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });

  await expect(createRollbackCommandHandler({ ...b.bound, store: interrupted })({ ...b.input, envelope }))
    .rejects.toThrow("injected final write interruption");
  expect(b.calls).toHaveLength(1);

  const reopened = reopen(restartable);
  const replay = await createRollbackCommandHandler({ ...b.bound, store: reopened })({ ...b.input, envelope });
  expect(replay.disposition).toBe("REPLAYED");
  // THE RECOVERED RUN DID NOT RE-APPLY. An admitted restore whose effect is already durable may
  // never be attempted a second time, and the marker is how recovery knows it happened.
  expect(b.calls).toHaveLength(1);

  // THE STREAM SHAPE, exactly and in order. The marker between the request and the decision is
  // what makes an applied restore distinguishable from an unapplied one after a crash.
  expect(reopened.readEvents(requestStream(envelope.commandId)).map(event => event.eventType)).toEqual([
    "EnvironmentRollbackRequested", "EnvironmentRollbackRestoreApplied", "EnvironmentRollbackDecided",
  ]);
  // ...and the terminal says so in its own bytes, so a reader needs no version arithmetic.
  const terminal = reopened.getCommandDecision(commandKey(envelope.commandId));
  expect(JSON.parse(decoder.decode(terminal?.resultBytes ?? new Uint8Array())))
    .toMatchObject({ outcome: "DEPLOYED", restoreApplied: true });

  // SECRET SWEEP over every stream and decision this command wrote, positive control first.
  expect(b.calls[0]?.connection).toContain(SECRET);
  for (const surface of durableSurfaces(reopened, [envelope.commandId])) expect(surface).not.toContain(SECRET);
});
