import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, expect, it } from "vitest";
import { backupFileHash } from "../backups/backup-ports.js";
import { setEnvironmentVariable } from "../environment/environment-store.js";
import { MIGRATION_RECEIPT_VERSION, migrationReceiptId, readMigrationReceipt, recordMigrationReceipt }
  from "../repository/migrations/migration-receipt.js";
import type { MigrationReceipt } from "../repository/migrations/migration-receipt.js";
import { DAEMON_COMMAND_SEAM } from "../http/http-async-contract.js";
import type { CommandHandlerInput } from "../http/http-contract.js";
import { closeStores, openRestartableStore, openStore, reopen, PROJECT_ID } from "../review/review-test-fixtures.js";
import { deploymentInfrastructureFiles } from "../repository/deployment/deployment-infrastructure-templates.js";
import { readDeployLedger, recordDeployReceipt, readDeployReceipt } from "./deploy-ledger.js";
import { DEPLOY_MIGRATION_DATABASE_VARIABLE } from "./deploy-migration-context.js";
import { createDockerDouble } from "./deploy-ports.js";
import { candidateContainerName } from "./deploy-service.js";
import { deployReceiptId } from "./deploy-receipt-contracts.js";
import { createRollbackCommandHandler } from "./rollback-command.js";
import { ROLLBACK_RESTORE_DETAILS, ROLLBACK_RESTORE_STAMP } from "./rollback-restore.js";

/**
 * WHERE THE DATABASE RESTORE SITS RELATIVE TO THE FENCES — and, in arms (vii)-(ix), WHICH DUMP a
 * history of earlier rollbacks leaves to restore. Those live here rather than beside the pure
 * selection arms because a restore marker is only honest when the REAL handler wrote it.
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

/** THE PRE-ADMISSION HOST PROBE's argv. `docker version` starts nothing, writes nothing and
 *  reserves nothing, which is the only reason an arm whose subject is "no bytes moved" may see it
 *  at all. Held as a constant so a probe that grew a side effect would have to edit this line. */
const HOST_PROBE: readonly string[] = ["version", "--format", "{{.Server.Version}}"];

/**
 * NOT `toEqual([])`, AND NOT DELETED EITHER. The precheck this row added makes a bare emptiness
 * assertion false on every restoreDatabase:true path, and replacing one with nothing is how a file
 * stops testing its own subject. `probes` is EXACT: the argv list must be that many read-only
 * probes and nothing else, so a build, create, start, cp, reload or a second unexplained probe
 * still reds, and ssh stays empty outright.
 */
function expectNoDockerEffect(
  docker: { readonly calls: readonly (readonly string[])[]; readonly sshCalls: readonly (readonly string[])[] },
  probes: number,
): void {
  expect(docker.calls).toEqual(Array.from({ length: probes }, () => [...HOST_PROBE]));
  expect(docker.sshCalls).toEqual([]);
}

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

/**
 * DoD 2 — AN UNUSABLE HOST REFUSES BEFORE THE DUMP IS EVEN NAMED.
 *
 * The defect this closes: the restore was resolved and APPLIED at :243 while the only docker
 * reachability check lived in the deploy service ~60 lines further on, so an operator whose host
 * was down got the database reverted under a still-running current application — the two ends of
 * the deployment at different versions, silently, which is worse than either refusing outright or
 * doing nothing at all.
 *
 * PROVES NOT-REACHED, NOT MERELY NOT-SUCCEEDED. `restoreDatabaseInto` here RECORDS and then
 * THROWS. Recording makes "it was never called" a readable fact rather than an inference from
 * silence; throwing makes a regression loud — if the probe ever stopped running first, the apply
 * would be reached and the rejection would become DEPLOY_ROLLBACK_RESTORE_FAILED, so this arm
 * cannot be satisfied by a handler that restored and then refused for the host.
 */
it("(vi) an UNUSABLE HOST refuses DOCKER_UNAVAILABLE before the restore is resolved or reached", async () => {
  const b = await boundHarness();
  const reached: { connection: string; path: string }[] = [];
  const probed: string[][] = [];
  const handler = createRollbackCommandHandler({ ...b.bound,
    backupPorts: { restoreDatabaseInto: async (connection: string, path: string): Promise<void> => {
      reached.push({ connection, path });
      throw new Error("the restore port must not be reached when the host is unusable");
    } },
    // A HOST THAT ANSWERS NOTHING. Modelled on the double's own `dockerUnavailable` shape: a
    // null code is what a `docker` binary that is not there produces.
    ports: { ...b.bound.ports, docker: async (args: readonly string[]) => {
      probed.push([...args]);
      return { code: null, stderr: "docker: not found", stdout: "" };
    } } });

  await expect(handler({ ...b.input, envelope: b.envelopeFor(true) })).rejects.toMatchObject({
    code: "DEPLOY_DOCKER_UNAVAILABLE", layer: "DAEMON_DEPLOY_ENGINE",
  });

  // THE POSITIVE CONTROL: the precheck really executed, and the ONLY thing it ran is the
  // read-only probe. An arm where nothing ran would satisfy every absence below for free.
  expect(probed).toEqual([[...HOST_PROBE]]);
  // THE SUBJECT: the restore was not REACHED. The port that would have recorded it recorded
  // nothing, so this is an observation and not an inference from an absent error.
  expect(reached).toEqual([]);
  // ...and no durable trace of a restore exists either, on any of the three surfaces that would
  // carry one: the request stream's event, the marker decision under its own principal, and the
  // deploy receipt the engine would have minted.
  const commandId = b.input.envelope.commandId;
  expect(b.store.readEvents(requestStream(commandId)).map(event => event.eventType))
    .not.toContain("EnvironmentRollbackRestoreApplied");
  expect(b.store.getCommandDecision({ commandId, principalId: "daemon:rollback-restore", projectId: PROJECT_ID }))
    .toBeNull();
  expect(readDeployReceipt(b.store, PROJECT_ID, deployReceiptId(PROJECT_ID, environment, commandId)).ok).toBe(false);

  // NO DOCKER STDERR ON THE REFUSAL. This one is minted before any receipt exists, so it never
  // passes through the engine's declassification and an external process's output must not reach
  // it (epic rail 3). POSITIVE CONTROL FIRST: without it, "the detail does not contain the
  // stderr" is equally true of an empty detail, a missing key or a refusal that never happened.
  const caught: unknown = await handler({ ...b.input, envelope: b.envelopeFor(true) })
    .then(() => null, (error: unknown) => error);
  const detail = (caught as { readonly detail?: unknown }).detail;
  expect(typeof detail).toBe("string");
  expect(detail).toContain("did not answer a version probe");
  expect(detail).not.toContain("not found");
});

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
  // The host probe DID run and is the only argv there: it is read-only, and its presence is the
  // positive control that the precheck executed rather than the assertion having gone slack.
  expectNoDockerEffect(b.docker, 1);
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
  // One read-only probe, nothing that moves a byte: the apply failed AFTER admission, so the
  // rollback's own docker phase must never have been reached.
  expectNoDockerEffect(b.docker, 1);
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

const SHA_A = "1".repeat(40), SHA_B = "2".repeat(40), SHA_C = "3".repeat(40), SHA_D = "4".repeat(40);

/**
 * A REAL HISTORY FOR THE DUMP WALK, assembled the way production assembles one: deploys through the
 * ledger's own writer, migrations through `recordMigrationReceipt` with a real dump behind each, and
 * EVERY ROLLBACK THROUGH THE REAL HANDLER — so a restore marker exists exactly where a restore was
 * really applied, and never because a fixture wrote one.
 *
 * ONE image digest for every deploy: the double answers a single digest, and a rollback to any of
 * these deploys has to pass the engine's image check. `rollbacks` names each rollback this history
 * will run with its TARGET's sha, because the candidate container's name carries both.
 */
function historyHarness(rollbacks: readonly (readonly [commandId: string, targetSha: string])[]) {
  const store = openStore();
  const root = mkdtempSync(join(tmpdir(), "moe-rollback-history-"));
  roots.push(root);
  const credential = (): string => CREDENTIAL;
  // A silently refused seed would make every later assertion vacuous.
  expect(setEnvironmentVariable({ credential, now: clock, projectId: PROJECT_ID, store },
    { environment, name: DEPLOY_MIGRATION_DATABASE_VARIABLE, value: DATABASE_URL })).toMatchObject({ ok: true });
  const docker = createDockerDouble({ proxyConfig: deploymentInfrastructureFiles("", []).get("docker/Caddyfile") ?? "",
    running: { app: "HEALTHY" }, imageDigest: digest,
    health: Object.fromEntries(rollbacks.map(([id, target]) => [candidateContainerName(environment, target, id), ["HEALTHY"]])) });
  /** Every dump the restore port was handed, in order — the only evidence of what was applied. */
  const applied: string[] = [];
  const handler = createRollbackCommandHandler({ operatorPrincipalId: "operator", projectId: PROJECT_ID, store, clock,
    healthBudgetMs: 1, pollMs: 1, sleep: async () => {},
    ports: { build: docker.build, docker: docker.docker, ssh: docker.ssh, transfer: docker.transfer,
      target: () => ({ network: "product", sshTarget: null, url: null }), releaseDecision: () => null },
    environmentCredential: credential, migrationWorkspace: root,
    backupPorts: { restoreDatabaseInto: async (_connection: string, path: string): Promise<void> => {
      applied.push(path);
    } } });
  const deploy = (decisionId: string, deploySha: string): string => {
    const recorded = recordDeployReceipt(store, { projectId: PROJECT_ID, environment, sha: deploySha,
      imageDigest: digest, decisionId, decidedAt: clock(), refusal: null, releaseDecision: null, url: null });
    if (!recorded.ok) throw new Error(recorded.code);
    return recorded.receipt.receiptId;
  };
  /** Dumps FIRST and then records, as `migrateWithBackup` does: the dump is the schema BEFORE it. */
  const migrate = async (decisionId: string, deploySha: string): Promise<void> => {
    const dump = join(root, `${decisionId}.sql`);
    writeFileSync(dump, `-- the schema as it stood before ${decisionId} migrated\n`);
    recordMigrationReceipt(store, { applied: [`1700000000001_${decisionId}.js`],
      backupRef: `${dump}@sha256:${await backupFileHash(dump)}`, decidedAt: clock(), environment,
      outcome: "APPLIED", projectId: PROJECT_ID, receiptId: migrationReceiptId(PROJECT_ID, decisionId),
      refusal: null, requestId: decisionId, sha: deploySha, version: MIGRATION_RECEIPT_VERSION });
  };
  /** READ BACK FROM THE STORE, never a path repeated from the fixture: the identifier is the assertion. */
  const dumpOf = (decisionId: string): string => {
    const ref = readMigrationReceipt(store, PROJECT_ID, decisionId)?.backupRef;
    if (ref === undefined || ref === null) throw new Error(`no backupRef recorded for ${decisionId}`);
    return ref.slice(0, ref.lastIndexOf("@sha256:"));
  };
  const rollback = (commandId: string, toReceiptRef: string, restoreDatabase: boolean) => handler({
    principal: { principalId: "operator", projectId: PROJECT_ID, capabilities: ["goal.write"] },
    envelope: { commandId, commandKind: "deployment.rollback", correlationId: commandId,
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, expectedVersion: store.getAggregateVersion(PROJECT_ID),
      targetAggregateId: PROJECT_ID, requestDigest: "c".repeat(64), sessionCredential: "test-credential",
      payload: { environment, toReceiptRef, restoreDatabase } } });
  /** The environment's ledger as the walk reads it, oldest first. */
  const ledger = (): readonly string[] =>
    readDeployLedger(store, PROJECT_ID).get(environment)?.receipts.map(receipt => receipt.decisionId) ?? [];
  /** The applied-restore marker, under the principal the production handler writes it with. */
  const marker = (commandId: string) =>
    store.getCommandDecision({ commandId, principalId: "daemon:rollback-restore", projectId: PROJECT_ID });
  return { applied, deploy, dumpOf, ledger, marker, migrate, rollback, store };
}

/**
 * A ROLLBACK THAT RESTORED MOVED THE SCHEMA, AND KEPT NO DUMP OF WHAT IT OVERWROTE.
 *
 * dep-b migrates, so its dump holds the schema dep-a ran against. rb-r returns to dep-a WITH a
 * restore and applies that dump. dep-d then migrates from the restored database, so ITS dump holds
 * dep-a's schema too. A rollback to dep-b now has no honest answer: nothing anywhere holds the
 * schema dep-b ran against, because rb-r overwrote it without taking a copy. The walk used to skip
 * rb-r as though it had left the schema alone, select dep-d's dump, and start dep-b's image on
 * dep-a's schema without a word — this row's own title defect, reached one rollback later.
 */
it("(vii) a RESTORING rollback between the target and its first migration refuses, restoring nothing", async () => {
  const h = historyHarness([["rb-r", SHA_A], ["rb-b", SHA_B]]);
  const a = h.deploy("dep-a", SHA_A);
  const b = h.deploy("dep-b", SHA_B);
  await h.migrate("dep-b", SHA_B);
  expect((await h.rollback("rb-r", a, true)).disposition).toBe("DECIDED");
  expect(h.applied).toEqual([h.dumpOf("dep-b")]);
  h.deploy("dep-d", SHA_D);
  await h.migrate("dep-d", SHA_D);

  // THE CASE WAS ACTUALLY BUILT. The restoring rollback sits in the ledger BETWEEN the target and
  // the migrating successor; it recorded no migration of its own, which is exactly why a walk that
  // reads only migrations skipped it; and its marker exists, which is the fact the walk must read.
  expect(h.ledger()).toEqual(["dep-a", "dep-b", "rb-r", "dep-d"]);
  expect(readMigrationReceipt(h.store, PROJECT_ID, "rb-r")).toBeNull();
  expect(h.marker("rb-r")).not.toBeNull();
  // ...and the dump the defect would apply is a different file from the one already applied.
  expect(h.dumpOf("dep-d")).not.toBe(h.dumpOf("dep-b"));

  await expect(h.rollback("rb-b", b, true)).rejects.toMatchObject({
    code: "DEPLOY_ROLLBACK_RESTORE_SCHEMA_OVERWRITTEN", layer: ROLLBACK_RESTORE_STAMP,
    detail: ROLLBACK_RESTORE_DETAILS.DEPLOY_ROLLBACK_RESTORE_SCHEMA_OVERWRITTEN,
  });
  // NOT REACHED FOR THE SECOND COMMAND: the port still holds rb-r's one call and nothing else, so
  // dep-d's dump — the later schema the walk used to select — was never applied.
  expect(h.applied).toEqual([h.dumpOf("dep-b")]);
  // ...and nothing was reserved or recorded for it: no marker, no receipt, the ledger unchanged.
  expect(h.marker("rb-b")).toBeNull();
  expect(h.ledger()).toEqual(["dep-a", "dep-b", "rb-r", "dep-d"]);
});

/**
 * THE COMPANION: THE SAME HISTORY, BUT THE MIDDLE ROLLBACK RESTORED NOTHING.
 *
 * rb-r sends restoreDatabase:false, so dep-a's image runs on dep-b's schema, dep-d migrates from
 * THAT, and dep-d's dump is exactly the schema dep-b ran against — the right answer, reached by
 * skipping rb-r. Without this arm a fix that refused on EVERY rollback receipt would pass (vii) and
 * strand every environment that was ever rolled back without its database.
 */
it("(viii) a rollback that restored NOTHING is skipped, and the later migration's dump is applied", async () => {
  const h = historyHarness([["rb-r", SHA_A], ["rb-b", SHA_B]]);
  const a = h.deploy("dep-a", SHA_A);
  const b = h.deploy("dep-b", SHA_B);
  await h.migrate("dep-b", SHA_B);
  expect((await h.rollback("rb-r", a, false)).disposition).toBe("DECIDED");
  // NOT REQUESTED MEANS NOT CALLED, and no marker claims otherwise.
  expect(h.applied).toEqual([]);
  expect(h.marker("rb-r")).toBeNull();
  h.deploy("dep-d", SHA_D);
  await h.migrate("dep-d", SHA_D);
  expect(h.ledger()).toEqual(["dep-a", "dep-b", "rb-r", "dep-d"]);

  expect((await h.rollback("rb-b", b, true)).disposition).toBe("DECIDED");
  // dep-d's dump, READ BACK FROM THE STORE — not dep-b's own, which is one step too far.
  expect(h.applied).toEqual([h.dumpOf("dep-d")]);
  expect(h.dumpOf("dep-d")).not.toBe(h.dumpOf("dep-b"));
  expect(h.marker("rb-b")).not.toBeNull();
});

/**
 * A MIGRATION BEFORE THE RESTORING ROLLBACK STILL WINS. The walk stops at the FIRST schema move after
 * the target, so a restore further on is history it never reaches. dep-a -> dep-b -> dep-c, both
 * migrating; rb-r returns to dep-a WITH a restore; then a second rollback to dep-a WITH a restore.
 * dep-b's dump is the schema dep-a ran against both times. A fix that refused on ANY restore
 * anywhere after the target would strand this environment, and this arm reds it.
 */
it("(ix) a migration BEFORE a restoring rollback is still selected for the same target", async () => {
  const h = historyHarness([["rb-r", SHA_A], ["rb-again", SHA_A]]);
  const a = h.deploy("dep-a", SHA_A);
  h.deploy("dep-b", SHA_B);
  await h.migrate("dep-b", SHA_B);
  h.deploy("dep-c", SHA_C);
  await h.migrate("dep-c", SHA_C);
  expect((await h.rollback("rb-r", a, true)).disposition).toBe("DECIDED");
  expect(h.marker("rb-r")).not.toBeNull();
  expect(h.ledger()).toEqual(["dep-a", "dep-b", "dep-c", "rb-r"]);

  expect((await h.rollback("rb-again", a, true)).disposition).toBe("DECIDED");
  expect(h.applied).toEqual([h.dumpOf("dep-b"), h.dumpOf("dep-b")]);
  // dep-c's dump holds dep-b's schema: pairing it with dep-a's image is the defect, twice over.
  expect(h.dumpOf("dep-c")).not.toBe(h.dumpOf("dep-b"));
});
