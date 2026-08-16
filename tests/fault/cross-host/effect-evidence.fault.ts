/**
 * Hostile contract suite for the cross-host effect-evidence protocol.
 *
 * AUTHORITY: none about any host. Every receipt built in this file is a
 * FIXTURE — synthesized on the machine running the suite — so nothing here may
 * ever be read as Linux or macOS proof. What is tested is the integrity of the
 * protocol itself: that a receipt whose bindings were tampered with is refused
 * with an exact code, layer and host slot, and that a refusal never degrades
 * into a silent pass.
 *
 * Every refusal assertion pins the stable reason code AND the refusing layer,
 * because two layers can answer here (`CROSS_HOST_COLLECTOR` refuses to emit,
 * `CROSS_HOST_AGGREGATOR` refuses to accept) and "it failed" would not say
 * which. Every generated sweep asserts its own cardinality, because a mutation
 * generator that produced nothing would otherwise pass while testing nothing.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  CROSS_HOST_AGGREGATE_VERSION,
  CROSS_HOST_CONSUMER_TASK_ID,
  CROSS_HOST_ERROR_CODES,
  CROSS_HOST_EXPECTED_CASE_COUNT,
  CROSS_HOST_HOST_SLOTS,
  CROSS_HOST_LAYERS,
  CROSS_HOST_RECEIPT_VERSION,
  canonicalBytes,
  canonicalDigest,
  receiptFileName,
  scheduleUniverseOf,
  sealHostReceipt,
  type CrossHostExpectation,
  type CrossHostReceipt,
  type CrossHostReceiptBody,
  type CrossHostSlot,
} from "./effect-evidence-contract.js";
import { aggregateHostReceipts, verifyHostReceipt } from "./effect-evidence-verify.js";
import { CROSS_HOST_SCHEDULES, crossHostCaseUniverse } from "./effect-schedule-driver.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "cross-host-evidence.mjs");

const TEMP_ROOTS: string[] = [];

function tempRoot(label: string): string {
  const created = mkdtempSync(join(tmpdir(), `moe-xh-${label}-`));
  TEMP_ROOTS.push(created);
  return created;
}

afterAll(() => {
  for (const root of TEMP_ROOTS) {
    rmSync(root, { recursive: true, force: true });
  }
});

const EXPECTED: CrossHostExpectation = Object.freeze({
  source: Object.freeze({ commitSha: "9".repeat(40), objectFormat: "sha1" }),
  distribution: Object.freeze({
    componentCount: 2,
    components: Object.freeze([
      Object.freeze({ name: "alpha", manifestDigest: "a1".repeat(32), assetDigest: "a2".repeat(32) }),
      Object.freeze({ name: "beta", manifestDigest: "b1".repeat(32), assetDigest: "b2".repeat(32) }),
    ]),
    aggregateDigest: "c3".repeat(32),
  }),
});

/** A fixture case set that is exactly the production 7x3 universe, by construction. */
function fixtureCases(): readonly Record<string, unknown>[] {
  return crossHostCaseUniverse().map((entry, index) => ({
    boundary: entry.boundary,
    schedule: entry.schedule,
    truthClass: "UNKNOWN",
    code: "PLATFORM_FACT_ABSENT",
    layer: "PLATFORM_LINUX",
    launchedPid: index === 0 ? null : 1000 + index,
    elapsedMs: index,
  }));
}

function fixtureReceipt(slot: CrossHostSlot): CrossHostReceipt {
  const cases = fixtureCases();
  return sealHostReceipt({
    receiptVersion: CROSS_HOST_RECEIPT_VERSION,
    hostSlot: slot,
    consumerTaskId: CROSS_HOST_CONSUMER_TASK_ID,
    source: EXPECTED.source,
    distribution: EXPECTED.distribution,
    doctor: {
      os: slot,
      arch: "x64",
      nodeVersion: "v24.16.0",
      pnpmVersion: "11.0.8",
      reportDigest: "d4".repeat(32),
    },
    kernel: { release: slot === "linux" ? "6.11.0-1018-azure" : "24.6.0" },
    runtime: {
      closureKind: "EXECUTABLE",
      pinningMethod: "CONTENT_ADDRESSED_COPY",
      observationDigest: "e5".repeat(32),
      truthClass: "PROVEN",
    },
    schedule: {
      scheduleDigest: canonicalDigest(scheduleUniverseOf(cases)),
      fixtureDigest: "f6".repeat(32),
      configDigest: "07".repeat(32),
      workflowDigest: "18".repeat(32),
      lockfileDigest: "29".repeat(32),
    },
    timestamps: { startedAt: "2026-08-16T00:00:00.000Z", completedAt: "2026-08-16T00:01:00.000Z" },
    cases,
    caseDigest: canonicalDigest(cases),
  });
}

function decode(receipt: CrossHostReceipt): Record<string, unknown> {
  return JSON.parse(Buffer.from(canonicalBytes(receipt)).toString("utf8")) as Record<string, unknown>;
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function refusal(result: ReturnType<typeof verifyHostReceipt>) {
  if (result.ok) {
    throw new Error(`expected a refusal, received a verified receipt ${result.receipt.receiptDigest}`);
  }
  return result;
}

/**
 * One mutation of a sealed receipt, with the exact refusal it must produce.
 *
 * Every mutation except the self-digest case is RE-SEALED through the production
 * sealing function before verification, so each one is the forgery a real
 * attacker would present rather than a receipt that merely fails its checksum.
 * A sweep that skipped resealing would prove only that the digest works.
 */
interface Mutation {
  readonly label: string;
  readonly code: string;
  readonly reseal?: false;
  readonly mutate: (body: Record<string, unknown>) => void;
}

function mutations(): readonly Mutation[] {
  const swap = (key: string, value: unknown): Mutation["mutate"] => (body) => {
    body[key] = value;
  };
  const inner = (key: string, field: string, value: unknown): Mutation["mutate"] => (body) => {
    body[key] = { ...(body[key] as Record<string, unknown>), [field]: value };
  };
  return Object.freeze([
    { label: "extra key", code: "CROSS_HOST_RECEIPT_MALFORMED", mutate: swap("extra", 1) },
    { label: "missing key", code: "CROSS_HOST_RECEIPT_MALFORMED", mutate: (body) => void delete body["kernel"] },
    { label: "host spoof", code: "CROSS_HOST_HOST_MISMATCH", mutate: inner("doctor", "os", "darwin") },
    { label: "doctor arch", code: "CROSS_HOST_HOST_UNVERIFIABLE", mutate: inner("doctor", "arch", "") },
    { label: "kernel absent", code: "CROSS_HOST_HOST_UNVERIFIABLE", mutate: inner("kernel", "release", "") },
    { label: "wrong source", code: "CROSS_HOST_SOURCE_MISMATCH", mutate: inner("source", "commitSha", "0".repeat(40)) },
    {
      label: "manifest digest", code: "CROSS_HOST_DISTRIBUTION_MISMATCH",
      mutate: (body) => {
        const distribution = body["distribution"] as Record<string, unknown>;
        const components = (distribution["components"] as Record<string, unknown>[]).map((entry) => ({ ...entry }));
        components[0]!["manifestDigest"] = "00".repeat(32);
        body["distribution"] = { ...distribution, components };
      },
    },
    {
      label: "asset digest", code: "CROSS_HOST_DISTRIBUTION_MISMATCH",
      mutate: (body) => {
        const distribution = body["distribution"] as Record<string, unknown>;
        const components = (distribution["components"] as Record<string, unknown>[]).map((entry) => ({ ...entry }));
        components[1]!["assetDigest"] = "00".repeat(32);
        body["distribution"] = { ...distribution, components };
      },
    },
    { label: "doctor closure", code: "CROSS_HOST_RUNTIME_UNVERIFIABLE", mutate: inner("runtime", "truthClass", "UNKNOWN") },
    { label: "runtime closure", code: "CROSS_HOST_RUNTIME_UNVERIFIABLE", mutate: inner("runtime", "pinningMethod", "UNSUPPORTED") },
    {
      label: "schedule universe", code: "CROSS_HOST_SCHEDULE_INCOMPLETE",
      mutate: (body) => { body["cases"] = (body["cases"] as unknown[]).slice(1); },
    },
    {
      label: "one raw case", code: "CROSS_HOST_RAW_RECEIPT_MISMATCH",
      mutate: (body) => {
        const cases = (body["cases"] as Record<string, unknown>[]).map((entry) => ({ ...entry }));
        cases[3]!["truthClass"] = "PROVEN";
        body["cases"] = cases;
      },
    },
    {
      label: "schedule digest", code: "CROSS_HOST_SCHEDULE_DIGEST_MISMATCH",
      mutate: inner("schedule", "scheduleDigest", "00".repeat(32)),
    },
    {
      label: "self digest", code: "CROSS_HOST_RECEIPT_DIGEST_MISMATCH",
      reseal: false, mutate: swap("receiptDigest", "00".repeat(32)),
    },
  ]);
}

describe("the cross-host evidence protocol refuses every tampered binding", () => {
  it("pins the frozen vocabulary as exact tuples", () => {
    expect([...CROSS_HOST_HOST_SLOTS]).toEqual(["linux", "darwin"]);
    expect([...CROSS_HOST_LAYERS]).toEqual(["CROSS_HOST_COLLECTOR", "CROSS_HOST_AGGREGATOR"]);
    expect(CROSS_HOST_ERROR_CODES).toHaveLength(12);
    expect(new Set(CROSS_HOST_ERROR_CODES).size).toBe(12);
    expect(CROSS_HOST_EXPECTED_CASE_COUNT).toBe(21);
    expect(CROSS_HOST_SCHEDULES).toHaveLength(3);
    expect(crossHostCaseUniverse()).toHaveLength(CROSS_HOST_EXPECTED_CASE_COUNT);
  });

  it("accepts its own sealed fixture for the matching slot only", () => {
    const receipt = fixtureReceipt("linux");
    const bytes = canonicalBytes(receipt);
    const accepted = verifyHostReceipt("linux", bytes, EXPECTED);
    expect(accepted.ok).toBe(true);
    expect(receiptFileName(receipt)).toBe(`receipt-${receipt.receiptDigest}.json`);

    const wrongSlot = refusal(verifyHostReceipt("darwin", bytes, EXPECTED));
    expect(wrongSlot.code).toBe("CROSS_HOST_HOST_MISMATCH");
    expect(wrongSlot.layer).toBe("CROSS_HOST_AGGREGATOR");
    expect(wrongSlot.hostSlot).toBe("darwin");
  });

  it("refuses every generated mutation with its exact code, layer and slot", () => {
    const cases = mutations();
    // The sweep must have produced cases; a generator that produced none would pass.
    expect(cases.length).toBeGreaterThan(0);
    expect(cases).toHaveLength(14);

    let refused = 0;
    for (const mutation of cases) {
      const body = decode(fixtureReceipt("linux"));
      mutation.mutate(body);
      if (mutation.reseal !== false) {
        delete body["receiptDigest"];
        Object.assign(body, sealHostReceipt(body as unknown as CrossHostReceiptBody));
      }
      const result = refusal(verifyHostReceipt("linux", encode(body), EXPECTED));
      expect({ label: mutation.label, code: result.code }).toEqual({
        label: mutation.label,
        code: mutation.code,
      });
      expect(result.layer).toBe("CROSS_HOST_AGGREGATOR");
      expect(result.hostSlot).toBe("linux");
      refused += 1;
    }
    expect(refused).toBe(cases.length);
  });

  it("refuses bytes that are not a JSON object at all", () => {
    const notJson = refusal(verifyHostReceipt("linux", new TextEncoder().encode("{"), EXPECTED));
    expect(notJson.code).toBe("CROSS_HOST_RECEIPT_MALFORMED");
    expect(notJson.layer).toBe("CROSS_HOST_AGGREGATOR");
  });
});

describe("aggregation trusts no caller-selected host claim", () => {
  it("reports one PROVEN row per verified slot and never trusts the file name", () => {
    const aggregate = aggregateHostReceipts({
      expected: EXPECTED,
      slots: {
        linux: [canonicalBytes(fixtureReceipt("linux"))],
        darwin: [canonicalBytes(fixtureReceipt("darwin"))],
      },
    });
    expect(aggregate.aggregateVersion).toBe(CROSS_HOST_AGGREGATE_VERSION);
    expect(aggregate.rows).toHaveLength(2);
    expect(aggregate.rows.map((row) => row.hostSlot)).toEqual(["linux", "darwin"]);
    expect(aggregate.rows.map((row) => row.truthClass)).toEqual(["PROVEN", "PROVEN"]);
    expect(aggregate.truthClass).toBe("PROVEN");
    expect(aggregate.consumerTaskId).toBe(CROSS_HOST_CONSUMER_TASK_ID);
  });

  it("leaves only the failing slot UNKNOWN and keeps the other slot's valid row", () => {
    const missing = aggregateHostReceipts({
      expected: EXPECTED,
      slots: { linux: [canonicalBytes(fixtureReceipt("linux"))], darwin: [] },
    });
    expect(missing.rows[0]?.truthClass).toBe("PROVEN");
    expect(missing.rows[1]?.truthClass).toBe("UNKNOWN");
    expect(missing.rows[1]?.failure?.code).toBe("CROSS_HOST_RECEIPT_MISSING");
    expect(missing.rows[1]?.failure?.layer).toBe("CROSS_HOST_AGGREGATOR");
    expect(missing.rows[1]?.failure?.hostSlot).toBe("darwin");
    expect(missing.truthClass).toBe("UNKNOWN");

    const duplicate = aggregateHostReceipts({
      expected: EXPECTED,
      slots: {
        linux: [canonicalBytes(fixtureReceipt("linux")), canonicalBytes(fixtureReceipt("linux"))],
        darwin: [canonicalBytes(fixtureReceipt("darwin"))],
      },
    });
    expect(duplicate.rows[0]?.failure?.code).toBe("CROSS_HOST_RECEIPT_DUPLICATE");
    expect(duplicate.rows[0]?.truthClass).toBe("UNKNOWN");
    expect(duplicate.rows[1]?.truthClass).toBe("PROVEN");
  });

  it("refuses a receipt filed into the wrong slot directory", () => {
    const crossFiled = aggregateHostReceipts({
      expected: EXPECTED,
      slots: { linux: [canonicalBytes(fixtureReceipt("darwin"))], darwin: [] },
    });
    expect(crossFiled.rows[0]?.failure?.code).toBe("CROSS_HOST_HOST_MISMATCH");
    expect(crossFiled.rows[0]?.failure?.hostSlot).toBe("linux");
  });
});

describe("the collector and aggregator CLI answer with structured refusals", () => {
  const runCli = (args: readonly string[]): { status: number; stdout: string } => {
    try {
      const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
      return { status: 0, stdout };
    } catch (error) {
      const failed = error as { status?: number; stdout?: string };
      return { status: failed.status ?? -1, stdout: failed.stdout ?? "" };
    }
  };

  it("refuses an unreadable schedule path with an exact code instead of throwing", () => {
    const root = tempRoot("cli-bad");
    const result = runCli(["collect", "--slot", "linux", "--schedule", join(root, "absent.json"), "--out", root]);
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: "CROSS_HOST_SCHEDULE_INCOMPLETE",
      layer: "CROSS_HOST_COLLECTOR",
    });
  });

  it("refuses an unknown slot name at the collector layer", () => {
    const root = tempRoot("cli-slot");
    const result = runCli(["collect", "--slot", "plan9", "--schedule", join(root, "x.json"), "--out", root]);
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: "CROSS_HOST_HOST_MISMATCH",
      layer: "CROSS_HOST_COLLECTOR",
    });
  });

  it("always writes an aggregate and exits nonzero under --require-complete when a slot is empty", () => {
    const root = tempRoot("cli-agg");
    for (const slot of CROSS_HOST_HOST_SLOTS) {
      mkdirSync(join(root, slot), { recursive: true });
    }
    writeFileSync(
      join(root, "linux", "receipt.json"),
      Buffer.from(canonicalBytes(fixtureReceipt("linux"))),
    );
    const outDir = join(root, "out");
    const result = runCli([
      "aggregate",
      "--slots",
      root,
      "--out",
      outDir,
      "--require-complete",
      "--expect",
      writeExpectation(root),
    ]);
    expect(result.status).not.toBe(0);
    const written = readdirSync(outDir);
    expect(written.length).toBe(1);
    const aggregate = JSON.parse(readFileSync(join(outDir, written[0]!), "utf8")) as {
      rows: { hostSlot: string; truthClass: string; failure: { code: string } | null }[];
      truthClass: string;
    };
    expect(aggregate.truthClass).toBe("UNKNOWN");
    expect(aggregate.rows[0]?.truthClass).toBe("PROVEN");
    expect(aggregate.rows[1]?.failure?.code).toBe("CROSS_HOST_RECEIPT_MISSING");
  });

  function writeExpectation(root: string): string {
    const path = join(root, "expectation.json");
    writeFileSync(path, JSON.stringify(EXPECTED));
    return path;
  }
});
