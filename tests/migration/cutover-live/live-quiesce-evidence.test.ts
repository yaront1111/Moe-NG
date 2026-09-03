/**
 * Evidence-record arms for the LIVE legacy quiesce (task-e60b874b).
 *
 * The manifest comparison used here is produced by the REAL
 * `compareCutoverManifests` from tests/migration/cutover/, not by a local
 * reimplementation — rail 3 says compose that harness, and the epic rail says a
 * property must be asserted against the production surface.
 */

import { describe, expect, it } from "vitest";

import {
  LIVE_QUIESCE_EVIDENCE_LAYER as CORE_EVIDENCE_LAYER,
  LIVE_QUIESCE_EVIDENCE_REFUSAL_CODES as CORE_EVIDENCE_REFUSAL_CODES,
  deriveLiveQuiesceEvidenceDigest,
} from "@moe/core";

import { compareCutoverManifests } from "../cutover/cutover-compare.js";
import type { CutoverManifest } from "../cutover/cutover-manifest.js";
import {
  quiesceAll,
  quiesceItem,
  type LiveQuiescePorts,
  type QuiesceItemResult,
} from "./live-quiesce-actor.js";
import {
  HARNESS_ONLY_TASK_ID,
  LIVE_QUIESCE_EVIDENCE_LAYER,
  LIVE_QUIESCE_EVIDENCE_REFUSAL_CODES,
  QUIESCE_CITATION_TASK_ID,
  buildLiveEvidence,
  serializeLiveEvidence,
  writeLiveEvidence,
  type LiveQuiesceEvidenceInput,
} from "./live-quiesce-evidence.js";
import {
  LIVE_QUIESCE_KINDS,
  buildLiveInventory,
  type LiveQuiesceInventory,
  type LiveQuiesceItem,
  type LiveQuiesceKind,
} from "./live-quiesce-inventory.js";

const HOST = "win32/DESKTOP-TEST/node-24";

const AUTHORITY = {
  principal: "the human operator of this board (Yaron), the project owner",
  moment: "2026-08-24T10:26Z",
  commentId: "comment-14cf36f3b61a49269e5cb4fa42187a3d",
};

const itemOf = (kind: LiveQuiesceKind, id: string): LiveQuiesceItem => ({
  kind,
  id,
  discoveredBy: `probe --kind ${kind} --id ${id}`,
  observedBefore: `${id} answered a live probe`,
});

const ITEMS = LIVE_QUIESCE_KINDS.map((kind) => itemOf(kind, `${kind.toLowerCase()}-1`));

const inventoryOf = (items: readonly LiveQuiesceItem[] = ITEMS): LiveQuiesceInventory => {
  const built = buildLiveInventory({
    runMode: "LIVE",
    hostFingerprint: HOST,
    items,
    undiscoverableKinds: [],
  });
  if (!built.ok) {
    throw new Error(`fixture inventory refused: ${built.code}`);
  }
  return built.inventory;
};

const stoppingPorts: LiveQuiescePorts = {
  stop: (item) => ({ accepted: true, command: `stop ${item.id}`, exitCode: 0 }),
  observe: () => ({ live: false, detail: "gone" }),
};

const resultsFor = (items: readonly LiveQuiesceItem[]): QuiesceItemResult[] =>
  items.map((item) => quiesceItem(item, stoppingPorts));

const manifestOf = (sha: string): CutoverManifest => ({
  root: "D:/legacy-root",
  entryCount: 1,
  entries: [{ kind: "FILE", path: "state.json", byteLength: 12, sha256: sha }],
  excludedDirectories: ["node_modules"],
});

/** A real comparison from the real harness, not a hand-built literal. */
const REAL_COMPARISON = compareCutoverManifests(manifestOf("a".repeat(64)), manifestOf("a".repeat(64)));

const inputOf = (over: Partial<LiveQuiesceEvidenceInput> = {}): LiveQuiesceEvidenceInput => ({
  runMode: "LIVE",
  hostFingerprint: HOST,
  authority: AUTHORITY,
  inventory: inventoryOf(),
  results: resultsFor(ITEMS),
  manifestComparison: REAL_COMPARISON,
  stoppedAt: ITEMS.map((item) => ({ itemId: item.id, moment: "2026-08-28T17:00:00.000Z" })),
  ...over,
});

/**
 * Codes actually OBSERVED firing by the arms below, recorded at runtime.
 * The roster test asserts this set equals the exported roster, which turns
 * "every code has an arm" from a hand-maintained claim into evidence: a code
 * whose arm is deleted or never written leaves this set and reds, even though
 * a literal mirror list would still agree with the roster.
 */
const observedCodes = new Set<string>();

describe("task-e60b874b: the evidence record refuses anything a reader could misread", () => {
  it("accepts a complete LIVE record and matches every inventory item to a result", () => {
    const outcome = buildLiveEvidence(inputOf());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(`expected acceptance, refused ${outcome.code}`);
    }
    expect(outcome.evidence.runMode).toBe("LIVE");
    expect(outcome.evidence.resolvedCount).toBe(outcome.evidence.inventory.itemCount);
    expect(outcome.evidence.resolvedCount).toBe(5);
    expect(outcome.evidence.outcome).toBe("COMPLETE");
    expect(outcome.evidence.authority.principal).toContain("project owner");
    expect(outcome.evidence.authority.moment).toBe("2026-08-24T10:26Z");
  });

  it("refuses an unresolved item — neither stopped with an observation nor refused", () => {
    // The count is deliberately CORRECT here. Dropping a result instead would
    // trip LIVE_QUIESCE_EVIDENCE_COUNT_MISMATCH first and this arm would never
    // reach the resolution check it exists to prove. So one real item is
    // swapped for a ghost: five results for five inventory items, but
    // access_path-1 has no result and a stranger has one.
    const kept = ITEMS.slice(0, 4);
    const ghost = itemOf("ACCESS_PATH", "ghost-not-in-inventory");
    const results = [...resultsFor(kept), ...resultsFor([ghost])];
    expect(results).toHaveLength(inventoryOf().itemCount);

    const outcome = buildLiveEvidence(
      inputOf({
        results,
        stoppedAt: [...kept, ghost].map((i) => ({ itemId: i.id, moment: "m" })),
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("an unresolved item must never be accepted");
    }
    expect(outcome.code).toBe("LIVE_QUIESCE_EVIDENCE_INCOMPLETE");
    expect(outcome.layer).toBe(LIVE_QUIESCE_EVIDENCE_LAYER);
    observedCodes.add(outcome.code);
    expect(outcome.detail).toContain("access_path-1");
  });

  it("catches an item dropped by the SWEEP, not just one dropped by a caller", () => {
    // The other arms hand-build results with quiesceItem, which leaves the
    // composition untested: if quiesceAll ever stopped returning one result per
    // input, nothing here would notice. This arm routes through the real sweep,
    // and it uses ports where ONE ITEM REFUSES on purpose — a sweep that drops
    // refusals has nothing to drop when every item succeeds, so a happy-path
    // fixture here would be a fixed point and could not fail.
    const oneRefuses: LiveQuiescePorts = {
      stop: (item) => ({ accepted: true, command: `stop ${item.id}`, exitCode: 0 }),
      observe: (item) =>
        item.kind === "WATCHER" ? { live: true, detail: "still registered" } : { live: false, detail: "gone" },
    };

    const sweep = quiesceAll(ITEMS, oneRefuses);
    expect(sweep.outcome).toBe("PARTIAL");
    expect(sweep.resultCount).toBe(sweep.inputCount);

    const outcome = buildLiveEvidence(
      inputOf({ results: sweep.results, stoppedAt: ITEMS.map((i) => ({ itemId: i.id, moment: "m" })) }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(`a faithful sweep must compose; refused ${outcome.code}`);
    }
    // The refused watcher must still be counted: five in, five resolved.
    expect(outcome.evidence.resolvedCount).toBe(ITEMS.length);
    expect(outcome.evidence.results.filter((r) => !r.ok)).toHaveLength(1);
  });

  it("refuses a result count that differs from the inventory count", () => {
    const extra = [...resultsFor(ITEMS), ...resultsFor([itemOf("PROCESS", "ghost-1")])];

    const outcome = buildLiveEvidence(inputOf({ results: extra }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("a count mismatch must never be accepted");
    }
    expect(outcome.code).toBe("LIVE_QUIESCE_EVIDENCE_COUNT_MISMATCH");
    expect(outcome.layer).toBe(LIVE_QUIESCE_EVIDENCE_LAYER);
    observedCodes.add(outcome.code);
    expect(outcome.detail).toContain("6");
  });

  it.each([
    ["absent", undefined],
    ["HARNESS", "HARNESS"],
  ])("refuses runMode %s so a harness run cannot serialize into this shape", (_label, value) => {
    const outcome = buildLiveEvidence(
      inputOf({ runMode: value as LiveQuiesceEvidenceInput["runMode"] }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("only a LIVE run may mint this record");
    }
    expect(outcome.code).toBe("LIVE_QUIESCE_EVIDENCE_RUNMODE_MISSING");
    expect(outcome.layer).toBe(LIVE_QUIESCE_EVIDENCE_LAYER);
    observedCodes.add(outcome.code);
  });

  it("refuses a record whose GO_QUIESCE principal or moment is blank", () => {
    const outcome = buildLiveEvidence(
      inputOf({ authority: { ...AUTHORITY, principal: "   " } }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("an unattributed authority must never be accepted");
    }
    expect(outcome.code).toBe("LIVE_QUIESCE_EVIDENCE_AUTHORITY_MISSING");
    expect(outcome.layer).toBe(LIVE_QUIESCE_EVIDENCE_LAYER);
    observedCodes.add(outcome.code);
  });

  it("refuses when the manifest comparison itself refused — no byte evidence, no claim", () => {
    const empty: CutoverManifest = {
      root: "D:/legacy-root",
      entryCount: 0,
      entries: [],
      excludedDirectories: ["node_modules"],
    };
    const refusedComparison = compareCutoverManifests(empty, empty);
    // Guard: the harness must really have refused, or this arm proves nothing.
    expect("ok" in refusedComparison && refusedComparison.ok).toBe(false);

    const outcome = buildLiveEvidence(inputOf({ manifestComparison: refusedComparison }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("a refused comparison must never be recorded as byte evidence");
    }
    expect(outcome.code).toBe("LIVE_QUIESCE_EVIDENCE_MANIFEST_REFUSED");
    expect(outcome.layer).toBe(LIVE_QUIESCE_EVIDENCE_LAYER);
    observedCodes.add(outcome.code);
  });

  it("refuses a stopped item with no recorded stop moment", () => {
    const outcome = buildLiveEvidence(inputOf({ stoppedAt: ITEMS.slice(1).map((i) => ({ itemId: i.id, moment: "m" })) }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("a stop with no moment must never be accepted");
    }
    expect(outcome.code).toBe("LIVE_QUIESCE_EVIDENCE_STOP_MOMENT_MISSING");
    expect(outcome.layer).toBe(LIVE_QUIESCE_EVIDENCE_LAYER);
    observedCodes.add(outcome.code);
    expect(outcome.detail).toContain("process-1");
  });

  it("records a PARTIAL run with the refusal's exact code and layer, never omitting it", () => {
    const stubbornPorts: LiveQuiescePorts = {
      stop: (item) => ({ accepted: true, command: `stop ${item.id}`, exitCode: 0 }),
      observe: (item) =>
        item.kind === "WATCHER" ? { live: true, detail: "still registered" } : { live: false, detail: "gone" },
    };
    const results = ITEMS.map((item) => quiesceItem(item, stubbornPorts));

    const outcome = buildLiveEvidence(inputOf({ results }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(`an honest partial must be recordable; refused ${outcome.code}`);
    }
    expect(outcome.evidence.outcome).toBe("PARTIAL");
    const refusals = outcome.evidence.results.filter((result) => !result.ok);
    expect(refusals).toHaveLength(1);
    const [only] = refusals;
    if (only === undefined || only.ok) {
      throw new Error("the refusal must survive into the record");
    }
    expect(only.code).toBe("LIVE_QUIESCE_ITEM_STILL_LIVE");
    expect(only.layer).toBe("live-quiesce-actor");
  });
});

describe("task-e60b874b: the citation names THIS row, not the harness row", () => {
  it("exposes a citation key resolving to this row's id and never task-4e1fe696's", () => {
    const outcome = buildLiveEvidence(inputOf());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(`expected acceptance, refused ${outcome.code}`);
    }
    // DoD 5. A readiness sweep resolving the quiesce clause by task id currently
    // reads task-4e1fe696 = DONE and concludes the drill ran. It did not: that
    // row was approved at HARNESS scope. The citation must point here instead.
    expect(QUIESCE_CITATION_TASK_ID).toBe("task-e60b874bac924a6b9c255cb8c924041f");
    expect(HARNESS_ONLY_TASK_ID).toBe("task-4e1fe696");
    expect(QUIESCE_CITATION_TASK_ID).not.toBe(HARNESS_ONLY_TASK_ID);
    expect(outcome.evidence.citationKey).toContain(QUIESCE_CITATION_TASK_ID);
    expect(outcome.evidence.citationKey).not.toContain(HARNESS_ONLY_TASK_ID);
    expect(outcome.evidence.citedBy).toBe("task-09008b4cb39c4a15aa661540d20e9b9b");
  });
});

describe("task-e60b874b: serialization is an explicit surface", () => {
  it("serializes to JSON whose runMode and citation are visible on its face", () => {
    const outcome = buildLiveEvidence(inputOf());
    if (!outcome.ok) {
      throw new Error(`expected acceptance, refused ${outcome.code}`);
    }

    const text = serializeLiveEvidence(outcome.evidence);
    const parsed: unknown = JSON.parse(text);

    expect(text).toContain('"runMode": "LIVE"');
    expect(text).toContain(QUIESCE_CITATION_TASK_ID);
    expect(parsed).toMatchObject({ runMode: "LIVE", resolvedCount: 5 });
  });

  it("writes through an injected port and reports the path it wrote", () => {
    const outcome = buildLiveEvidence(inputOf());
    if (!outcome.ok) {
      throw new Error(`expected acceptance, refused ${outcome.code}`);
    }
    const written: { path?: string; body?: string } = {};

    const result = writeLiveEvidence(outcome.evidence, "D:/evidence/live-quiesce.json", {
      writeFile: (path, body) => {
        written.path = path;
        written.body = body;
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`expected a write, refused ${result.code}`);
    }
    expect(result.path).toBe("D:/evidence/live-quiesce.json");
    expect(written.path).toBe("D:/evidence/live-quiesce.json");
    expect(written.body).toContain('"runMode": "LIVE"');
  });

  it("refuses rather than throwing when the durable write fails", () => {
    const outcome = buildLiveEvidence(inputOf());
    if (!outcome.ok) {
      throw new Error(`expected acceptance, refused ${outcome.code}`);
    }

    const result = writeLiveEvidence(outcome.evidence, "D:/evidence/live-quiesce.json", {
      writeFile: () => {
        throw new Error("EACCES: permission denied");
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("a failed durable write must never report success");
    }
    expect(result.code).toBe("LIVE_QUIESCE_EVIDENCE_WRITE_FAILED");
    expect(result.layer).toBe(LIVE_QUIESCE_EVIDENCE_LAYER);
    observedCodes.add(result.code);
    expect(result.detail).toContain("permission denied");
  });
});

describe("task-e60b874b: evidence roster", () => {
  it("holds exactly seven codes, frozen, set-equal both directions", () => {
    const asserted = [
      "LIVE_QUIESCE_EVIDENCE_INCOMPLETE",
      "LIVE_QUIESCE_EVIDENCE_COUNT_MISMATCH",
      "LIVE_QUIESCE_EVIDENCE_RUNMODE_MISSING",
      "LIVE_QUIESCE_EVIDENCE_AUTHORITY_MISSING",
      "LIVE_QUIESCE_EVIDENCE_MANIFEST_REFUSED",
      "LIVE_QUIESCE_EVIDENCE_STOP_MOMENT_MISSING",
      "LIVE_QUIESCE_EVIDENCE_WRITE_FAILED",
    ];

    expect(LIVE_QUIESCE_EVIDENCE_REFUSAL_CODES).toHaveLength(7);
    expect(asserted).toHaveLength(LIVE_QUIESCE_EVIDENCE_REFUSAL_CODES.length);
    expect(Object.isFrozen(LIVE_QUIESCE_EVIDENCE_REFUSAL_CODES)).toBe(true);
    for (const code of LIVE_QUIESCE_EVIDENCE_REFUSAL_CODES) {
      expect(asserted).toContain(code);
    }
    for (const code of asserted) {
      expect(LIVE_QUIESCE_EVIDENCE_REFUSAL_CODES).toContain(code);
    }
  });

  it("every roster code was OBSERVED firing above, not merely listed", () => {
    expect(observedCodes.size).toBe(LIVE_QUIESCE_EVIDENCE_REFUSAL_CODES.length);
    expect(observedCodes.size).toBeGreaterThan(0);
    for (const code of LIVE_QUIESCE_EVIDENCE_REFUSAL_CODES) {
      expect([...observedCodes]).toContain(code);
    }
    for (const code of observedCodes) {
      expect(LIVE_QUIESCE_EVIDENCE_REFUSAL_CODES).toContain(code);
    }
  });
});

/**
 * task-2bf8fa1a, DoD 3/4. These arms are the reason the lane and `@moe/core`
 * cannot hold two notions of quiescence that agree today and diverge later.
 *
 * The identity arms make the vocabulary ONE object rather than two equal ones:
 * a value-equality assertion would still pass against a re-declared copy, so
 * `toBe` is load-bearing here and `toEqual` would be the weaker assertion.
 * The digest arm makes the SHAPE shared executably: `@moe/core` validates the
 * record structurally and refuses anything it does not recognise, so a field
 * this lane adds, drops or renames turns the digest into a named refusal here
 * rather than into a silent second dialect.
 */
describe("task-2bf8fa1a: the lane and @moe/core hold ONE notion of quiescence", () => {
  it("re-exports the production layer and roster by identity, not by copy", () => {
    expect(LIVE_QUIESCE_EVIDENCE_LAYER).toBe(CORE_EVIDENCE_LAYER);
    expect(LIVE_QUIESCE_EVIDENCE_REFUSAL_CODES).toBe(CORE_EVIDENCE_REFUSAL_CODES);
  });

  it("the record this lane builds is accepted by the production digest", () => {
    const outcome = buildLiveEvidence(inputOf());
    if (!outcome.ok) {
      throw new Error(`fixture record refused: ${outcome.code}`);
    }

    const digested = deriveLiveQuiesceEvidenceDigest(outcome.evidence);
    if (!digested.ok) {
      throw new Error(`@moe/core refused this lane's record: ${digested.layer}/${digested.code}`);
    }
    expect(digested.quiesceRecordSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the digest is stable for one record and separates two different records", () => {
    const first = buildLiveEvidence(inputOf());
    const again = buildLiveEvidence(inputOf());
    const other = buildLiveEvidence(
      inputOf({ authority: { ...AUTHORITY, moment: "2026-08-24T11:26Z" } }),
    );
    if (!first.ok || !again.ok || !other.ok) {
      throw new Error("fixture records refused");
    }

    const a = deriveLiveQuiesceEvidenceDigest(first.evidence);
    const b = deriveLiveQuiesceEvidenceDigest(again.evidence);
    const c = deriveLiveQuiesceEvidenceDigest(other.evidence);
    if (!a.ok || !b.ok || !c.ok) {
      throw new Error("@moe/core refused a fixture record");
    }
    expect(b.quiesceRecordSha256).toBe(a.quiesceRecordSha256);
    expect(c.quiesceRecordSha256).not.toBe(a.quiesceRecordSha256);
  });
});
