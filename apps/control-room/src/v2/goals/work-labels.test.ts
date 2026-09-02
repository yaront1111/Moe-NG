import { RUNTIME_COMMAND_KINDS } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import {
  CHAIN_ORDER,
  COLUMN_MEANINGS,
  MISSING_TOKENS,
  WORK_KIND_LABELS,
  cardIdentity,
  chainRank,
  columnFor,
  isIdentityPerRead,
  labelForKind,
  labelForMissing,
} from "./work-labels.js";

/**
 * work-labels.ts is a MIRROR of the closed command vocabulary the daemon's
 * affordance surface emits as a step kind, and nothing else. This suite pins the
 * mirror: every kind the surface can emit has a plain-language label, every one
 * that is a real RuntimeCommandKind is checked against the contract package
 * itself, and a kind outside the mirror is passed through verbatim rather than
 * given an invented name.
 *
 * The emitted set is exactly 14 (verified in apps/daemon/src/http/affordance-read.ts):
 * the ten BOOTSTRAP_COMMAND_KINDS (bootstrap-contracts.ts:29-41), session.open /
 * session.close / session.renew (affordance-read.ts:267-294) and the daemon-local
 * NODE_DELIVER_KIND "node.deliver" (affordance-contract.ts:25). `review.submit`
 * is only ever an OFFER, never a step kind, so it is deliberately absent.
 */

const EMITTED_KINDS: readonly string[] = Object.freeze([
  "approval.decide",
  "goal.close",
  "goal.create",
  "node.deliver",
  "plan.propose",
  "policy.install",
  "policy.validate",
  "project.activate",
  "project.bind_repository",
  "project.register",
  "provider.probe",
  "session.close",
  "session.open",
  "session.renew",
]);

const RUNTIME_KINDS: ReadonlySet<string> = new Set<string>(RUNTIME_COMMAND_KINDS);

describe("work-labels mirrors the daemon's emitted command kinds", () => {
  it("gives every kind the surface emits as a step a plain-language label", () => {
    for (const kind of EMITTED_KINDS) {
      const reading = labelForKind(kind);
      expect(reading.known, kind).toBe(true);
      expect(reading.label, kind).not.toBe(kind);
      expect(reading.label.length, kind).toBeGreaterThan(0);
    }
    expect(Object.keys(WORK_KIND_LABELS).sort()).toEqual([...EMITTED_KINDS].sort());
  });

  it("pins the mirror against the contract package's own closed vocabulary", () => {
    for (const kind of EMITTED_KINDS) {
      if (kind === "node.deliver") continue;
      expect(RUNTIME_KINDS.has(kind), kind).toBe(true);
    }
    // node.deliver is the daemon-local NODE_DELIVER_KIND, not a runtime command
    // kind. Pinning that here documents why the map is keyed by string.
    expect(RUNTIME_KINDS.has("node.deliver")).toBe(false);
  });

  it("passes an unmapped kind through verbatim and never invents a label", () => {
    // No `group`: a category ("Project setup", "Other") is not something the
    // daemon says, so the reading carries none - toEqual reds on an extra key.
    expect(labelForKind("node.plan")).toEqual({
      identityPerRead: false, known: false, label: "node.plan",
    });
    expect(labelForKind("project.register")).toEqual({
      identityPerRead: false, known: true, label: "Register the project",
    });
    expect(labelForKind("totally.made.up").label).toBe("totally.made.up");
    expect(labelForKind("totally.made.up").known).toBe(false);
  });

  it("translates the daemon's own prerequisite tokens, raw for anything else", () => {
    expect(labelForMissing("verification")).toBe("the daemon's verification");
    expect(labelForMissing("verifier-policy")).toBe(
      "the host verifier policy slice (moe-verifier-policy/1) an operator installs with policy.install",
    );
    expect(labelForMissing("verifier-calibration")).toBe(
      "the reviewer calibration slice (moe-reviewer-calibration/1) an operator installs with policy.install",
    );
    expect(labelForMissing("project.register")).toBe("Register the project");
    expect(labelForMissing("provider.probe")).toBe("Probe the model provider");
    expect(labelForMissing("budget approved")).toBe("budget approved");
    expect(labelForMissing("goal.binding")).toBe("goal.binding");
  });

  it("lists exactly the prerequisite tokens the daemon emits", () => {
    expect(new Set(Object.keys(MISSING_TOKENS)))
      .toEqual(new Set(["escalation", "verification", "verifier-calibration", "verifier-policy"]));
  });
});

describe("work-labels orders a column by the daemon's real prerequisite chain", () => {
  it("covers exactly the mapped kinds, once each", () => {
    expect(new Set(CHAIN_ORDER)).toEqual(new Set(Object.keys(WORK_KIND_LABELS)));
    expect(CHAIN_ORDER.length).toBe(14);
    expect(new Set(CHAIN_ORDER).size).toBe(CHAIN_ORDER.length);
  });

  it("ranks a prerequisite before the kind that needs it", () => {
    // COMMAND_PREREQUISITES (apps/daemon/src/bootstrap/bootstrap-sequence.ts:18-34).
    expect(chainRank("project.register")).toBeLessThan(chainRank("project.bind_repository"));
    expect(chainRank("project.register")).toBeLessThan(chainRank("provider.probe"));
    expect(chainRank("project.bind_repository")).toBeLessThan(chainRank("project.activate"));
    expect(chainRank("project.activate")).toBeLessThan(chainRank("goal.create"));
    expect(chainRank("goal.create")).toBeLessThan(chainRank("plan.propose"));
    expect(chainRank("plan.propose")).toBeLessThan(chainRank("approval.decide"));
    expect(chainRank("approval.decide")).toBeLessThan(chainRank("goal.close"));
    expect(chainRank("policy.install")).toBeLessThan(chainRank("policy.validate"));
  });

  it("sorts an unknown kind last rather than guessing where it belongs", () => {
    expect(chainRank("node.plan")).toBe(CHAIN_ORDER.length);
    expect(chainRank("zeta.x")).toBe(CHAIN_ORDER.length);
  });
});

describe("work-labels keeps a card's identity stable across a poll", () => {
  it("flags only the kind whose target the daemon mints on every read", () => {
    // affordance-read.ts:209 mints `goal-${config.mintId()}` on every READY read.
    expect(isIdentityPerRead("goal.create")).toBe(true);
    expect(labelForKind("goal.create").identityPerRead).toBe(true);
    for (const kind of EMITTED_KINDS) {
      if (kind === "goal.create") continue;
      expect(isIdentityPerRead(kind), kind).toBe(false);
    }
    expect(isIdentityPerRead("node.plan")).toBe(false);
  });

  it("gives goal.create one identity across two reads with different minted ids", () => {
    const first = cardIdentity("goal.create", "goal-b8ae16be-2c20-4867-80c2-1248934cc218");
    const second = cardIdentity("goal.create", "goal-383abb30-f684-4edd-8bc1-a0216a60ac9e");
    expect(first).toBe(second);
    expect(first).toBe("goal.create");
  });

  it("keeps a durable kind's identity bound to the aggregate the daemon named", () => {
    expect(cardIdentity("session.renew", "session/a")).toBe("session.renew@session/a");
    expect(cardIdentity("session.renew", "session/b")).toBe("session.renew@session/b");
    expect(cardIdentity("plan.propose", null)).toBe("plan.propose@-");
  });
});

describe("work-labels names what each column means, in the owner's words", () => {
  it("carries one plain meaning per surface status, with the raw token kept", () => {
    expect(COLUMN_MEANINGS.map((column) => column.status)).toEqual(["READY", "BLOCKED", "COMMITTED"]);
    expect(COLUMN_MEANINGS.map((column) => column.key)).toEqual(["ready", "blocked", "committed"]);
    for (const column of COLUMN_MEANINGS) {
      expect(column.title, column.key).not.toBe(column.status);
      expect(column.meaning.length, column.key).toBeGreaterThan(10);
      expect(column.title.toLowerCase(), column.key).not.toContain("step");
      expect(column.empty.toLowerCase(), column.key).not.toContain("step");
    }
  });

  it("says offered / waiting / recorded rather than READY / BLOCKED / COMMITTED", () => {
    expect(columnFor("READY").title).toBe("Offered now");
    expect(columnFor("BLOCKED").title).toBe("Waiting on something");
    expect(columnFor("COMMITTED").title).toBe("Already recorded");
    // READY is the daemon's token for "prerequisites met, not yet recorded"
    // (affordance-read.ts: every READY row carries missing: []). It does NOT say
    // the daemon would accept THIS kind: for a node.deliver row the offer the
    // daemon pushes is review.submit, so "would accept this command" overclaimed.
    expect(columnFor("READY").meaning).toBe("The daemon says this can happen now: nothing it needs is missing.");
    expect(columnFor("BLOCKED").meaning).toBe("Not offered yet: something this command needs has not happened.");
    expect(columnFor("COMMITTED").meaning).toBe("Already written into the daemon's own record.");
  });
});
