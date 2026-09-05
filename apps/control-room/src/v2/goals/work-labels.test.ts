import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { RUNTIME_COMMAND_KINDS } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import {
  CHAIN_ORDER,
  COLUMN_MEANINGS,
  DEPENDS_TOKEN_PREFIX,
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
    // A hand-spelled second witness. The seam-derived, bidirectional check lives
    // below; this one stays because two independently written rosters disagreeing
    // is a louder signal than either alone.
    expect(new Set(Object.keys(MISSING_TOKENS))).toEqual(new Set([
      "escalation", "replan", "verification", "verifier-calibration", "verifier-policy",
    ]));
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
    // The activation witness is minted from MEASURED receipts and the `policy` receipt is the
    // digest of the INSTALLED SLICE SET, so an activate with no policy installed refuses
    // ACTIVATION_POLICY_UNMEASURED. This edge is absent from COMMAND_PREREQUISITES, which is
    // exactly why CHAIN_ORDER had it backwards while this suite stayed green (task-d342a2b1).
    expect(chainRank("policy.install")).toBeLessThan(chainRank("project.activate"));
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

/**
 * ROSTER, BOTH DIRECTIONS (global rail 9). The daemon side is enumerated from the
 * EMITTING SEAM — the source text of affordance-read.ts — never from MISSING_TOKENS
 * itself. A test that iterates the label map can only ever see one direction:
 * deleting an entry shrinks its own iteration and stays green while a token the
 * daemon really emits silently loses its reading. That is exactly the hole that let
 * `replan` ship unlabelled, which this suite now catches.
 *
 * Source text rather than an import because the control room must never reach into
 * apps/daemon at runtime — the same reason work-labels.ts is a mirror. The scan is
 * anchored on the three shapes the surface actually writes tokens in, and every arm
 * asserts the scan FOUND cases, so a regex that silently matched nothing cannot pass.
 */
const AFFORDANCE_READ = readFileSync(
  resolve(process.cwd(), "..", "daemon", "src", "http", "affordance-read.ts"), "utf8",
);

/** The body of every `missing: [ ... ]` step field the surface writes. */
function missingFieldArrays(source: string): readonly string[] {
  return [...source.matchAll(/missing: \[([^\]]*)\]/gu)].map((match) => match[1] ?? "");
}

/** Quoted literals inside a `missing: [ ... ]` step field. */
function missingFieldTokens(source: string): readonly string[] {
  return missingFieldArrays(source)
    .flatMap((body) => [...body.matchAll(/"([^"]+)"/gu)].map((hit) => hit[1] ?? ""));
}

/** Quoted literals inside the verification-prerequisite array the surface freezes. */
function verificationTokens(source: string): readonly string[] {
  const block = /verificationMissing = Object\.freeze\(\[([\s\S]*?)\]\);/u.exec(source);
  if (block === null) throw new Error("verification token block not found in affordance-read.ts");
  return [...(block[1] ?? "").matchAll(/"([^"]+)"/gu)].map((hit) => hit[1] ?? "");
}

/**
 * Template-literal token prefixes, e.g. `depends:${nodeRef}`, reached the way the
 * surface actually reaches them: only through a list SPREAD INTO a `missing` field.
 * Scanning every template literal in the file is too broad — affordance-read.ts:143
 * mints the aggregate id `publish:${goalId}`, which is not a prerequisite token and
 * must not be mistaken for one.
 */
function tokenPrefixes(source: string): readonly string[] {
  const spreads = new Set([...missingFieldArrays(source)]
    .flatMap((body) => [...body.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/gu)].map((hit) => hit[1] ?? "")));
  if (spreads.size === 0) throw new Error("no list is spread into a missing field");
  const prefixes: string[] = [];
  for (const name of spreads) {
    const statement = new RegExp(`const ${name} = [^;]*;`, "u").exec(source);
    if (statement === null) throw new Error(`no declaration found for missing source ${name}`);
    prefixes.push(...[...statement[0].matchAll(/`([a-z][a-z-]*:)\$\{/gu)].map((hit) => hit[1] ?? ""));
  }
  return prefixes;
}

describe("every prerequisite token the daemon emits has a reading, and every reading a token", () => {
  it("scans real tokens out of the emitting seam rather than trusting the label map", () => {
    // THE ANTI-VACUITY GUARD: a sweep that silently found nothing would make every
    // set comparison below trivially true.
    expect(AFFORDANCE_READ.length).toBeGreaterThan(1000);
    expect(missingFieldTokens(AFFORDANCE_READ).length).toBeGreaterThan(0);
    expect(verificationTokens(AFFORDANCE_READ).length).toBeGreaterThan(0);
    expect(tokenPrefixes(AFFORDANCE_READ).length).toBeGreaterThan(0);
  });

  it("maps exactly the EXACT tokens the surface emits — set equality, both directions", () => {
    const emitted = new Set([
      ...missingFieldTokens(AFFORDANCE_READ), ...verificationTokens(AFFORDANCE_READ),
    ]);
    // Independently spelled, so a scanner that drifted cannot quietly agree with itself.
    expect(emitted).toEqual(new Set([
      "escalation", "replan", "verification", "verifier-calibration", "verifier-policy",
    ]));
    // DIRECTION 1 — every emitted token has a reading that is not the raw token.
    for (const token of emitted) {
      expect(MISSING_TOKENS[token]).toBeDefined();
      expect(labelForMissing(token)).not.toBe(token);
    }
    // DIRECTION 2 — every reading corresponds to a token the surface can emit.
    expect(new Set(Object.keys(MISSING_TOKENS))).toEqual(emitted);
  });

  it("reads the one PREFIXED token, which no exact-match map could hold", () => {
    const prefixes = new Set(tokenPrefixes(AFFORDANCE_READ));
    expect(prefixes).toEqual(new Set([DEPENDS_TOKEN_PREFIX]));
    // The prefix is not, and must not become, an exact key.
    expect(MISSING_TOKENS[DEPENDS_TOKEN_PREFIX]).toBeUndefined();
    expect(labelForMissing(`${DEPENDS_TOKEN_PREFIX}node-a`))
      .toBe("the node node-a to be accepted first");
  });
});

describe("work-labels reads a dependency block in the operator's words", () => {
  it("names the blocking node inside the sentence the board actually renders", () => {
    // The rendered sentence, not just the fragment: work-board.tsx:69 prefixes
    // "needs " and joins with ", ", so this is what an operator reads on the card.
    const missing = ["depends:node-kernel", "verification"];
    expect(`needs ${missing.map(labelForMissing).join(", ")}`)
      .toBe("needs the node node-kernel to be accepted first, the daemon's verification");
  });

  it("echoes the node key exactly as the daemon spelled it", () => {
    expect(labelForMissing("depends:node-a")).toContain("node-a");
    expect(labelForMissing("depends:Node_B-2")).toBe("the node Node_B-2 to be accepted first");
    // Two different nodes must not read as the same blocker.
    expect(labelForMissing("depends:node-a")).not.toBe(labelForMissing("depends:node-b"));
  });

  it("keeps the raw fall-through, which is load-bearing honesty", () => {
    // An unknown token is never dressed up as a sentence.
    expect(labelForMissing("totally.made.up")).toBe("totally.made.up");
    expect(labelForMissing("dependsOn:node-a")).toBe("dependsOn:node-a");
    // A prefix naming NO node identifies nothing, so it stays raw too.
    expect(labelForMissing("depends:")).toBe("depends:");
  });

  it("gives the replan token words instead of leaking the raw token", () => {
    // goal-status.ts:77 already branches on this token, so the board knew about it
    // while the label map did not — it rendered as the bare word "replan".
    expect(labelForMissing("replan"))
      .toBe("a human's REPLAN decision, which retires this node into the successor plan");
  });
});
