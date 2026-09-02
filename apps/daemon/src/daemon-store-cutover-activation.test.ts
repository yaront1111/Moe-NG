import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import {
  PROJECT_ID, SOURCE_COMMIT, bindingOf, counts, seedDurableGenerations, seedToActivateApproved,
  writeLiveQuiesceEvidence,
} from "./cutover/cutover-activate-test-fixtures.js";
import { deriveCutoverAttemptAggregateId } from "./cutover/cutover-attempt-contracts.js";
import { readCutoverGenerationSnapshot } from "./cutover/cutover-generation-snapshot.js";
import type { CutoverGenerationPorts } from "./cutover/cutover-generation-snapshot.js";
import { admitV1AuthoritativeCommand } from "./cutover/cutover-v2-authority.js";
import {
  V2_READINESS_EVIDENCE_KINDS, writeV2ReadinessManifest,
} from "./cutover/v2-readiness-manifest-writer.js";
import type { V2ReadinessEvidenceBytes } from "./cutover/v2-readiness-manifest-writer.js";
import { CUTOVER_EVIDENCE_ROOT_ENV_KEY } from "./daemon-store-cutover-wiring.js";
import { createStoreDependencies, readStoreDependencyEnv } from "./daemon-store-dependencies.js";
import { handleAsyncCommandRequest } from "./http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";

/**
 * THE PRODUCTION PATH TO A MARKER. Every earlier "after `/2` is authoritative" arm commits
 * the marker straight into the store, because the shipped composition never wired the
 * activation's evidence root and `cutover.activate` refused CUTOVER_ACTIVATE_UNCONFIGURED
 * on every daemon an operator could actually start. Here the SHIPPED provider is composed
 * with `cutoverEvidenceRoot`, the store is carried to ACTIVATE_APPROVED through the
 * production reducer and approval writer, the readiness manifest is written by the
 * production writer, and `cutover.activate` is dispatched through the same adapter the
 * listener serves. The receipt is the plane reader's answer afterwards.
 */
const CREDENTIAL = "cutover-activation-operator-credential";
const CLOCK = (): string => "2026-09-02T12:00:00.000Z";

interface World {
  readonly provider: ReturnType<typeof createStoreDependencies>;
  readonly store: SqliteEventStore;
  readonly storeRoot: string;
}
const closers: (() => void)[] = [];

function world(label: string, withEvidenceRoot: boolean): World {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `moe-cutover-activation-${label}-`)));
  const storeRoot = join(directory, "root");
  mkdirSync(storeRoot, { recursive: true });
  writeLiveQuiesceEvidence(storeRoot);
  const storePath = join(directory, "store.db");
  const provider = createStoreDependencies({
    clock: CLOCK, credential: CREDENTIAL, principalId: "operator-local", projectId: PROJECT_ID,
    storePath, ...(withEvidenceRoot ? { cutoverEvidenceRoot: storeRoot } : {}),
  });
  const store = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  closers.push(() => {
    store.close();
    provider.close();
    rmSync(directory, { force: true, recursive: true });
  });
  return { provider, store, storeRoot };
}

afterAll(() => { for (const close of closers) close(); });

const encoder = new TextEncoder();

/** ACTIVATE_APPROVED plus a written readiness manifest, all through production writers. */
function seedToReadyForActivation(opened: World): unknown {
  seedDurableGenerations(opened.store);
  const ports: CutoverGenerationPorts = {
    config: { storeRoot: opened.storeRoot },
    readFileText: (path: string) => readFileSync(path, "utf8"),
    store: opened.store,
  };
  const snapshot = readCutoverGenerationSnapshot(ports, { projectId: PROJECT_ID });
  if (!snapshot.ok) throw new Error(`snapshot refused ${snapshot.code}`);
  const record = bindingOf(snapshot.generations);
  seedToActivateApproved(opened.store, record);
  const evidence = Object.fromEntries(V2_READINESS_EVIDENCE_KINDS.map((kind) =>
    [kind, encoder.encode(`${kind} evidence bytes`)])) as V2ReadinessEvidenceBytes;
  const written = writeV2ReadinessManifest(
    { clock: CLOCK, generation: ports, store: opened.store },
    { evidence, projectId: PROJECT_ID, sourceCommit: SOURCE_COMMIT },
  );
  if (!written.ok) throw new Error(`readiness writer refused ${written.code}`);
  return record;
}

function activateRequest(record: unknown, commandId = "cmd-cutover-activate") {
  return {
    body: encoder.encode(JSON.stringify({
      commandId,
      commandKind: "cutover.activate",
      correlationId: "corr-cutover-activate",
      expectedVersion: 0,
      payload: { record },
      requestDigest: "a".repeat(64),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: CREDENTIAL,
      targetAggregateId: deriveCutoverAttemptAggregateId(PROJECT_ID),
    })),
    credential: CREDENTIAL,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  };
}

describe("cutover.activate over the shipped composition", () => {
  it("commits the marker through /command and the plane reader answers V2 afterwards", async () => {
    const opened = world("activates", true);
    const record = seedToReadyForActivation(opened);
    const plane = opened.provider.commandAuthorityPlane?.();
    if (plane === undefined) throw new Error("plane reader not composed");
    expect(plane.readPlane()).toBe("V1");
    expect(counts(opened.store).marker).toBe(0);

    const answer = await handleAsyncCommandRequest(
      opened.provider.provide(), activateRequest(record), "HTTP_LISTENER");
    expect(answer).toMatchObject({
      decision: { disposition: "DECIDED", resultCode: "ACTIVE" },
      httpStatus: 200, ok: true, outcome: "ACCEPTED",
    });

    // The durable consequences, read back through the production readers and not the
    // handler's answer: one marker, the SAME provider's plane flips, and /1 retires.
    expect(counts(opened.store).marker).toBe(1);
    expect(plane.readPlane()).toBe("V2");
    expect(admitV1AuthoritativeCommand(opened.store, { projectId: PROJECT_ID }))
      .toMatchObject({ code: "V1_AUTHORITY_RETIRED", ok: false });

    // The /2 plane inherits the same wiring: a replay of the accepted command is answered
    // as a replay there rather than as an unconfigured kind or a second marker.
    const replayed = await handleAsyncCommandRequest(
      opened.provider.provideV2?.() ?? opened.provider.provide(), activateRequest(record), "HTTP_LISTENER");
    expect(replayed).toMatchObject({ ok: true, outcome: "ACCEPTED" });
    expect(counts(opened.store).marker).toBe(1);
  });

  it("CONTROL: the same seeding without an evidence root refuses by name and commits nothing",
    async () => {
      const opened = world("unconfigured", false);
      const record = seedToReadyForActivation(opened);
      const before = counts(opened.store);

      const answer = await handleAsyncCommandRequest(
        opened.provider.provide(), activateRequest(record), "HTTP_LISTENER");
      expect(answer).toMatchObject({
        httpStatus: 422, ok: false, outcome: "PORT_REFUSED",
        refusal: { code: "CUTOVER_ACTIVATE_UNCONFIGURED", layer: "DAEMON_COMPOSITION" },
        stage: "DISPATCH",
      });
      expect(counts(opened.store)).toEqual(before);
      expect(opened.provider.commandAuthorityPlane?.().readPlane()).toBe("V1");
    });

  it("reads the evidence root from MOE_CUTOVER_EVIDENCE_ROOT under the empty-means-absent rule",
    () => {
      const base = {
        MOE_DAEMON_CREDENTIAL: "secret", MOE_PROJECT_ID: "proj", MOE_STORE_PATH: "D:/tmp/store.db",
      };
      expect(CUTOVER_EVIDENCE_ROOT_ENV_KEY).toBe("MOE_CUTOVER_EVIDENCE_ROOT");
      expect(readStoreDependencyEnv(base).cutoverEvidenceRoot).toBeUndefined();
      expect(readStoreDependencyEnv({ ...base, [CUTOVER_EVIDENCE_ROOT_ENV_KEY]: "" })
        .cutoverEvidenceRoot).toBeUndefined();
      expect(readStoreDependencyEnv({ ...base, [CUTOVER_EVIDENCE_ROOT_ENV_KEY]: "D:/tmp/root" })
        .cutoverEvidenceRoot).toBe("D:/tmp/root");
    });
});
