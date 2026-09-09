import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { SqliteEventStore } from "@moe/store";

import { runEnvironmentEdge } from "../daemon-command-environment.js";
import { agentEnvironment } from "../orchestrator/agent-spawn-environment.js";
import { envExampleBytes } from
  "../repository/controlled-profile/controlled-profile-root-templates.js";
import { environmentValueFingerprint } from "./environment-contracts.js";
import { launchDelivery } from "./environment-launch-resolver.js";
import {
  ENVIRONMENT_COMMAND_KIND_SET, environmentAggregateId, readEnvironmentVariables,
} from "./environment-store.js";
import { PROJECT_ID, cleanUp, configFor, openFileStore } from "./environment-test-fixtures.js";

/**
 * THE CANARY OVER THE COMPOSED FEATURE - the surfaces BETWEEN the three rows that built it.
 *
 * WHY THIS FILE EXISTS ALONGSIDE THE TWO CANARIES THAT ALREADY PASS. `environment-canary.test.ts`
 * writes through `setEnvironmentVariable` and sweeps the store, the stream, the reads and the
 * receipts. `environment-delivery-canary.test.ts` starts from a sealed write and finishes in a
 * spawned child. Neither one crosses the COMMAND EDGE on its way to a spawn, so the composition
 * an operator actually drives - `runEnvironmentEdge` -> store -> `launchDelivery` -> the seat
 * allowlist -> a real process - is covered by no single arm. Each row proved its own half; a
 * value that leaked only where two halves meet would pass both suites.
 *
 * THE ALLOWLIST IS ASSERTED ON BOTH OF ITS MECHANISMS, SEPARATELY. `agentEnvironment` drops an
 * unrostered host name by the roster test at :67 and drops ANY `MOE_`-prefixed host name by the
 * explicit scrub at :66. They are different lines guarding different hazards, and an assertion
 * that only watched one would stay green while the other was deleted. The third arm - that a
 * DELIVERED `MOE_`-prefixed name still arrives - is what makes the pair a statement about the
 * source loop rather than about the string "MOE_": delivery is applied after that loop
 * (agent-spawn-environment.ts:105), so the scrub cannot reach it.
 *
 * SEARCHES ARE OVER BYTES. A plaintext inside a serialised blob is invisible to a parsed
 * assertion and perfectly visible to whoever opens the file.
 */

/** VERIFIER's environment: PURPOSE_ENVIRONMENTS maps VERIFIER -> "verify"
 *  (environment-launch-resolver.ts:69). The DoD names a spawned VERIFIER, so the write goes
 *  where the verifier will actually read, not where it reads nothing. */
const VERIFY = "verify";
const scratch: string[] = [];

afterEach(cleanUp);
afterAll(() => {
  while (scratch.length > 0) {
    const directory = scratch.pop();
    if (directory === undefined) continue;
    try { rmSync(directory, { force: true, recursive: true }); } catch { /* held handle */ }
  }
});

function storeBytes(directory: string, databasePath: string): Buffer {
  const prefix = basename(databasePath);
  const files = readdirSync(directory).filter((entry) => entry.startsWith(prefix));
  expect(files.length).toBeGreaterThan(0);
  return Buffer.concat(files.map((entry) => readFileSync(join(directory, entry))));
}

function streamBytes(store: SqliteEventStore): Buffer {
  const events = store.readEvents(environmentAggregateId(PROJECT_ID, VERIFY));
  expect(events.length).toBeGreaterThan(0);
  return Buffer.concat(events.map((event) => Buffer.from(event.payload)));
}

function receiptBytes(store: SqliteEventStore): Buffer {
  const events = store.readEvents(environmentAggregateId(PROJECT_ID, VERIFY));
  const receipts = [...new Set(events.map((event) => event.commandId))]
    .map((commandId) => store.getCommandReceipt(commandId));
  expect(receipts.length).toBeGreaterThan(0);
  return Buffer.from(JSON.stringify(receipts), "utf8");
}

/** The child writes DIGESTS, never the value: a child that printed the plaintext to prove it
 *  arrived would put it in the very transcript this probe sweeps. */
const CHILD = `
const { createHash } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const digest = (name) => {
  const value = process.env[name];
  return value === undefined ? "ABSENT"
    : createHash("sha256").update(value, "utf8").digest("hex");
};
writeFileSync(process.env["ROLLUP_REPORT_PATH"], JSON.stringify({
  moeName: digest(process.env["ROLLUP_NAME_A"]),
  plainName: digest(process.env["ROLLUP_NAME_B"]),
  hostOnly: digest("ROLLUP_HOST_ONLY"),
  moeHost: digest("MOE_ROLLUP_HOST_ONLY"),
  keys: Object.keys(process.env).sort(),
}), "utf8");
`;

describe("ROLL-UP CANARY over the composed feature", () => {
  it("drives BOTH canary names through the REAL command edge, reaches a REAL child, and leaks the plaintext onto NO surface", () => {
    const tail = randomBytes(16).toString("hex");
    // NAME_A is the DoD's literal `MOE_CANARY_<random>` shape. NAME_B is the non-MOE control:
    // if the MOE_ prefix were dropped anywhere on the delivery path, A would be absent from the
    // child while B arrived, and a single-name probe could not tell that apart from a clean run.
    const nameA = `MOE_CANARY_${tail.toUpperCase()}`;
    const nameB = `ROLLUP_CANARY_${tail.toUpperCase()}`;
    const valueA = `rollup-plaintext-A-${randomBytes(24).toString("hex")}`;
    const valueB = `rollup-plaintext-B-${randomBytes(24).toString("hex")}`;
    const hostOnly = `rollup-host-only-${randomBytes(24).toString("hex")}`;

    const backing = openFileStore("rollup");
    const config = configFor(backing.store);

    const decisions = [[nameA, valueA], [nameB, valueB]].map(([name, value]) => (
      runEnvironmentEdge({
        ...config,
        envelope: {
          commandId: `cmd-rollup-${name}-${tail}`,
          payload: { environment: VERIFY, name, value },
        },
        kind: ENVIRONMENT_COMMAND_KIND_SET,
      })
    ));
    expect(decisions.map((decision) => decision.resultCode))
      .toEqual(["ENVIRONMENT_VARIABLE_SET", "ENVIRONMENT_VARIABLE_SET"]);

    const read = readEnvironmentVariables(config, VERIFY);
    if (!read.ok) throw new Error("expected the roll-up read to be ok");
    const byName = new Map(read.variables.map((variable) => [variable.name, variable]));
    expect(byName.get(nameA)?.fingerprintSha256).toBe(environmentValueFingerprint(valueA));
    expect(byName.get(nameB)?.fingerprintSha256).toBe(environmentValueFingerprint(valueB));

    // THE SPAWN. Production composition: resolve delivery for a VERIFIER, then build the seat
    // environment through the same allowlist every seat gets.
    const delivered = launchDelivery(config, "VERIFIER");
    expect(delivered).toBeDefined();
    const reportDirectory = mkdtempSync(join(tmpdir(), "moe-rollup-"));
    scratch.push(reportDirectory);
    const reportPath = join(reportDirectory, "report.json");
    const seat = agentEnvironment(
      { ...process.env, MOE_ROLLUP_HOST_ONLY: hostOnly, ROLLUP_HOST_ONLY: hostOnly }, delivered,
    );
    const child = spawnSync(process.execPath, ["-e", CHILD], {
      encoding: "utf8",
      env: {
        ...seat,
        ROLLUP_NAME_A: nameA, ROLLUP_NAME_B: nameB, ROLLUP_REPORT_PATH: reportPath,
      },
    });
    expect(`spawn status ${child.status}: ${child.stderr}`).toBe("spawn status 0: ");
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      hostOnly: string; keys: string[]; moeHost: string; moeName: string; plainName: string;
    };

    // DELIVERY HAPPENED: the child holds the exact bytes for both names.
    expect(report.plainName).toBe(createHash("sha256").update(valueB, "utf8").digest("hex"));
    expect(report.moeName).toBe(createHash("sha256").update(valueA, "utf8").digest("hex"));
    // THE ALLOWLIST WAS NOT WIDENED, on BOTH of its two independent mechanisms. An unrostered
    // host name is dropped by the roster (`hostOnly`); a `MOE_`-prefixed host name is dropped by
    // the explicit scrub at agent-spawn-environment.ts:66 (`moeHost`). Asserting only one cannot
    // tell a working scrub from a name that was never rostered in the first place.
    expect(report.hostOnly).toBe("ABSENT");
    expect(report.moeHost).toBe("ABSENT");
    expect(report.keys).not.toContain("ROLLUP_HOST_ONLY");
    expect(report.keys).not.toContain("MOE_ROLLUP_HOST_ONLY");
    // ...and the delivered MOE_-prefixed name DID arrive, which is what makes the two lines above
    // a statement about the SOURCE loop rather than about the `MOE_` string. Delivery is applied
    // after the loop (:105), so the scrub cannot reach it.
    expect(report.keys).toContain(nameA);

    // `.env.example`, the artefact that leaves the machine: names only.
    const envExample = envExampleBytes([nameA, nameB]);

    const surfaces: readonly (readonly [string, Buffer])[] = [
      [".env.example", Buffer.from(envExample, "utf8")],
      ["child stdout", Buffer.from(child.stdout, "utf8")],
      ["child stderr", Buffer.from(child.stderr, "utf8")],
      ["child report", readFileSync(reportPath)],
      ["command decisions", Buffer.from(JSON.stringify(decisions), "utf8")],
      ["event stream", streamBytes(backing.store)],
      ["read response", Buffer.from(JSON.stringify(read), "utf8")],
      ["receipts", receiptBytes(backing.store)],
      ["store file bytes", storeBytes(backing.directory, backing.databasePath)],
    ];
    for (const [label, bytes] of surfaces) {
      for (const [which, secret] of [["A", valueA], ["B", valueB]] as const) {
        expect(`${label}/${which}: ${bytes.includes(secret)}`).toBe(`${label}/${which}: false`);
      }
    }

    // ANTI-VACUITY: the sweep can find a plaintext when one is there, and the fingerprint IS
    // present where the value is not — absence must not come from an absent record.
    const planted = join(backing.directory, "planted.txt");
    writeFileSync(planted, `noise ${valueA} noise`, "utf8");
    expect(storeBytes(backing.directory, backing.databasePath).includes(valueA)).toBe(false);
    expect(readFileSync(planted).includes(valueA)).toBe(true);
    expect(storeBytes(backing.directory, backing.databasePath)
      .includes(environmentValueFingerprint(valueA))).toBe(true);
    expect(envExample).toContain(`${nameA}=\n`);
    expect(envExample).toContain(`${nameB}=\n`);
  });

  it("spawns a CODING SEAT and a project with NO variables exactly as it did before this feature existed", () => {
    const backing = openFileStore("rollup-empty");
    const config = configFor(backing.store);
    const source: NodeJS.ProcessEnv = { ...process.env, ROLLUP_HOST_ONLY: "x" };

    // (1) A coding seat is withheld BY TYPE, before the store is touched.
    expect(launchDelivery(config, "CODING_SEAT")).toBeUndefined();
    // (2) A project with nothing set resolves to nothing, on a purpose that DOES deliver.
    expect(launchDelivery(config, "VERIFIER")).toBeUndefined();
    // (3) So the environment is byte-identical to the pre-feature construction. Compared as
    // SORTED ENTRIES, not by reference: `deliverEnvironment` returns its argument by reference
    // when there is nothing to deliver, so `toBe` would pass on identity and prove nothing about
    // the bytes a child would see.
    const before = Object.entries(agentEnvironment(source)).sort();
    const after = Object.entries(
      agentEnvironment(source, launchDelivery(config, "VERIFIER")),
    ).sort();
    expect(after).toEqual(before);
    expect(before.length).toBeGreaterThan(0);
  });
});
