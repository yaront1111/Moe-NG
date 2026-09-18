import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDiagnosticEmitter } from "@moe/contracts";
import type { DiagnosticRecord } from "@moe/contracts";
import { DurableStoreError } from "@moe/store";
import { afterEach, expect, it } from "vitest";

import { COMMAND_STORE_FAULT } from "./command-store-fault-report.js";
import { createStoreDependencies } from "./daemon-store-dependencies.js";

/**
 * The store-fault observer reached through the SHIPPED composition: `createStoreDependencies`
 * takes a diagnostics emitter, hands the reporter to the command ports, and the decision port
 * the transports dispatch through reports a commit that failed on the durable store. A port
 * suite alone would pass through a composition that never threaded the emitter.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

it("reports a store fault under a dispatched commit as COMMAND_STORE_FAULT, beside the 503 frame", () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-store-fault-"));
  const records: DiagnosticRecord[] = [];
  const provider = createStoreDependencies({
    clock: () => "2026-09-18T00:00:00.000Z",
    credential: "operator-store-fault-credential",
    diagnostics: createDiagnosticEmitter({
      clock: () => "2026-09-18T00:00:00.000Z",
      component: "command",
      sink: { emit: (record) => { records.push(record); } },
    }),
    principalId: "operator-local",
    projectId: "project-store-fault",
    storePath: join(directory, "store.db"),
  });
  cleanups.push(() => {
    provider.close();
    rmSync(directory, { force: true, recursive: true });
  });

  const result = provider.provide().decisions.decide(
    { commandId: "cmd-store-fault-1", principalId: "operator-local", projectId: "project-store-fault" },
    "digest",
    () => { throw new DurableStoreError("PROJECTION_APPLY_FAILED", "goals projection refused the row"); },
  );

  expect(result).toMatchObject({
    outcome: "REFUSED",
    refusal: { code: "PROJECTION_APPLY_FAILED", httpStatus: 503, layer: "DURABLE_STORE" },
  });
  expect(records.map((record) => record.event)).toEqual([COMMAND_STORE_FAULT]);
  expect(records[0]).toMatchObject({
    correlation: "cmd-store-fault-1",
    fields: {
      code: "PROJECTION_APPLY_FAILED",
      commandId: "cmd-store-fault-1",
      projectId: "project-store-fault",
      thrownName: "DurableStoreError",
    },
    level: "error",
  });
});

it("stays silent, and answers the same refusal, when no diagnostics emitter is composed", () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-store-fault-silent-"));
  const provider = createStoreDependencies({
    clock: () => "2026-09-18T00:00:00.000Z",
    credential: "operator-store-fault-credential",
    principalId: "operator-local",
    projectId: "project-store-fault",
    storePath: join(directory, "store.db"),
  });
  cleanups.push(() => {
    provider.close();
    rmSync(directory, { force: true, recursive: true });
  });

  const result = provider.provide().decisions.decide(
    { commandId: "cmd-store-fault-2", principalId: "operator-local", projectId: "project-store-fault" },
    "digest",
    () => { throw new DurableStoreError("OUTCOME_UNKNOWN", "database is locked"); },
  );
  expect(result).toMatchObject({ outcome: "REFUSED", refusal: { code: "OUTCOME_UNKNOWN", httpStatus: 503 } });
});
