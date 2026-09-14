import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { describe, expect, it } from "vitest";
import { createReplanSuccessorJournal, replanIntentKey } from "./replan-successor-journal.js";
import type { ReplanIntent } from "./replan-successor-journal.js";

const ORIGIN = "http://127.0.0.1:51847", PROJECT = "journal-widget";
function intent(suffix = "one"): ReplanIntent {
  return {
    version: "moe-replan-intent/1", origin: ORIGIN, projectId: PROJECT, phase: "DECISION_UNCERTAIN",
    predecessorGoalId: `goal-${suffix}`, nodeRef: `node-${suffix}`, reviewVersion: 3,
    planningRunRef: `run-${suffix}`, nodeKey: `slice-${suffix}`, title: "Widget",
    escalationOffer: { commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      commandId: `replan-${suffix}`, commandKind: "escalation.decide", expectedVersion: 3,
      inputSchemaVersion: "moe-review-escalation-guidance/1", targetAggregateId: `node-${suffix}` },
    createOffer: { commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      commandId: `create-${suffix}`, commandKind: "goal.create_with_source", expectedVersion: 0,
      inputSchemaVersion: "moe-daemon-bootstrap/1", targetAggregateId: `goal-create-${suffix}` },
    draft: { acceptanceCriteria: [], budgetEnvelope: "", title: "Widget · replan",
      outcome: `REPLAN of goal goal-${suffix}: node slice-${suffix} failed review 3 times and was retired.\nLiteral "decision" 😀`,
      prd: { text: "# Widget\nPreserve every criterion.", size: 34, name: "prd.md", mediaType: "text/markdown",
        localSha256: "a".repeat(64) } },
  };
}
function fixture() {
  const values = new Map<string, string>();
  let writes = 0, removals = 0, failWrite = false;
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { if (failWrite) throw new Error("quota"); writes++; values.set(key, value); },
    removeItem: (key: string) => { removals++; values.delete(key); },
  };
  const open = (origin = ORIGIN, projectId = PROJECT) => createReplanSuccessorJournal({ origin, projectId, getStorage: () => storage });
  return { values, open, storage, writes: () => writes, removals: () => removals, failWrite: () => { failWrite = true; } };
}

describe("non-authoritative replan intent journal", () => {
  it("restores an immutable exact intent after remount without credentials", () => {
    const f = fixture(), original = intent();
    expect(f.open().read()).toEqual({ status: "ABSENT" });
    expect(f.open().put(original)).toEqual({ ok: true });
    const read = f.open().read();
    expect(read).toEqual({ status: "PRESENT", intents: [original] });
    if (read.status !== "PRESENT") throw new Error("missing intent");
    expect(Object.isFrozen(read.intents)).toBe(true);
    expect(Object.isFrozen(read.intents[0]?.draft.prd)).toBe(true);
    expect(Object.isFrozen(read.intents[0]?.escalationOffer)).toBe(true);
    expect([...f.values.values()][0]).not.toMatch(/sessionCredential|credential|csrf/iu);
  });

  it("keeps origins and projects isolated, including copied foreign stored data", () => {
    const f = fixture(); expect(f.open().put(intent())).toEqual({ ok: true });
    expect(f.open("http://127.0.0.1:51848").read()).toEqual({ status: "ABSENT" });
    expect(f.open(ORIGIN, "other-project").read()).toEqual({ status: "ABSENT" });
    const key = [...f.values.keys()][0]!;
    f.values.set(key, [...f.values.values()][0]!.replaceAll(PROJECT, "other-project"));
    expect(f.open().read()).toMatchObject({ status: "INVALID" });
    const before = f.writes(); expect(f.open().put(intent()).ok).toBe(false);
    expect(f.writes()).toBe(before); expect(f.removals()).toBe(0);
  });

  it("only advances the phase of an otherwise identical saved request", () => {
    const f = fixture(), original = intent();
    expect(f.open().put(original)).toEqual({ ok: true });
    const next = { ...original, phase: "CREATE_PENDING" as const };
    expect(f.open().put(next)).toEqual({ ok: true });
    expect(f.open().put(next)).toEqual({ ok: true });
    expect(f.open().put(original)).toMatchObject({ ok: false, code: "REPLAN_JOURNAL_CONFLICT" });
    expect(f.open().put({ ...next, draft: { ...next.draft, outcome: "Different request" } }))
      .toMatchObject({ ok: false, code: "REPLAN_JOURNAL_CONFLICT" });
    expect(f.open().read()).toEqual({ status: "PRESENT", intents: [next] });
  });

  it.each([
    (v: ReplanIntent) => ({ ...v, sessionCredential: "private" }),
    (v: ReplanIntent) => ({ ...v, escalationOffer: { ...v.escalationOffer, csrf: "private" } }),
    (v: ReplanIntent) => ({ ...v, draft: { ...v.draft, credential: "private" } }),
    (v: ReplanIntent) => ({ ...v, draft: { ...v.draft, prd: { ...v.draft.prd, authorization: "private" } } }),
    (v: ReplanIntent) => ({ ...v, version: "unknown" }),
    (v: ReplanIntent) => ({ ...v, reviewVersion: -1 }),
    (v: ReplanIntent) => ({ ...v, escalationOffer: { ...v.escalationOffer, expectedVersion: 99 } }),
    (v: ReplanIntent) => ({ ...v, escalationOffer: { ...v.escalationOffer, targetAggregateId: "foreign-node" } }),
    (v: ReplanIntent) => ({ ...v, createOffer: { ...v.createOffer, commandKind: "goal.close" } }),
    (v: ReplanIntent) => ({ ...v, draft: { ...v.draft, prd: undefined } }),
    (v: ReplanIntent) => ({ ...v, draft: { ...v.draft, outcome: "\ud800" } }),
  ])("refuses malformed or authority-bearing input %# before storage", (change) => {
    const f = fixture();
    expect(f.open().put(change(intent()) as ReplanIntent)).toMatchObject({ ok: false, code: "REPLAN_JOURNAL_INVALID" });
    expect(f.writes()).toBe(0); expect(f.values.size).toBe(0);
  });

  it("bounds retained requests without discarding an older unresolved request", () => {
    const f = fixture();
    for (let n = 0; n < 8; n++) expect(f.open().put(intent(String(n)))).toEqual({ ok: true });
    expect(f.open().put(intent("ninth"))).toMatchObject({ ok: false, code: "REPLAN_JOURNAL_LIMIT" });
    const read = f.open().read(); expect(read.status).toBe("PRESENT");
    if (read.status === "PRESENT") expect(read.intents).toHaveLength(8);
  });

  it("removes only the matching intent and leaves unrelated browser keys alone", () => {
    const f = fixture(), first = intent(), second = intent("two");
    f.values.set("other-feature", "keep");
    expect(f.open().put(first)).toEqual({ ok: true }); expect(f.open().put(second)).toEqual({ ok: true });
    expect(f.open().remove(replanIntentKey(first))).toEqual({ ok: true });
    expect(f.open().read()).toEqual({ status: "PRESENT", intents: [second] });
    expect(f.open().remove(replanIntentKey(second))).toEqual({ ok: true });
    expect(f.open().read()).toEqual({ status: "ABSENT" });
    expect(f.values.get("other-feature")).toBe("keep");
  });

  it("blocks writes when durable browser storage is unavailable or rejects the save", () => {
    const missing = createReplanSuccessorJournal({ origin: ORIGIN, projectId: PROJECT,
      getStorage: () => { throw new Error("disabled"); } });
    expect(missing.read()).toMatchObject({ status: "UNAVAILABLE" });
    expect(missing.put(intent())).toMatchObject({ ok: false, code: "REPLAN_JOURNAL_UNAVAILABLE" });
    const f = fixture(); expect(f.open().put(intent())).toEqual({ ok: true });
    f.failWrite(); expect(f.open().put(intent("two"))).toMatchObject({ ok: false, code: "REPLAN_JOURNAL_UNAVAILABLE" });
    expect(f.open().read()).toEqual({ status: "PRESENT", intents: [intent()] });
  });

  it("does not silently repair malformed Unicode already present in browser storage", () => {
    const f = fixture(); expect(f.open().put(intent())).toEqual({ ok: true });
    const key = [...f.values.keys()][0]!;
    f.values.set(key, f.values.get(key)!.replace("Widget", "Widget\ud800"));
    expect(f.open().read()).toMatchObject({ status: "INVALID" });
    expect(f.open().remove(replanIntentKey(intent())).ok).toBe(false);
    expect(f.removals()).toBe(0);
  });

  it.each(["{", "[]", '[{"version":"one","version":"two"}]'])
    ("refuses unreadable stored journals without discarding them: %s", (raw) => {
      const f = fixture(); expect(f.open().put(intent())).toEqual({ ok: true });
      const key = [...f.values.keys()][0]!; f.values.set(key, raw);
      expect(f.open().read()).toMatchObject({ status: "INVALID" });
      expect(f.open().put(intent("two")).ok).toBe(false);
      expect(f.values.get(key)).toBe(raw);
    });

  it("rejects duplicate intent identities rather than selecting an arbitrary saved request", () => {
    const f = fixture(); expect(f.open().put(intent())).toEqual({ ok: true });
    const key = [...f.values.keys()][0]!; f.values.set(key, JSON.stringify([intent(), intent()]));
    expect(f.open().read()).toMatchObject({ status: "INVALID" });
  });

  it("bounds total bytes even when every individual source and brief is admissible", () => {
    const f = fixture();
    const large = (n: number): ReplanIntent => {
      const base = intent(String(n));
      return { ...base, draft: { ...base.draft, outcome: "x".repeat(16000),
        prd: { ...base.draft.prd!, text: "s".repeat(128000), size: 128000 } } };
    };
    for (let n = 0; n < 7; n++) expect(f.open().put(large(n))).toEqual({ ok: true });
    const bytes = [...f.values.values()][0];
    expect(f.open().put(large(7))).toMatchObject({ ok: false, code: "REPLAN_JOURNAL_LIMIT" });
    expect([...f.values.values()][0]).toBe(bytes);
    expect(f.open().read().status).toBe("PRESENT");
  });
});
