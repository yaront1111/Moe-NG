import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { closeStores, openStore, openRestartableStore, reopen, PROJECT_ID }
  from "../review/review-test-fixtures.js";
import { deploymentInfrastructureFiles }
  from "../repository/deployment/deployment-infrastructure-templates.js";
import { CONTROLLED_PROFILE_VERSION }
  from "../repository/controlled-profile/controlled-profile-generator.js";
import {
  DEPLOY_BUILD_FAILED, DEPLOY_DOCKER_UNAVAILABLE, DEPLOY_ENGINE_STAMP, DEPLOY_TARGET_MISSING,
  deployAggregateId,
} from "./deploy-receipt-contracts.js";
import type { DeployRefusalCode } from "./deploy-receipt-contracts.js";
import { createDockerDouble } from "./deploy-ports.js";
import type {
  DeployMigrationPort, DeployRunResult, DeployTarget, DockerDoubleOptions, DockerRunner,
} from "./deploy-ports.js";
import { readDeployLedger, recordDeployReceipt } from "./deploy-ledger.js";
import type { RecordDeployReceiptInput } from "./deploy-ledger.js";
import { buildArgv, candidateContainerName, createDeployService } from "./deploy-service.js";

/**
 * EPIC RAIL 3 AT THE WRITE BOUNDARY. A deploy refusal's detail is external free text — docker's
 * stderr, ssh's stderr, a migration engine's words — and any of it can carry a connection string,
 * a registry token or an echoed authorization header. Scrubbing it at the READ or in the browser
 * would leave the plaintext durable in the event store forever, so the only layer that can answer
 * is the one that writes the receipt.
 *
 * WHAT THESE ARMS PIN, and why they are shaped this way:
 *  - Every sensitive-looking byte is GENERATED IN PROCESS (`randomBytes`), never a committed
 *    fixture, and never printed: assertions compare BOOLEANS so a failure cannot dump the raw
 *    actual text into a log a reviewer then has to redact by hand.
 *  - Absence is asserted on the RETURNED receipt, on the durable decision bytes, on the event
 *    payload AND on the sqlite file itself. A marker on the returned object proves nothing about
 *    what landed on disk.
 *  - The policy is a FINITE OUTPUT SET, not secret recognition, so the arms include an opaque
 *    value with no recognisable syntax and a tail-truncated line — precisely the material a URL
 *    or bearer-token regex cannot see.
 *
 * OFFLINE: docker, ssh, build and migration are doubles; the store, the writer and the reader are
 * the production ones. Every handle is registered with the shared fixture and closed by
 * `afterEach(closeStores)`, which vitest runs on the throwing path too.
 */

afterEach(closeStores);

/** The exact marker, restated here rather than imported: an arm that imported the production
 *  constant would follow it to any other value and keep passing. */
const REDACTED = "[REDACTED]";

const ENVIRONMENT = "production";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const DECIDED_AT = "2026-09-08T00:00:00.000Z";
const CONTEXT = "/workspace/app";
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const INCUMBENT = "app";
const PROXY_CONFIG =
  deploymentInfrastructureFiles(CONTROLLED_PROFILE_VERSION, []).get("docker/Caddyfile") ?? "";
const LOCAL: DeployTarget = { network: "moe-net", sshTarget: null, url: "https://app.example.test" };
const REMOTE: DeployTarget = { ...LOCAL, sshTarget: "deployer@host.example.test" };

/** THE AUDITED PUBLIC PHASE LITERALS. Every one is minted by production code with no caller text
 *  in it (deploy-service.ts, deploy-image-build.ts and — for the migration composite — the
 *  closed-roster code, layer and detail migration-service.ts mints), which is the whole reason
 *  they may survive: they are outputs of a finite set, not inputs that happened to look safe. */
const SAFE_PHASES = [
  "DEPLOY_PROXY_MISSING_OR_AMBIGUOUS", "DEPLOY_PROXY_BUSY", "DEPLOY_PROXY_CONFIG_UNSUPPORTED",
  "DEPLOY_PROXY_INCUMBENT_MISSING", "DEPLOY_PROXY_RECOVERY_REQUIRED", "DEPLOY_PROXY_WRITE_FAILED",
  "DEPLOY_PROXY_RELOAD_FAILED", "DEPLOY_BUILD_UNAVAILABLE", "DEPLOY_IMAGE_DIGEST_UNAVAILABLE",
  "DEPLOY_ROLLBACK_IMAGE_UNAVAILABLE", "DEPLOY_EFFECT_UNAVAILABLE", "DEPLOY_COMMIT_UNAVAILABLE",
  "DEPLOY_ARCHIVE_UNAVAILABLE", "DEPLOY_ARCHIVE_FAILED", "DEPLOY_DOCKER_UNAVAILABLE",
  "DEPLOY_BUILD_STDIN_FAILED", "DEPLOY_BUILD_TIMED_OUT",
  "MIGRATION_TOOL_MISSING@DAEMON_INGRESS: MIGRATION_TOOL_MISSING",
] as const;

/** A fresh opaque value per call. Returned, never logged, never written to a file in the tree. */
const generated = (): string => randomBytes(24).toString("hex");

/** The shapes real deploy diagnostics carry a secret in. `opaque` is the load-bearing one: it has
 *  no URL, no header and no delimiter, so nothing but a finite output set can protect it. */
const carriers: Readonly<Record<string, (value: string) => string>> = {
  "credential-bearing url": (value) =>
    `failed to solve: postgres://deployer:${value}@db.internal:5432/app refused the connection`,
  "authorization header": (value) => `unauthorized: Authorization: Bearer ${value}`,
  "opaque value": (value) => value,
  "tail-truncated multiline": (value) => `Step 7/9 : RUN build\n${"filler ".repeat(120)}${value}`,
  "unknown code-looking string": (value) => `DEPLOY_UNKNOWN_PHASE_${value}`,
};

/** Boolean comparisons ONLY. `expect(detail).toBe(REDACTED)` prints the actual string on failure,
 *  which is the one thing an arm about secrets must never do. */
function expectRedacted(actual: string | null | undefined, value: string): void {
  expect(actual === REDACTED).toBe(true);
  expect(typeof actual === "string" && actual.includes(value)).toBe(false);
}

function expectAbsentFromBytes(bytes: Uint8Array, value: string): void {
  expect(Buffer.from(bytes).includes(Buffer.from(value, "utf8"))).toBe(false);
}

function input(overrides: Partial<RecordDeployReceiptInput> = {}): RecordDeployReceiptInput {
  return {
    decidedAt: DECIDED_AT, decisionId: "decision-1", environment: ENVIRONMENT, imageDigest: null,
    projectId: PROJECT_ID, refusal: null, releaseDecision: null, sha: SHA, url: null, ...overrides,
  };
}

function refused(detail: string, code: DeployRefusalCode = DEPLOY_BUILD_FAILED) {
  return { code, detail, layer: DEPLOY_ENGINE_STAMP } as const;
}

/** Reads what actually LANDED: the decision bytes and every event on the deploy aggregate. */
function durableBytes(store: ReturnType<typeof openStore>): readonly Uint8Array[] {
  const decisions = store.readCommandDecisionsAfter(0n, 500).items.map((one) => one.resultBytes);
  const events = store.readEvents(deployAggregateId(PROJECT_ID, ENVIRONMENT))
    .flatMap((event) => [event.payload, event.metadata]);
  return [...decisions, ...events];
}

interface ServiceOptions {
  readonly decisionId?: string;
  readonly double?: DockerDoubleOptions;
  readonly migrate?: DeployMigrationPort;
  readonly target?: DeployTarget;
  readonly wrap?: (runner: DockerRunner) => DockerRunner;
}

function service(store: ReturnType<typeof openStore>, options: ServiceOptions = {}) {
  const decisionId = options.decisionId ?? "decision-1";
  const candidate = candidateContainerName(ENVIRONMENT, SHA, decisionId);
  const docker = createDockerDouble({
    proxyConfig: PROXY_CONFIG, health: { [candidate]: ["HEALTHY"] },
    running: { [INCUMBENT]: "HEALTHY" }, ...options.double,
  });
  const run = options.wrap?.(docker.docker) ?? docker.docker;
  const deployer = createDeployService({
    clock: () => DECIDED_AT, healthBudgetMs: 10, pollMs: 1, sleep: () => Promise.resolve(),
    ports: {
      build: (request) => run(buildArgv(request.tag)), docker: run, releaseDecision: () => null,
      ssh: docker.ssh, target: () => options.target ?? LOCAL, transfer: docker.transfer,
      ...(options.migrate === undefined ? {} : { migrate: options.migrate }),
    },
    projectId: PROJECT_ID, store,
  });
  return () => deployer.deploy({ context: CONTEXT, decisionId, environment: ENVIRONMENT, sha: SHA });
}

/** Fails a single docker verb with planted stderr, leaving every other call to the double. */
const failVerb = (verb: string, stderr: string) => (runner: DockerRunner): DockerRunner =>
  async (args, stdin): Promise<DeployRunResult> => args[0] === verb
    ? { code: 1, stderr, stdout: "" }
    : runner(args, stdin);

describe("the receipt writer declassifies an untrusted refusal detail (DoD 2, DoD 3)", () => {
  it.each(Object.keys(carriers))("redacts a %s before it reaches the store", (shape) => {
    const value = generated();
    const detail = (carriers[shape] as (one: string) => string)(value);
    // POSITIVE CONTROL: the arm is worthless if the value never entered the input.
    expect(detail.includes(value)).toBe(true);
    const store = openStore();

    const written = recordDeployReceipt(store, input({ refusal: refused(detail) }));

    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.receipt.refusal?.code).toBe(DEPLOY_BUILD_FAILED);
    expect(written.receipt.refusal?.layer).toBe(DEPLOY_ENGINE_STAMP);
    expectRedacted(written.receipt.refusal?.detail, value);
    // AND ON DISK, not merely on the object handed back.
    for (const bytes of durableBytes(store)) expectAbsentFromBytes(bytes, value);
    const current = readDeployLedger(store, PROJECT_ID).get(ENVIRONMENT)?.current;
    expectRedacted(current?.refusal?.detail, value);
  });

  it("does not mutate the caller's input object", () => {
    const value = generated();
    const refusal = refused(value);
    const request = input({ refusal });
    const store = openStore();

    expect(recordDeployReceipt(store, request).ok).toBe(true);

    expect(request.refusal === refusal).toBe(true);
    expect(refusal.detail === value).toBe(true);
  });

  it("redacts an empty detail rather than passing it through as a special case", () => {
    const store = openStore();

    const written = recordDeployReceipt(store, input({ refusal: refused("") }));

    expect(written.ok && written.receipt.refusal?.detail).toBe(REDACTED);
  });

  it("leaves a successful receipt untouched", () => {
    const store = openStore();

    const written = recordDeployReceipt(store, input({ imageDigest: IMAGE_DIGEST }));

    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.receipt.outcome).toBe("DEPLOYED");
    expect(written.receipt.refusal).toBeNull();
    expect(written.receipt.imageDigest).toBe(IMAGE_DIGEST);
  });
});

describe("the surviving details are a FINITE PUBLIC SET, not a credential detector", () => {
  it.each(SAFE_PHASES)("keeps the audited phase literal %s verbatim", (phase) => {
    const store = openStore();

    const written = recordDeployReceipt(store, input({ refusal: refused(phase) }));

    expect(written.ok && written.receipt.refusal?.detail).toBe(phase);
  });

  it("admits the audited literals only as WHOLE strings", () => {
    // Every near miss is built from a real member, so a `startsWith`/`includes`/`trim` policy
    // passes it and this arm is what says no. The suffix case is the dangerous one: it is exactly
    // the shape "<safe phase>: <tool output>" a future caller would reach for.
    const misses = SAFE_PHASES.flatMap((phase) => [
      ` ${phase}`, `${phase} `, `${phase}: connection refused`, `docker: ${phase}`,
      phase.toLowerCase(), `${phase}\n${phase}`,
    ]);
    expect(misses.length).toBe(SAFE_PHASES.length * 6);
    const store = openStore();

    for (const [index, miss] of misses.entries()) {
      const written = recordDeployReceipt(store, input({
        decisionId: `near-miss-${String(index)}`, refusal: refused(miss),
      }));
      expect(written.ok && written.receipt.refusal?.detail).toBe(REDACTED);
    }
  });

  it("redacts code-looking strings that are not members of the set", () => {
    // Guards against an implementation that admits "anything SHOUTING_CASE": these are shaped
    // exactly like the real literals and must still be refused.
    const impostors = [
      "DEPLOY_PROXY_BUSYY", "DEPLOY_PROXY_MISSING", "DEPLOY_CREDENTIAL_LEAKED",
      "MIGRATION_FAILED@DAEMON_INGRESS", "ENV_STORE_KEY_UNAVAILABLE@KEY", "DEPLOY_BUILD_FAILED",
      // The admitted migration composite with a FILENAME tail. Proves the one member that WAS
      // admitted did not turn its code and layer into a blanket prefix a caller could ride.
      "MIGRATION_TOOL_MISSING@DAEMON_INGRESS: 1700000000009-broken.js",
    ];
    expect(impostors.length).toBeGreaterThan(0);
    const store = openStore();

    for (const [index, impostor] of impostors.entries()) {
      const written = recordDeployReceipt(store, input({
        decisionId: `impostor-${String(index)}`, refusal: refused(impostor),
      }));
      expect(written.ok && written.receipt.refusal?.detail).toBe(REDACTED);
    }
  });
});

describe("declassification never launders a malformed receipt into a valid one", () => {
  it.each([
    ["a non-string detail", { code: DEPLOY_BUILD_FAILED, detail: 7, layer: DEPLOY_ENGINE_STAMP }],
    ["an extra refusal key", {
      code: DEPLOY_BUILD_FAILED, detail: "x", layer: DEPLOY_ENGINE_STAMP, note: "x",
    }],
    ["an unrostered code", { code: "DEPLOY_NOT_A_CODE", detail: "x", layer: DEPLOY_ENGINE_STAMP }],
    ["a foreign layer", { code: DEPLOY_BUILD_FAILED, detail: "x", layer: "DAEMON_INGRESS" }],
  ])("refuses DEPLOY_RECEIPT_INVALID for %s and commits nothing", (_name, refusal) => {
    const store = openStore();

    const written = recordDeployReceipt(store,
      input({ refusal: refusal as unknown as RecordDeployReceiptInput["refusal"] }));

    expect(written).toEqual({ code: "DEPLOY_RECEIPT_INVALID", ok: false });
    expect(readDeployLedger(store, PROJECT_ID).get(ENVIRONMENT)).toBeUndefined();
    expect(store.readEvents(deployAggregateId(PROJECT_ID, ENVIRONMENT))).toEqual([]);
  });

  it.each([
    ["a refusal AND an image digest", { imageDigest: IMAGE_DIGEST, refusal: refused(generated()) }],
    ["neither a refusal nor an image digest", { imageDigest: null, refusal: null }],
  ])("keeps the null-pairing discipline with %s", (_name, overrides) => {
    const store = openStore();

    const written = recordDeployReceipt(store, input(overrides));

    // Sanitising a refusal must not create an outcome the decoder would otherwise have refused:
    // the both-directions pair still answers first, from BOTH sides.
    expect(written).toEqual({ code: "DEPLOY_RECEIPT_INVALID", ok: false });
    expect(store.readEvents(deployAggregateId(PROJECT_ID, ENVIRONMENT))).toEqual([]);
  });
});

describe("the real deploy service cannot land a secret through ANY of its refusal paths", () => {
  it("redacts docker's version stderr", async () => {
    const value = generated();
    const store = openStore();
    // The OPAQUE carrier here on purpose: docker's `version` failure is the one path whose text a
    // reviewer is least likely to expect a credential in, and it has no syntax to match on.
    const deploy = service(store, { wrap: failVerb("version", value) });

    const report = await deploy();

    expect(report.outcome).toBe("REFUSED");
    expect(report.receipt?.refusal?.code).toBe(DEPLOY_DOCKER_UNAVAILABLE);
    expect(report.receipt?.refusal?.layer).toBe(DEPLOY_ENGINE_STAMP);
    expectRedacted(report.receipt?.refusal?.detail, value);
    for (const bytes of durableBytes(store)) expectAbsentFromBytes(bytes, value);
  });

  it.each([
    ["the image build", "build"],
    ["the candidate start", "start"],
    ["the image transfer", "transfer"],
    ["a returned migration refusal", "migration-returned"],
    ["a thrown migration code and layer", "migration-thrown"],
  ])("redacts %s", async (_name, path) => {
    const value = generated();
    const detail = `failed to solve: postgres://deployer:${value}@db.internal/app`;
    expect(detail.includes(value)).toBe(true);
    const store = openStore();
    const returnedRefusal: DeployMigrationPort = () =>
      Promise.resolve({ code: "MIGRATION_FAILED", detail, layer: "DAEMON_INGRESS", ok: false });
    // A THROWN migration carries only a code and a layer, so the secret is planted in BOTH: the
    // `code@layer` detail the engine composes from them is the leak this arm is about.
    const thrownRefusal: DeployMigrationPort = () => Promise.reject(
      Object.assign(new Error("migration refused"), { code: detail, layer: detail }));
    const byPath: Readonly<Record<string, ServiceOptions>> = {
      build: { double: { buildStderr: detail } },
      start: { wrap: failVerb("run", detail) },
      transfer: { double: { saveStderr: detail }, target: REMOTE },
      "migration-returned": { migrate: returnedRefusal },
      "migration-thrown": { migrate: thrownRefusal },
    };
    const options = byPath[path];
    expect(options === undefined).toBe(false);
    const deploy = service(store, options);

    const report = await deploy();

    expect(report.outcome).toBe("REFUSED");
    expect(report.receipt?.refusal?.code).toBe(DEPLOY_BUILD_FAILED);
    expect(report.receipt?.refusal?.layer).toBe(DEPLOY_ENGINE_STAMP);
    expectRedacted(report.receipt?.refusal?.detail, value);
    for (const bytes of durableBytes(store)) expectAbsentFromBytes(bytes, value);
    // The report's own top-level detail is the CODE, never the tool's words — asserted so a
    // future change that "helpfully" surfaced the raw line there would fail here.
    expect(report.detail.includes(value)).toBe(false);
  });

  it("redacts the target-missing detail, which names only an admitted environment", async () => {
    const store = openStore();
    const deployer = createDeployService({
      clock: () => DECIDED_AT, ports: {
        build: () => Promise.reject(new Error("unreachable")), docker: () => Promise.reject(new Error("unreachable")),
        releaseDecision: () => null, ssh: () => Promise.reject(new Error("unreachable")),
        target: () => null, transfer: () => Promise.reject(new Error("unreachable")),
      }, projectId: PROJECT_ID, store,
    });

    const report = await deployer.deploy({
      context: CONTEXT, decisionId: "decision-1", environment: ENVIRONMENT, sha: SHA,
    });

    expect(report.receipt?.refusal?.code).toBe(DEPLOY_TARGET_MISSING);
    expect(report.receipt?.refusal?.detail).toBe(REDACTED);
  });
});

describe("the redaction is DURABLE, and a replay does not undo it", () => {
  it("keeps the marker across a close and reopen, with the secret absent from the file", () => {
    const value = generated();
    const detail = `unauthorized: Authorization: Bearer ${value}`;
    expect(detail.includes(value)).toBe(true);
    const restartable = openRestartableStore();

    expect(recordDeployReceipt(restartable.store, input({ refusal: refused(detail) })).ok).toBe(true);
    const reopened = reopen(restartable);

    const current = readDeployLedger(reopened, PROJECT_ID).get(ENVIRONMENT)?.current;
    expect(current?.refusal?.code).toBe(DEPLOY_BUILD_FAILED);
    expect(current?.refusal?.layer).toBe(DEPLOY_ENGINE_STAMP);
    expectRedacted(current?.refusal?.detail, value);
    // THE FILE ITSELF, sidecars included: decision bytes, request bytes and event payloads all
    // live here, so a leak through any column that has no reader API is still caught.
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = `${restartable.path}${suffix}`;
      if (existsSync(path)) expectAbsentFromBytes(readFileSync(path), value);
    }
  });

  it("replays the SAME redacted receipt and writes no second row", () => {
    const value = generated();
    const store = openStore();
    const request = input({ refusal: refused(`postgres://deployer:${value}@db.internal/app`) });

    const first = recordDeployReceipt(store, request);
    const replay = recordDeployReceipt(store, request);

    expect(first.ok).toBe(true);
    expect(first.ok && first.replayed).toBe(false);
    expect(replay.ok).toBe(true);
    expect(replay.ok && replay.replayed).toBe(true);
    expect(replay.ok && replay.receipt.refusal?.code).toBe(DEPLOY_BUILD_FAILED);
    expect(replay.ok && replay.receipt.refusal?.layer).toBe(DEPLOY_ENGINE_STAMP);
    expectRedacted(replay.ok ? replay.receipt.refusal?.detail : undefined, value);
    expect(readDeployLedger(store, PROJECT_ID).get(ENVIRONMENT)?.receipts).toHaveLength(1);
    expect(store.readEvents(deployAggregateId(PROJECT_ID, ENVIRONMENT))).toHaveLength(1);
    for (const bytes of durableBytes(store)) expectAbsentFromBytes(bytes, value);
  });
});
