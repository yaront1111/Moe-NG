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
  readLatestProjectConfiguration,
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

/**
 * task-80745330: DISCOVER-CURRENT. `readCurrentProjectConfiguration` validates a digest the
 * CALLER already holds, and nothing in this module can YIELD that digest, so a caller who does
 * not already have one has no way in. `readLatestProjectConfiguration` is the same
 * decision-covered fold with no caller-held operand.
 *
 * THE DANGER THESE ARMS EXIST TO CATCH is not that the new reader fails - it is that it
 * succeeds too easily. Dropping the digest comparison must drop EXACTLY that comparison and no
 * other fence, and the reader must stay READ-ONLY. So every fence is re-proven against the new
 * entry point rather than assumed to be inherited, and the read-only claim is measured against
 * a real store rather than asserted in prose.
 */
describe("project configuration latest-read (discover-current)", () => {
  it("A: PARITY - discovers the same record the validating reader accepts for that digest", () => {
    const records = captureRecords();
    const decoded = JSON.parse(new TextDecoder().decode(records.event.payload)) as
      ProjectConfigurationManifest;

    const latest = readLatestProjectConfiguration(store, { projectId: PROJECT_ID });

    expect(latest).toEqual({
      authority: "DAEMON_VERIFIED", evidence: "DURABLE", manifest: decoded,
      manifestBytes: records.event.payload, ok: true, outcome: "CURRENT",
      selectionVersion: records.version,
    });
    if (!latest.ok) throw new Error("unreachable");
    expect([...latest.manifestBytes]).toEqual([...records.event.payload]);
    // THE POINT OF THE WHOLE ROW: the digest this reader DISCOVERS is exactly the digest the
    // validating reader ACCEPTS. Without that, the caller still has no way to obtain one.
    expect(readCurrentProjectConfiguration(store, {
      expectedSettingsDigest: latest.manifest.settingsDigest, projectId: PROJECT_ID,
    })).toEqual(latest);
  });

  it("B: EXACT ROSTER - an extra, missing or ill-typed key refuses, so it is no alias", () => {
    const records = captureRecords();
    // The EXTRA-KEY case is what proves this is not the two-key reader wearing a new name:
    // passing the OLD reader's own second key must REFUSE here.
    expectUnknown(readLatestProjectConfiguration(store, {
      expectedSettingsDigest: hex("f"), projectId: PROJECT_ID,
    }), "PROJECT_CONFIGURATION_UNREADABLE");
    expectUnknown(readLatestProjectConfiguration(store, {}),
      "PROJECT_CONFIGURATION_UNREADABLE");
    expectUnknown(readLatestProjectConfiguration(store, { projectId: "" }),
      "PROJECT_CONFIGURATION_UNREADABLE");
    expectUnknown(readLatestProjectConfiguration(store, { projectId: 42 }),
      "PROJECT_CONFIGURATION_UNREADABLE");

    const symbolKeyed = { [Symbol("projectId")]: PROJECT_ID, projectId: PROJECT_ID };
    expectUnknown(readLatestProjectConfiguration(store, symbolKeyed),
      "PROJECT_CONFIGURATION_UNREADABLE");
    const accessorKeyed = Object.defineProperty({}, "projectId", {
      configurable: true, enumerable: true, get: () => PROJECT_ID,
    });
    expectUnknown(readLatestProjectConfiguration(store, accessorKeyed),
      "PROJECT_CONFIGURATION_UNREADABLE");
    expect(records.version).toBeGreaterThan(0);
  });

  it("G: A MOVING HEAD REFUSES rather than returning a torn record", () => {
    const records = captureRecords();
    // The twin of the validating reader's own moving-head arm. Dropping the digest operand must
    // not soften the tail's consistency bound: a head that keeps moving across all three
    // attempts is a CONFLICT here too, never a record stitched from two different heads.
    expectUnknown(
      readLatestProjectConfiguration(
        portFor(records, { versions: [1, 2, 2, 3, 3, 4] }),
        { projectId: PROJECT_ID },
      ),
      "PROJECT_CONFIGURATION_CONFLICT",
    );

    // And a store that throws keeps its own provenance, unrestamped, exactly as the sibling
    // reader does - the `catch`/`storeRefusal` shape is shared rather than re-implemented.
    const throwing: ReadPort = {
      ...portFor(records),
      getAggregateVersion: () => {
        throw new DurableStoreError("STORE_CLOSED", "closed by test");
      },
    };
    expectUnknown(
      readLatestProjectConfiguration(throwing, { projectId: PROJECT_ID }),
      "PROJECT_CONFIGURATION_UNREADABLE",
      { code: "STORE_CLOSED", layer: "DURABLE_STORE" },
    );
  });

  it("C: ABSENT - a stable empty head refuses with the SAME code as the validating reader", () => {
    const unreachable = (): never => { throw new Error("unexpected store call"); };
    const empty: ReadPort = {
      commitExpectedVersionDecision: unreachable,
      getAggregateVersion: () => 0,
      getCommandDecision: unreachable,
      getCommandReceipt: unreachable,
      readAggregateEvents: unreachable,
    };
    expectUnknown(readLatestProjectConfiguration(empty, { projectId: PROJECT_ID }),
      "PROJECT_CONFIGURATION_ABSENT");
  });

  it("D: STALE IS UNREACHABLE - where the old reader refuses v1, this one answers v2", () => {
    const first = manifestBytes("model-1");
    const selectedFirst = selectProjectConfiguration(store, selectionRequest(first.bytes));
    if (!selectedFirst.ok) throw new Error(`v1 refused: ${selectedFirst.code}`);
    const second = manifestBytes("model-2");
    const selectedSecond = selectProjectConfiguration(store, {
      ...selectionRequest(second.bytes),
      commandId: "cmd-project-configuration-v2",
      expectedVersion: 1,
    });
    if (!selectedSecond.ok) throw new Error(`v2 refused: ${selectedSecond.code}`);
    expect(first.manifest.settingsDigest).not.toBe(second.manifest.settingsDigest);

    // Side by side on ONE store: the caller-held v1 digest is now STALE...
    expectUnknown(readCurrentProjectConfiguration(store, {
      expectedSettingsDigest: first.manifest.settingsDigest, projectId: PROJECT_ID,
    }), "PROJECT_CONFIGURATION_STALE");
    // ...while the discover-current read has no operand to be stale against, and answers v2.
    const latest = readLatestProjectConfiguration(store, { projectId: PROJECT_ID });
    if (!latest.ok) throw new Error(`latest refused: ${latest.code}`);
    expect(latest.outcome).toBe("CURRENT");
    expect(latest.manifest.settingsDigest).toBe(second.manifest.settingsDigest);
    expect(latest.selectionVersion).toBe(2);
  });

  it("E: READ-ONLY - the aggregate never moves and no decision is ever committed", () => {
    const records = captureRecords();
    const id = `project-configuration:${createHash("sha256").update(PROJECT_ID, "utf8").digest("hex")}`;
    const versionBefore = store.getAggregateVersion(id);
    const eventsBefore = store.readAggregateEvents(id, 0, 10).items.length;
    expect(versionBefore).toBeGreaterThan(0);

    // Every OUTCOME the reader can reach, not only the happy one: a write on a REFUSING path
    // would be just as much a defect, and is where a careless implementation would hide one.
    readLatestProjectConfiguration(store, { projectId: PROJECT_ID });
    readLatestProjectConfiguration(store, { projectId: "project-never-configured" });
    readLatestProjectConfiguration(store, { projectId: 42 });

    expect(store.getAggregateVersion(id)).toBe(versionBefore);
    expect(store.readAggregateEvents(id, 0, 10).items.length).toBe(eventsBefore);

    // E2: the WRITE SEAM ITSELF, counted rather than inferred from one aggregate not moving -
    // a commit against a DIFFERENT aggregate would leave every assertion above green.
    let commits = 0;
    const counting: ReadPort = {
      ...portFor(records),
      commitExpectedVersionDecision: (input) => {
        commits += 1;
        return store.commitExpectedVersionDecision(input);
      },
    };
    const answer = readLatestProjectConfiguration(counting, { projectId: PROJECT_ID });
    expect(commits).toBe(0);
    expect(answer.ok).toBe(true);
  });

  it("F: FORGED-RECORD PARITY - every fence the validating reader holds, this one holds too", () => {
    const records = captureRecords();
    const malformed = Uint8Array.of(0xff);
    const trace = records.event.decisionTrace;
    if (trace === undefined) throw new Error("fixture trace missing");
    const event = records.event;
    const decision = records.decision;
    const receipt = records.receipt;

    // A SUBSET of the forged table above, chosen so each entry names a DIFFERENT fence: the
    // tail shape, the decision cover, the receipt cover, and the codec. If the null-digest
    // branch had dropped a fence rather than only the comparison, one of these would diverge.
    const cases: readonly { readonly name: string; readonly port: ReadPort }[] = [
      { name: "page has more", port: portFor(records, { page: { ...records.page, hasMore: true } }) },
      { name: "event type", port: portFor(records, { page: { ...records.page, items: [{ ...event, eventType: "Forged" }] } }) },
      { name: "trace project", port: portFor(records, { page: { ...records.page, items: [{ ...event, decisionTrace: { ...trace, projectId: "other-project" } }] } }) },
      { name: "decision missing", port: portFor(records, { decision: null }) },
      { name: "decision target", port: portFor(records, { decision: { ...decision, targetAggregateId: "other-aggregate" } }) },
      { name: "receipt missing", port: portFor(records, { receipt: null }) },
      { name: "receipt request digest", port: portFor(records, { receipt: { ...receipt, requestSha256: hex("b") } }) },
      {
        name: "codec bytes",
        port: portFor(records, {
          decision: { ...decision, resultBytes: malformed, resultSha256: resultSha(malformed) },
          page: { ...records.page, items: [{ ...event, payload: malformed }] },
        }),
      },
    ];

    // A sweep that silently produced zero cases would pass while testing nothing.
    expect(cases).toHaveLength(8);
    for (const forged of cases) {
      const expected = readCurrentProjectConfiguration(forged.port, currentRequest(records));
      const actual = readLatestProjectConfiguration(forged.port, { projectId: PROJECT_ID });
      try {
        // WHOLE-VALUE equality, so the code, the layer AND the upstream must all agree. An
        // assertion on the code alone would let a re-stamped layer through.
        expect(actual).toEqual(expected);
        expect(actual.ok).toBe(false);
      } catch (error) {
        throw new Error(`forged parity failed: ${forged.name}`, { cause: error });
      }
    }
  });
});
