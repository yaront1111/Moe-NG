import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_JSON_BODY_BYTES, PROJECT_CONFIGURATION_LIMIT_KEYS } from "@moe/contracts";
import type { ProjectConfigurationManifest } from "@moe/contracts";
import {
  createProjectConfigurationManifest,
  encodeProjectConfigurationManifest,
} from "@moe/core";
import { DurableStoreError, SqliteEventStore } from "@moe/store";
import type {
  CommandDecisionRecord,
  CommandReceipt,
  CursorPage,
  StoredEvent,
} from "@moe/store";

import {
  PROJECT_CONFIGURATION_SELECTION_CODES,
  PROJECT_CONFIGURATION_SELECTION_LAYER,
  readCurrentProjectConfiguration,
  selectProjectConfiguration,
} from "./project-configuration-selection.js";

const PROJECT_ID = "project-configuration-test";
const hex = (character: string): string => character.repeat(64);
const encoder = new TextEncoder();

function settings(modelRef: string): Record<string, unknown> {
  return {
    isolation: { hostContainment: "NOT_CLAIMED", workspace: "PER_ATTEMPT_WORKTREE" },
    limits: PROJECT_CONFIGURATION_LIMIT_KEYS.map((key, index) => ({ key, value: index + 1 })),
    network: { daemonExposure: "LOOPBACK_ONLY", providerEgress: "EGRESS_ALLOWLISTED" },
    orchestrationSource: { objectFormat: "sha256", sourceSha: hex("2") },
    policy: {
      acceptanceGate: "MANUAL_HUMAN_APPROVAL",
      autoApprovalOptInDigest: null,
      evaluatorVersion: "policy-evaluator-v1",
      expansionGate: "MANUAL_HUMAN_APPROVAL",
      planningGate: "MANUAL_HUMAN_APPROVAL",
      policyRevisionId: "policy-revision-1",
      revision: 1,
    },
    schemaVersions: {
      commandSchemaVersion: "moe-command-1",
      errorSchemaVersion: "moe-error-1",
      querySchemaVersion: "moe-query-1",
    },
    selection: {
      modelRef,
      profileRef: "profile-1",
      providerRef: "provider-1",
      reasoningEffortRef: "effort-1",
      runtimeRef: "runtime-1",
      snapshotRef: "snapshot-1",
      structuredOutputSchemaRef: "schema-1",
    },
  };
}

function manifestBytes(modelRef = "model-1"): {
  readonly bytes: Uint8Array;
  readonly manifest: ProjectConfigurationManifest;
} {
  const created = createProjectConfigurationManifest(PROJECT_ID, settings(modelRef));
  if (!created.ok) throw new Error(`fixture create refused: ${created.code}`);
  const encoded = encodeProjectConfigurationManifest(created.manifest);
  if (!encoded.ok) throw new Error(`fixture encode refused: ${encoded.code}`);
  return { bytes: encoded.bytes, manifest: created.manifest };
}

function selectionRequest(
  bytes: Uint8Array,
  commandId = "configuration-command-1",
  expectedVersion = 0,
) {
  return {
    projectId: PROJECT_ID,
    commandId,
    correlationId: `correlation-${commandId}`,
    decidedAt: "2026-08-15T18:00:00.000Z",
    principalId: "principal-1",
    expectedVersion,
    manifestBytes: bytes,
  };
}

function expectUnknown(
  value: unknown,
  code: (typeof PROJECT_CONFIGURATION_SELECTION_CODES)[number],
  upstream: Readonly<{ code: string; layer: string }> | null = null,
): void {
  expect(value).toEqual({
    ok: false,
    outcome: "UNKNOWN",
    authority: "NONE",
    code,
    layer: PROJECT_CONFIGURATION_SELECTION_LAYER,
    upstream,
  });
  expect(Object.isFrozen(value)).toBe(true);
  expect(value).not.toHaveProperty("manifest");
}

const directory = mkdtempSync(join(tmpdir(), "moe-project-configuration-selection-"));
let databaseCounter = 0;
let store: SqliteEventStore;

beforeEach(() => {
  databaseCounter += 1;
  store = SqliteEventStore.openForProject(join(directory, `${databaseCounter}.db`), PROJECT_ID);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // A test may deliberately close the handle first.
  }
});

afterAll(() => {
  rmSync(directory, { force: true, recursive: true });
});

describe("project configuration durable selection", () => {
  it("publishes one exact frozen selected/current record", () => {
    const fixture = manifestBytes();
    const selected = selectProjectConfiguration(store, selectionRequest(fixture.bytes));

    expect(selected).toEqual({
      ok: true,
      outcome: "SELECTED",
      authority: "DAEMON_VERIFIED",
      evidence: "DURABLE",
      manifestBytes: fixture.bytes,
      manifest: fixture.manifest,
      selectionVersion: 1,
    });
    expect(Object.isFrozen(selected)).toBe(true);
    fixture.bytes[0] = 0;

    const current = readCurrentProjectConfiguration(store, {
      projectId: PROJECT_ID,
      expectedSettingsDigest: fixture.manifest.settingsDigest,
    });
    expect(current).toMatchObject({
      ok: true,
      outcome: "CURRENT",
      authority: "DAEMON_VERIFIED",
      evidence: "DURABLE",
      manifest: fixture.manifest,
      selectionVersion: 1,
    });
    if (!current.ok) throw new Error("expected current fixture");
    expect(current.manifestBytes[0]).not.toBe(0);
    expect(Object.isFrozen(current)).toBe(true);
  });

  it("updates currentness, replays exactly once, and refuses an old replay as stale", () => {
    const first = manifestBytes("model-1");
    const second = manifestBytes("model-2");
    const request = selectionRequest(first.bytes);

    expect(selectProjectConfiguration(store, request)).toMatchObject({
      ok: true, outcome: "SELECTED", selectionVersion: 1,
    });
    expect(selectProjectConfiguration(store, request)).toMatchObject({
      ok: true, outcome: "SELECTED", selectionVersion: 1,
    });
    expect(selectProjectConfiguration(
      store,
      selectionRequest(second.bytes, "configuration-command-2", 1),
    )).toMatchObject({ ok: true, outcome: "SELECTED", selectionVersion: 2 });

    expectUnknown(
      selectProjectConfiguration(store, request),
      "PROJECT_CONFIGURATION_STALE",
    );
    const decision = store.getCommandDecision({
      commandId: request.commandId,
      principalId: request.principalId,
      projectId: request.projectId,
    });
    if (decision === null) throw new Error("missing fixture decision");
    expect(store.readAggregateEvents(decision.targetAggregateId, 0, 10).items).toHaveLength(2);
  });

  it("returns the exact stale store provenance to a CAS loser", () => {
    const first = manifestBytes("model-1");
    const second = manifestBytes("model-2");
    selectProjectConfiguration(store, selectionRequest(first.bytes));

    expectUnknown(
      selectProjectConfiguration(
        store,
        selectionRequest(second.bytes, "configuration-command-stale", 0),
      ),
      "PROJECT_CONFIGURATION_STALE",
      { code: "EXPECTED_VERSION_CONFLICT", layer: "DURABLE_STORE" },
    );
  });

  it("preserves the store layer on command identity disagreement", () => {
    const first = manifestBytes("model-1");
    const conflicting = manifestBytes("model-2");
    selectProjectConfiguration(store, selectionRequest(first.bytes));
    expectUnknown(
      selectProjectConfiguration(store, selectionRequest(conflicting.bytes)),
      "PROJECT_CONFIGURATION_CONFLICT",
      { code: "IDEMPOTENCY_CONFLICT", layer: "DURABLE_STORE" },
    );
  });

  it("survives close and reopen with byte-identical current evidence", () => {
    const fixture = manifestBytes();
    const path = join(directory, `${databaseCounter}.db`);
    selectProjectConfiguration(store, selectionRequest(fixture.bytes));
    store.close();
    store = SqliteEventStore.openForProject(path, PROJECT_ID);

    const current = readCurrentProjectConfiguration(store, {
      projectId: PROJECT_ID,
      expectedSettingsDigest: fixture.manifest.settingsDigest,
    });
    expect(current).toMatchObject({ ok: true, outcome: "CURRENT", selectionVersion: 1 });
    if (!current.ok) throw new Error("expected reopened current fixture");
    expect(current.manifestBytes).toEqual(fixture.bytes);
  });

  it("keeps absence and expected-digest staleness distinct", () => {
    const fixture = manifestBytes();
    expectUnknown(
      readCurrentProjectConfiguration(store, {
        projectId: PROJECT_ID,
        expectedSettingsDigest: fixture.manifest.settingsDigest,
      }),
      "PROJECT_CONFIGURATION_ABSENT",
    );
    selectProjectConfiguration(store, selectionRequest(fixture.bytes));
    expectUnknown(
      readCurrentProjectConfiguration(store, {
        projectId: PROJECT_ID,
        expectedSettingsDigest: hex("f"),
      }),
      "PROJECT_CONFIGURATION_STALE",
    );
  });

  it("preserves core codec provenance and refuses hostile request shapes", () => {
    const malformed = selectionRequest(encoder.encode("not-json"));
    expectUnknown(
      selectProjectConfiguration(store, malformed),
      "PROJECT_CONFIGURATION_UNREADABLE",
      { code: "PROJECT_CONFIGURATION_BYTES_INVALID", layer: "PROJECT_CONFIGURATION_CODEC" },
    );

    const request = selectionRequest(manifestBytes().bytes);
    Object.defineProperty(request, "projectId", { enumerable: true, get: () => PROJECT_ID });
    expectUnknown(
      selectProjectConfiguration(store, request),
      "PROJECT_CONFIGURATION_UNREADABLE",
    );
    expect(store.getAggregateVersion("irrelevant")).toBe(0);
  });

  it("refuses revoked, symbol-keyed, sparse, proxied, shared, and oversized inputs locally", () => {
    const fixture = manifestBytes();
    const revoked = Proxy.revocable(selectionRequest(fixture.bytes), {});
    revoked.revoke();
    const symbolKeyed = selectionRequest(fixture.bytes) as Record<PropertyKey, unknown>;
    symbolKeyed[Symbol("hidden")] = true;
    const proxiedBytes = selectionRequest(new Proxy(fixture.bytes, {}));
    const sharedBytes = selectionRequest(
      new Uint8Array(new SharedArrayBuffer(fixture.bytes.byteLength)),
    );
    const cases: readonly unknown[] = [
      revoked.proxy,
      symbolKeyed,
      [],
      proxiedBytes,
      sharedBytes,
      selectionRequest(new Uint8Array(MAX_JSON_BODY_BYTES + 1)),
    ];
    expect(cases).toHaveLength(6);
    for (const hostile of cases) {
      expectUnknown(
        selectProjectConfiguration(store, hostile),
        "PROJECT_CONFIGURATION_UNREADABLE",
      );
    }
    expect(store.getCommandDecision({
      commandId: "configuration-command-1",
      principalId: "principal-1",
      projectId: PROJECT_ID,
    })).toBeNull();
  });

  it("preserves the contract layer for an unsupported manifest version", () => {
    const fixture = manifestBytes();
    const unsupported = encoder.encode(new TextDecoder().decode(fixture.bytes)
      .replace("moe-project-configuration/1", "moe-project-configuration/9"));
    expectUnknown(
      selectProjectConfiguration(store, selectionRequest(unsupported)),
      "PROJECT_CONFIGURATION_UNREADABLE",
      {
        code: "PROJECT_CONFIGURATION_VERSION_UNSUPPORTED",
        layer: "PROJECT_CONFIGURATION_MANIFEST",
      },
    );
  });

  it("rejects a structurally valid but unknown store response disposition", () => {
    const fixture = manifestBytes();
    const port: Parameters<typeof selectProjectConfiguration>[0] = {
      commitExpectedVersionDecision: (input) => {
        const response = store.commitExpectedVersionDecision(input);
        return { ...response, disposition: "BOGUS" } as unknown as typeof response;
      },
      getAggregateVersion: (id) => store.getAggregateVersion(id),
      getCommandDecision: (key) => store.getCommandDecision(key),
      getCommandReceipt: (id) => store.getCommandReceipt(id),
      readAggregateEvents: (id, after, limit) => store.readAggregateEvents(id, after, limit),
    };
    expectUnknown(
      selectProjectConfiguration(port, selectionRequest(fixture.bytes)),
      "PROJECT_CONFIGURATION_CONFLICT",
    );
  });

  it("rejects a stale decision whose effect disposition claims an effect", () => {
    const fixture = manifestBytes();
    const port: Parameters<typeof selectProjectConfiguration>[0] = {
      commitExpectedVersionDecision: (input) => {
        const response = store.commitExpectedVersionDecision(input);
        return {
          ...response,
          decision: {
            ...response.decision,
            effectDisposition: "EFFECTS_COMMITTED",
            resultCode: "EXPECTED_VERSION_CONFLICT",
          },
        } as unknown as typeof response;
      },
      getAggregateVersion: (id) => store.getAggregateVersion(id),
      getCommandDecision: (key) => store.getCommandDecision(key),
      getCommandReceipt: (id) => store.getCommandReceipt(id),
      readAggregateEvents: (id, after, limit) => store.readAggregateEvents(id, after, limit),
    };
    expectUnknown(
      selectProjectConfiguration(port, selectionRequest(fixture.bytes)),
      "PROJECT_CONFIGURATION_CONFLICT",
    );
  });
});

interface CapturedRecords {
  readonly decision: CommandDecisionRecord;
  readonly event: StoredEvent;
  readonly page: CursorPage<StoredEvent, number>;
  readonly receipt: CommandReceipt;
  readonly version: number;
}

function captureRecords(): CapturedRecords {
  const fixture = manifestBytes();
  const request = selectionRequest(fixture.bytes);
  const selected = selectProjectConfiguration(store, request);
  if (!selected.ok) throw new Error(`fixture selection refused: ${selected.code}`);
  const decision = store.getCommandDecision({
    commandId: request.commandId,
    principalId: request.principalId,
    projectId: request.projectId,
  });
  if (decision === null) throw new Error("fixture decision missing");
  const page = store.readAggregateEvents(decision.targetAggregateId, 0, 1);
  const event = page.items[0];
  if (event === undefined) throw new Error("fixture event missing");
  const receipt = store.getCommandReceipt(event.commandId);
  if (receipt === null) throw new Error("fixture receipt missing");
  return { decision, event, page, receipt, version: decision.currentVersion ?? 0 };
}

type ReadPort = Parameters<typeof readCurrentProjectConfiguration>[0];

function portFor(
  records: CapturedRecords,
  overrides: Partial<{
    decision: CommandDecisionRecord | null;
    page: unknown;
    receipt: CommandReceipt | null;
    versions: readonly number[];
  }> = {},
): ReadPort {
  const versions = [...(overrides.versions ?? [records.version, records.version])];
  return {
    commitExpectedVersionDecision: (input) => store.commitExpectedVersionDecision(input),
    getAggregateVersion: () => versions.shift() ?? records.version,
    getCommandDecision: () => overrides.decision === undefined
      ? records.decision
      : overrides.decision,
    getCommandReceipt: () => overrides.receipt === undefined
      ? records.receipt
      : overrides.receipt,
    readAggregateEvents: () => (overrides.page ?? records.page) as CursorPage<StoredEvent, number>,
  };
}

function currentRequest(records: CapturedRecords) {
  const decoded = JSON.parse(new TextDecoder().decode(records.event.payload)) as {
    settingsDigest: string;
  };
  return { projectId: PROJECT_ID, expectedSettingsDigest: decoded.settingsDigest };
}

const resultSha = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

describe("project configuration current-read integrity", () => {
  it("returns the exact absence refusal from a stable empty head", () => {
    const unreachable = (): never => { throw new Error("unexpected store call"); };
    const empty: ReadPort = {
      commitExpectedVersionDecision: unreachable,
      getAggregateVersion: () => 0,
      getCommandDecision: unreachable,
      getCommandReceipt: unreachable,
      readAggregateEvents: unreachable,
    };
    expectUnknown(
      readCurrentProjectConfiguration(empty, {
        projectId: PROJECT_ID,
        expectedSettingsDigest: hex("f"),
      }),
      "PROJECT_CONFIGURATION_ABSENT",
    );
  });

  it("bounds a perpetually moving aggregate head and preserves store throw provenance", () => {
    const records = captureRecords();
    expectUnknown(
      readCurrentProjectConfiguration(
        portFor(records, { versions: [1, 2, 2, 3, 3, 4] }),
        currentRequest(records),
      ),
      "PROJECT_CONFIGURATION_CONFLICT",
    );

    const throwing: ReadPort = {
      ...portFor(records),
      getAggregateVersion: () => {
        throw new DurableStoreError("STORE_CLOSED", "closed by test");
      },
    };
    expectUnknown(
      readCurrentProjectConfiguration(throwing, currentRequest(records)),
      "PROJECT_CONFIGURATION_UNREADABLE",
      { code: "STORE_CLOSED", layer: "DURABLE_STORE" },
    );
  });

  it("refuses every forged durable-record case at its exact layer", () => {
    const records = captureRecords();
    const malformed = Uint8Array.of(0xff);
    const trace = records.event.decisionTrace;
    if (trace === undefined) throw new Error("fixture trace missing");
    const event = records.event;
    const decision = records.decision;
    const receipt = records.receipt;
    const numericEventId = 7 as unknown as string;

    const cases: readonly {
      readonly name: string;
      readonly port: ReadPort;
      readonly code: (typeof PROJECT_CONFIGURATION_SELECTION_CODES)[number];
      readonly upstream?: Readonly<{ code: string; layer: string }>;
    }[] = [
      { name: "page has more", port: portFor(records, { page: { ...records.page, hasMore: true } }), code: "PROJECT_CONFIGURATION_CONFLICT" },
      { name: "page empty", port: portFor(records, { page: { ...records.page, items: [] } }), code: "PROJECT_CONFIGURATION_CONFLICT" },
      { name: "event type", port: portFor(records, { page: { ...records.page, items: [{ ...event, eventType: "Forged" }] } }), code: "PROJECT_CONFIGURATION_CONFLICT" },
      { name: "schema", port: portFor(records, { page: { ...records.page, items: [{ ...event, domainSchemaVersion: "unsupported" }] } }), code: "PROJECT_CONFIGURATION_CONFLICT" },
      { name: "aggregate", port: portFor(records, { page: { ...records.page, items: [{ ...event, aggregateId: "transplanted" }] } }), code: "PROJECT_CONFIGURATION_CONFLICT" },
      { name: "sequence", port: portFor(records, { page: { ...records.page, items: [{ ...event, aggregateSequence: 2 }] } }), code: "PROJECT_CONFIGURATION_CONFLICT" },
      { name: "trace project", port: portFor(records, { page: { ...records.page, items: [{ ...event, decisionTrace: { ...trace, projectId: "other-project" } }] } }), code: "PROJECT_CONFIGURATION_CONFLICT" },
      { name: "decision missing", port: portFor(records, { decision: null }), code: "PROJECT_CONFIGURATION_UNREADABLE" },
      { name: "decision target", port: portFor(records, { decision: { ...decision, targetAggregateId: "other-aggregate" } }), code: "PROJECT_CONFIGURATION_CONFLICT" },
      { name: "decision project", port: portFor(records, { decision: { ...decision, key: { ...decision.key, projectId: "other-project" } } }), code: "PROJECT_CONFIGURATION_CONFLICT" },
      { name: "request digest", port: portFor(records, { decision: { ...decision, requestSha256: hex("a") } }), code: "PROJECT_CONFIGURATION_CONFLICT" },
      { name: "result bytes", port: portFor(records, { decision: { ...decision, resultBytes: Uint8Array.of(1) } }), code: "PROJECT_CONFIGURATION_CONFLICT" },
      { name: "receipt missing", port: portFor(records, { receipt: null }), code: "PROJECT_CONFIGURATION_UNREADABLE" },
      { name: "receipt request digest", port: portFor(records, { receipt: { ...receipt, requestSha256: hex("b") } }), code: "PROJECT_CONFIGURATION_CONFLICT" },
      { name: "nonhex digests", port: portFor(records, {
        decision: { ...decision, requestSha256: "trace-digest" },
        page: { ...records.page, items: [{ ...event, requestSha256: "event-digest", decisionTrace: { ...trace, requestSha256: "trace-digest" } }] },
        receipt: { ...receipt, requestSha256: "event-digest" },
      }), code: "PROJECT_CONFIGURATION_CONFLICT" },
      { name: "event id type", port: portFor(records, {
        decision: { ...decision, businessEventIds: [numericEventId] } as unknown as CommandDecisionRecord,
        page: { ...records.page, items: [{ ...event, eventId: numericEventId }] },
        receipt: { ...receipt, eventIds: [numericEventId] },
      }), code: "PROJECT_CONFIGURATION_CONFLICT" },
      {
        name: "codec bytes",
        port: portFor(records, {
          decision: { ...decision, resultBytes: malformed, resultSha256: resultSha(malformed) },
          page: { ...records.page, items: [{ ...event, payload: malformed }] },
        }),
        code: "PROJECT_CONFIGURATION_UNREADABLE",
        upstream: { code: "PROJECT_CONFIGURATION_BYTES_INVALID", layer: "PROJECT_CONFIGURATION_CODEC" },
      },
    ];

    expect(cases).toHaveLength(17);
    expect(cases.length).toBeGreaterThan(0);
    for (const forged of cases) {
      const result = readCurrentProjectConfiguration(forged.port, currentRequest(records));
      try {
        expectUnknown(result, forged.code, forged.upstream ?? null);
      } catch (error) {
        throw new Error(`forged case failed: ${forged.name}`, { cause: error });
      }
    }
  });
});

describe("closed project configuration selection vocabulary", () => {
  it("pins every code and its owning layer", () => {
    expect(PROJECT_CONFIGURATION_SELECTION_CODES).toEqual([
      "PROJECT_CONFIGURATION_ABSENT",
      "PROJECT_CONFIGURATION_STALE",
      "PROJECT_CONFIGURATION_CONFLICT",
      "PROJECT_CONFIGURATION_UNREADABLE",
    ]);
    expect(Object.isFrozen(PROJECT_CONFIGURATION_SELECTION_CODES)).toBe(true);
    expect(PROJECT_CONFIGURATION_SELECTION_LAYER).toBe("PROJECT_CONFIGURATION_SELECTION");
  });
});
