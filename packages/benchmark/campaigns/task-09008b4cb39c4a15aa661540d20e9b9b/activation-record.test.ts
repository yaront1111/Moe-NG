import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  GA_ACTIVATION_RECORD_SCHEMA_VERSION, GA_ACTIVATION_WORK_REF, admitActivationBinding,
} from "@moe/benchmark";
// The three surfaces below are package-internal by deliberate choice — `gate-family-resolver`,
// `claim-ladder-resolver` and `claim-ladder-contract` are not on the `@moe/benchmark` root
// surface, and publishing them to satisfy a checker would widen the package's public API for a
// test's convenience. They are reached relatively, from inside their own package.
import { PINNED_SPEC_SHA256 } from "../../src/claim-ladder-contract.js";
import { resolveReachedRung } from "../../src/claim-ladder-resolver.js";
import type { ClaimGateVerdict } from "../../src/claim-ladder-resolver.js";
import { resolveAll } from "../../src/gate-family-resolver.js";
import type { GateFamilyEvidence } from "../../src/gate-family-resolver.js";

/**
 * The campaign-owned proof for task-09008b4cb39c4a15aa661540d20e9b9b.
 *
 * IT RE-DERIVES, IT DOES NOT TRUST. Every verdict in the sibling JSON is recomputed here from
 * the production surfaces (`resolveAll`, `resolveReachedRung`, `admitActivationBinding`) over
 * evidence the record itself carries, so a hand-edited verdict cannot survive this file. The
 * record embeds its own `familyEvidence` for exactly that reason: a table nobody can re-run is
 * an assertion, not evidence.
 *
 * WHAT THE RECORD CLAIMS: nothing. It certifies NOT_ACTIVATED at rung L0 with zero permitted
 * claim sentences. This checker's applicability bound is that honesty — it THROWS if the
 * record's activation status is anything other than the two statuses the composer can emit,
 * so a future record describing a real activation cannot silently reuse this proof.
 */

const RECORD_PATH = join(import.meta.dirname, "activation-record.json");

const COMMIT_HEX = /^[0-9a-f]{40}$/;
const ADMISSIBLE_STATUSES = ["BINDING_ADMITTED_ACT_PENDING", "NOT_ACTIVATED"];

interface ActivationRecordFile {
  readonly activation: { readonly status: string; readonly refusal?: unknown };
  readonly activationRow: string;
  readonly claimSentences: readonly string[];
  readonly familyEvidence: readonly GateFamilyEvidence[];
  readonly gateFamilies: readonly { readonly familyId: string; readonly verdict: string }[];
  readonly pinnedSpecSha256: string;
  readonly reachedRung: string;
  readonly schemaVersion: string;
  readonly scopeNotEstablished: readonly string[];
  readonly sourceCommit: string;
}

const text = readFileSync(RECORD_PATH, "utf8");
const record = JSON.parse(text) as ActivationRecordFile;

/** The sibling campaign's own gate verdicts, lifted to the ladder's known roster. */
const CAMPAIGN_VERDICTS: Readonly<Record<string, ClaimGateVerdict>> = Object.freeze({
  "G-J1": "UNKNOWN", "G-L1": "UNKNOWN", "G-L2": "UNKNOWN", "G-L3": "UNKNOWN",
  "G-L3-accept": "UNKNOWN", "G-L3-budget": "UNKNOWN", "G-L3-cost": "UNKNOWN",
  "G-L3-speed": "UNKNOWN", "G-L4": "UNKNOWN", "G-L4-userstudy": "UNKNOWN",
  "G-L5": "UNKNOWN", "G-UI": "UNKNOWN", "G-overhead": "UNKNOWN",
});

describe("task-09008b4c activation record", () => {
  it("declares its own applicability: only the two statuses the composer can emit", () => {
    // If this ever throws, the record was produced by something other than
    // composeActivationRecord and none of the assertions below can be trusted about it.
    expect(ADMISSIBLE_STATUSES).toContain(record.activation.status);
    expect(record.schemaVersion).toBe(GA_ACTIVATION_RECORD_SCHEMA_VERSION);
    expect(record.activationRow).toBe(GA_ACTIVATION_WORK_REF);
  });

  it("re-resolves every gate-family verdict from the embedded evidence", () => {
    const resolved = resolveAll(record.familyEvidence);
    if (!resolved.ok) throw new Error(`embedded evidence does not resolve: ${resolved.code}`);
    expect(resolved.verdicts.map((row) => ({
      familyId: row.familyId, verdict: row.verdict,
    }))).toEqual(record.gateFamilies.map((row) => ({
      familyId: row.familyId, verdict: row.verdict,
    })));
    expect(record.gateFamilies).toHaveLength(10);
  });

  it("re-resolves the reached rung from the campaign's own verdicts", () => {
    const rung = resolveReachedRung(CAMPAIGN_VERDICTS);
    if (!rung.ok) throw new Error(`campaign verdicts do not resolve: ${rung.code}`);
    expect(rung.rung).toBe(record.reachedRung);
    expect(record.reachedRung).toBe("L0");
    // L0 licenses no sentence at all, so the record must carry none.
    expect(record.claimSentences).toEqual([]);
  });

  it("re-derives the activation refusal rather than trusting the recorded one", () => {
    const admitted = admitActivationBinding(null);
    if (admitted.ok) throw new Error("a null binding must never be admitted");
    expect(record.activation.status).toBe("NOT_ACTIVATED");
    expect(record.activation.refusal).toEqual({ code: admitted.code, layer: admitted.layer });
  });

  it("names one real commit that is an ancestor of HEAD", () => {
    expect(COMMIT_HEX.test(record.sourceCommit)).toBe(true);
    execFileSync("git", ["merge-base", "--is-ancestor", record.sourceCommit, "HEAD"], {
      encoding: "utf8", windowsHide: true,
    });
  });

  it("is pinned to the transcribed spec digest", () => {
    expect(record.pinnedSpecSha256).toBe(PINNED_SPEC_SHA256);
  });

  it("contains no activation vocabulary it is not entitled to", () => {
    // Text-level, not shape-level: this catches an ACTIVE status or a first-authoritative-command
    // field smuggled in as an extra key by a hand edit, which a typed read would drop silently.
    expect(text).not.toContain("\"ACTIVE\"");
    expect(text).not.toContain("firstAuthoritativeCommand");
    expect(record.scopeNotEstablished.length).toBeGreaterThan(0);
  });
});
