#!/usr/bin/env node
/**
 * The cross-host evidence collector and aggregator.
 *
 * Deliberately a `.mjs` and deliberately OUTSIDE the TypeScript import graph:
 * it calls the real `scripts/release/release-subject.mjs`, which is untyped, and
 * importing it from a `.ts` file under `tests/fault/tsconfig.json` raises
 * TS7016. The evidence protocol itself is imported from the typed modules, so no
 * canonical encoding, verification or aggregation rule is re-implemented here.
 *
 * `collect` runs ON the host and refuses at `CROSS_HOST_COLLECTOR` when the
 * machine it is running on cannot be shown to be the requested one. `aggregate`
 * runs anywhere, trusts no artifact name, and always writes its aggregate — a
 * refusal that produced no evidence would be indistinguishable from a job that
 * never ran.
 */

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectDoctorVersionReport } from "@moe/daemon";

import { buildReleaseSubject } from "../../../scripts/release/release-subject.mjs";
import {
  CROSS_HOST_CONSUMER_TASK_ID,
  CROSS_HOST_EXPECTED_CASE_COUNT,
  CROSS_HOST_HOST_SLOTS,
  CROSS_HOST_RECEIPT_VERSION,
  canonicalBytes,
  canonicalDigest,
  crossHostFailure,
  isCrossHostSlot,
  receiptFileName,
  scheduleUniverseOf,
  sealHostReceipt,
} from "./effect-evidence-contract.js";
import { aggregateFileName, aggregateHostReceipts } from "./effect-evidence-verify.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");

const FIXTURE_FILES = Object.freeze([
  "tests/fault/cross-host/effect-schedule-driver.ts",
  "tests/fault/cross-host/effect-boundary-facts.ts",
  "tests/fault/linux/effect-conformance.fault.ts",
  "tests/fault/macos/effect-conformance.fault.ts",
]);

const refuse = (/** @type {string} */ code, /** @type {string | null} */ slot, /** @type {string} */ message) =>
  crossHostFailure(code, "CROSS_HOST_COLLECTOR", slot, message);

function readArgs(/** @type {readonly string[]} */ argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token === "string" && token.startsWith("--")) {
      const next = argv[index + 1];
      flags[token.slice(2)] = next !== undefined && !next.startsWith("--") ? next : "true";
    }
  }
  return { mode: argv[0] ?? "", flags };
}

function digestOf(/** @type {string} */ relativePath) {
  return canonicalDigest({ path: relativePath, bytes: readFileSync(resolve(REPO_ROOT, relativePath), "utf8") });
}

function gitSource() {
  const run = (/** @type {readonly string[]} */ args) =>
    execFileSync("git", [...args], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  return { commitSha: run(["rev-parse", "--verify", "HEAD"]), objectFormat: run(["rev-parse", "--show-object-format"]) };
}

/**
 * Only source-bound, key-independent digests are retained. A container or
 * signature digest changes with the ephemeral verification key generated below,
 * so comparing one across two hosts would report a mismatch that says nothing
 * about the distribution.
 */
function distributionOf(/** @type {{commitSha: string, objectFormat: string}} */ source) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const subject = buildReleaseSubject({
    privateKey, signingKeyId: "cross-host-evidence",
    source: { objectFormat: source.objectFormat, sourceSha: source.commitSha }, sourceRoot: REPO_ROOT,
  });
  if (subject.ok !== true) {
    return null;
  }
  const components = subject.containers.map((container) => ({
    name: container.componentId,
    manifestDigest: canonicalDigest({
      componentId: container.componentId, componentKind: container.componentKind,
      assetDigests: [...container.assetDigests], sourceSha: source.commitSha,
    }),
    assetDigest: canonicalDigest([...container.assetDigests]),
  }));
  return {
    componentCount: subject.componentCount, components,
    aggregateDigest: canonicalDigest(components),
  };
}

function readSchedule(/** @type {string} */ path, /** @type {string} */ slot) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return refuse("CROSS_HOST_SCHEDULE_INCOMPLETE", slot, `the raw schedule at ${path} could not be read as JSON`);
  }
  if (
    parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.cases) ||
    parsed.cases.length !== CROSS_HOST_EXPECTED_CASE_COUNT || parsed.ok !== true
  ) {
    return refuse("CROSS_HOST_SCHEDULE_INCOMPLETE", slot, "the raw schedule does not carry an accepted 21-case run");
  }
  return parsed;
}

async function collect(/** @type {Record<string, string>} */ flags) {
  const slot = flags["slot"] ?? "";
  if (!isCrossHostSlot(slot)) {
    return refuse("CROSS_HOST_HOST_MISMATCH", null, `${slot || "<absent>"} is not one of ${CROSS_HOST_HOST_SLOTS.join(", ")}`);
  }
  const schedule = readSchedule(flags["schedule"] ?? "", slot);
  if (schedule.ok === false) {
    return schedule;
  }
  const report = await collectDoctorVersionReport();
  const observedOs = report.observed.platform.known ? report.observed.platform.value : null;
  if (observedOs !== slot || schedule.hostSlot !== slot || schedule.doctor.os !== slot) {
    return refuse(
      "CROSS_HOST_HOST_MISMATCH", slot,
      `the collecting host reports ${String(observedOs)} and the schedule claims ${String(schedule.hostSlot)}`,
    );
  }
  if (schedule.runtime.truthClass !== "PROVEN" || schedule.runtime.pinningMethod === "UNSUPPORTED") {
    return refuse("CROSS_HOST_RUNTIME_UNVERIFIABLE", slot, "the on-host run did not prove and pin its runtime closure");
  }
  const source = gitSource();
  const distribution = distributionOf(source);
  if (distribution === null) {
    return refuse("CROSS_HOST_DISTRIBUTION_MISMATCH", slot, "the distribution could not be rebuilt from this commit");
  }
  const cases = schedule.cases;
  const receipt = sealHostReceipt({
    receiptVersion: CROSS_HOST_RECEIPT_VERSION, hostSlot: slot, consumerTaskId: CROSS_HOST_CONSUMER_TASK_ID,
    source, distribution,
    doctor: {
      os: slot, arch: report.observed.arch.known ? report.observed.arch.value : "",
      nodeVersion: report.observed.node.known ? report.observed.node.value : "",
      pnpmVersion: report.observed.pnpm.known ? report.observed.pnpm.value : "",
      reportDigest: canonicalDigest(report),
    },
    kernel: { release: release() },
    runtime: { ...schedule.runtime },
    schedule: {
      scheduleDigest: canonicalDigest(scheduleUniverseOf(cases)),
      fixtureDigest: canonicalDigest(FIXTURE_FILES.map(digestOf)),
      configDigest: digestOf("tests/fault/vitest.config.ts"),
      workflowDigest: digestOf(".github/workflows/cross-host.yml"),
      lockfileDigest: digestOf("pnpm-lock.yaml"),
    },
    timestamps: { startedAt: schedule.startedAt, completedAt: schedule.completedAt },
    cases, caseDigest: canonicalDigest(cases),
  });
  const out = flags["out"] ?? "";
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, receiptFileName(receipt)), Buffer.from(canonicalBytes(receipt)));
  return { ok: true, hostSlot: slot, receiptDigest: receipt.receiptDigest, caseCount: cases.length };
}

function readSlotBytes(/** @type {string} */ root, /** @type {string} */ slot) {
  try {
    const directory = join(root, slot);
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => new Uint8Array(readFileSync(join(directory, name))));
  } catch {
    return [];
  }
}

function expectationFor(/** @type {Record<string, string>} */ flags) {
  const declared = flags["expect"];
  if (declared !== undefined && declared !== "true") {
    return JSON.parse(readFileSync(declared, "utf8"));
  }
  const source = gitSource();
  const distribution = distributionOf(source);
  return distribution === null ? null : { source, distribution };
}

function aggregate(/** @type {Record<string, string>} */ flags) {
  const expected = expectationFor(flags);
  if (expected === null) {
    return crossHostFailure(
      "CROSS_HOST_DISTRIBUTION_MISMATCH", "CROSS_HOST_AGGREGATOR", null,
      "the expected distribution could not be rebuilt from the checked-out commit",
    );
  }
  const root = flags["slots"] ?? "";
  const built = aggregateHostReceipts({
    expected,
    slots: Object.fromEntries(CROSS_HOST_HOST_SLOTS.map((slot) => [slot, readSlotBytes(root, slot)])),
  });
  const out = flags["out"] ?? "";
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, aggregateFileName(built)), Buffer.from(canonicalBytes(built)));
  return built;
}

async function main() {
  const { mode, flags } = readArgs(process.argv.slice(2));
  if (mode === "collect") {
    const result = await collect(flags);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.ok === true ? 0 : 2;
  }
  if (mode === "aggregate") {
    const result = aggregate(flags);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.ok === false) {
      return 2;
    }
    return flags["require-complete"] !== undefined && result.truthClass !== "PROVEN" ? 1 : 0;
  }
  process.stdout.write(
    `${JSON.stringify(refuse("CROSS_HOST_RECEIPT_MALFORMED", null, `unknown mode ${mode || "<absent>"}`))}\n`,
  );
  return 2;
}

process.exitCode = await main();
