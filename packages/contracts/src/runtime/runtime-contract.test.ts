import { Worker } from "node:worker_threads";

import { describe, expect, it } from "vitest";

import {
  EMPTY_NEXT_ALLOWED_COMMANDS,
  RUNTIME_AGGREGATES,
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  RUNTIME_COMMAND_KINDS,
  RUNTIME_ERROR_REGISTRY_VERSION,
  RUNTIME_LIFECYCLES,
  RUNTIME_QUERY_ENVELOPE_VERSION,
  RUNTIME_QUERY_KINDS,
  RUNTIME_TELEMETRY_KINDS,
  buildNextAllowedCommands,
  freshRuntimeResult,
  historicalRuntimeResult,
} from "@moe/contracts";
import type { NextAllowedCommand } from "@moe/contracts";

// `isCommandKind` is deliberately not published from the root barrel, so the guard arm below
// reaches it through the defining module rather than re-implementing the membership test.
import {
  FOUNDATION_DISPATCH_COMMAND_KIND,
  FOUNDATION_VERIFICATION_COMMAND_KIND,
  isCommandKind,
} from "./runtime-vocabulary.js";

/**
 * Hand-transcribed, NOT derived from RUNTIME_COMMAND_KINDS: an expectation computed from the
 * tuple under test can never fail, which is what the previous `commands.size ===
 * RUNTIME_COMMAND_KINDS.length` arm did. Adding, removing or misspelling a command kind must
 * force a deliberate edit here, exactly as the query and telemetry rosters already require.
 */
const EXPECTED_COMMAND_KINDS = [
  "approval.decide", "approval.decide_intent", "blocker.challenge", "blocker.open",
  "blocker.resolve",
  "budget.acknowledge_unknown_liability", "budget.conservative_settle", "budget.propose_raise",
  "budget.reconcile", "context.repackage", "cutover.abort", "cutover.activate",
  "cutover.preview", "cutover.quiesce", "dependency.challenge",
  "deployment.deploy", "deployment.set_target", "effect.activate",
  "effect.adopt_result", "effect.confirm_absent", "effect.observe", "effect.reconcile",
  "environment.set_variable", "environment.unset_variable",
  "escalation.decide", "events.resume", "evidence.rerun", "evidence.run", "expansion.decline", "export.run",
  "finding.route", "foundation.dispatch", "foundation.verification",
  "goal.cancel", "goal.close", "goal.create", "goal.create_with_source", "goal.pause",
  "goal.reopen_as_revision", "goal.resume", "graph.approve", "graph.prepare_supersession",
  "graph.release_preparation", "graph.request_expansion", "graph.supersede",
  "integration.accept_output", "integration.resolve_finding", "integration.seal",
  "integration.start", "integration.submit_finding", "journal.append", "lease.confirm_revoke",
  "lease.extend", "lease.mark_suspect", "plan.propose", "planning.cancel", "planning.claim",
  "planning.recover_absent", "planning.release", "planning.submit_decomposition",
  "policy.install", "policy.validate", "preview.decide",
  "product_contract.answer_clarification", "product_contract.approve_gate_1",
  "product_contract.ask_clarification", "product_contract.propose_revision",
  "profile.register", "project.activate",
  "project.bind_repository", "project.register",
  "provider.probe", "qualification.cancel", "qualification.recover", "qualification.replan",
  "qualification.retry", "quarantine.discard", "quarantine.export_forensic",
  "reconciliation.decide", "recovery.complete", "recovery.inspect_external",
  "recovery.reconcile_external", "release.decide", "replan.propose_unblock", "repository.bootstrap",
  "repository.publish", "resource.confirm_released",
  "resource.reconcile", "resource.release", "resource.renew", "resource.request",
  "review.release", "review.start", "review.submit", "safe_boundary.observe",
  "session.close", "session.open", "session.renew", "session.rotate", "step.checkpoint",
  "step.finish", "step.start", "wait.cancel", "wait.declare", "wait.extend", "work.cancel",
  "work.claim", "work.release", "work.renew", "work.resume",
];

const SOURCE = Object.freeze({ aggregate: "GOAL", state: "EXECUTION_ENABLED" });

function entry(commandKind: string, commandId: string): Record<string, unknown> {
  return {
    commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    commandId,
    commandKind,
    expectedVersion: 7,
    inputSchemaVersion: `${commandKind}/1`,
    targetAggregateId: "goal-1",
  };
}

function kinds(list: readonly NextAllowedCommand[]): readonly string[] {
  return list.map((item) => `${item.commandKind}:${item.commandId}`);
}

describe("runtime vocabulary is closed and disjoint", () => {
  it("pins the selected schema literals", () => {
    expect(RUNTIME_COMMAND_ENVELOPE_VERSION).toBe("moe-runtime-command/1");
    expect(RUNTIME_QUERY_ENVELOPE_VERSION).toBe("moe-runtime-query/1");
    expect(RUNTIME_ERROR_REGISTRY_VERSION).toBe("moe-runtime-error-registry/1");
  });

  it("keeps queries, commands, and telemetry disjoint and frozen", () => {
    const commands = new Set<string>(RUNTIME_COMMAND_KINDS);
    expect(RUNTIME_QUERY_KINDS).toEqual([
      "budget.get", "dependency.explain", "doctor.get", "documents.source_read", "events.read",
      "events.wait", "evidence.get", "frontier.get", "goal.get", "goal.list", "graph.get",
      "graph.preview", "product_contract.read", "project.get", "quarantine.get", "reconciliation.get",
      "scheduler.readiness_explain", "work.get_context",
    ]);
    expect(RUNTIME_TELEMETRY_KINDS).toEqual(["presence.ping"]);
    for (const kind of [...RUNTIME_QUERY_KINDS, ...RUNTIME_TELEMETRY_KINDS]) {
      expect(commands.has(kind)).toBe(false);
    }
    expect(RUNTIME_COMMAND_KINDS).toEqual(EXPECTED_COMMAND_KINDS);
    // Literal 110, not `RUNTIME_COMMAND_KINDS.length`: a duplicated member shrinks the set only.
    expect(commands.size).toBe(110);
    expect(RUNTIME_COMMAND_KINDS).toContain("plan.propose");
    expect(RUNTIME_COMMAND_KINDS).toContain("graph.prepare_supersession");
    expect(RUNTIME_COMMAND_KINDS).toContain("foundation.dispatch");
    expect(RUNTIME_COMMAND_KINDS).toContain("foundation.verification");
    for (const tuple of [RUNTIME_COMMAND_KINDS, RUNTIME_QUERY_KINDS, RUNTIME_AGGREGATES]) {
      expect(Object.isFrozen(tuple)).toBe(true);
    }
  });

  /**
   * DoD 2 of task-ad61563a, and the arm its first delivery lacked. EXPECTED_COMMAND_KINDS above is
   * order-sensitive but it is transcribed BY hand FROM the tuple, so a member inserted at the wrong
   * position is copied into the roster and both stay green — which is exactly how
   * `product_contract.approve_gate_1` first landed between `profile.register` and
   * `project.activate`. Sortedness is therefore asserted against the production tuple itself, the
   * one surface a mistranscription cannot follow.
   */
  it("keeps every command kind at its sorted position", () => {
    const sorted = [...RUNTIME_COMMAND_KINDS].sort();
    const mismatch = RUNTIME_COMMAND_KINDS.findIndex((kind, index) => kind !== sorted[index]);
    expect(
      mismatch === -1
        ? null
        : {
            actual: RUNTIME_COMMAND_KINDS[mismatch],
            expected: sorted[mismatch],
            index: mismatch,
          },
    ).toBeNull();
    // Pinned by neighbour, not by absolute index: an unrelated insertion elsewhere in the tuple
    // must not red this arm for a reason that has nothing to do with this kind.
    const position = RUNTIME_COMMAND_KINDS.indexOf("product_contract.approve_gate_1");
    expect(position).toBeGreaterThan(-1);
    // The compiler family (task rows 5-7 of the operator-approved PRD plan)
    // brackets the gate kind: answer < approve < ask < propose, all sorted.
    expect(RUNTIME_COMMAND_KINDS[position - 1]).toBe("product_contract.answer_clarification");
    expect(RUNTIME_COMMAND_KINDS[position + 1]).toBe("product_contract.ask_clarification");
    expect(RUNTIME_COMMAND_KINDS[position + 2]).toBe("product_contract.propose_revision");
    // task-c672815d: `preview.decide` now takes the slot between `policy.validate` and the
    // product_contract family ("policy" < "preview" < "product"), so the left bracket moved out
    // by one. Both neighbours stay pinned: the new kind's own sorted slot is asserted here
    // because the generator sorts its copy and therefore cannot catch a misplaced source tuple.
    expect(RUNTIME_COMMAND_KINDS[position - 2]).toBe("preview.decide");
    expect(RUNTIME_COMMAND_KINDS[position - 3]).toBe("policy.validate");
    // task-b7f71ffe: `goal.create_with_source` is pinned the same way. `goal.create` is a strict
    // prefix of it, so the sorted slot is immediately after `goal.create` and before `goal.pause`
    // ("c" < "p"). The generator sorts before it emits, so no generated-side gate can catch a
    // misplaced source tuple — only this arm, read off the production tuple itself, can.
    const sourcePosition = RUNTIME_COMMAND_KINDS.indexOf("goal.create_with_source");
    expect(sourcePosition).toBeGreaterThan(-1);
    expect(RUNTIME_COMMAND_KINDS[sourcePosition - 1]).toBe("goal.create");
    expect(RUNTIME_COMMAND_KINDS[sourcePosition + 1]).toBe("goal.pause");
  });

  it("admits both Foundation kinds through isCommandKind and refuses lookalikes", () => {
    expect(isCommandKind("foundation.dispatch")).toBe(true);
    expect(isCommandKind("foundation.verification")).toBe(true);
    expect(isCommandKind(FOUNDATION_DISPATCH_COMMAND_KIND)).toBe(true);
    expect(isCommandKind(FOUNDATION_VERIFICATION_COMMAND_KIND)).toBe(true);
    expect(FOUNDATION_DISPATCH_COMMAND_KIND).toBe("foundation.dispatch");
    expect(FOUNDATION_VERIFICATION_COMMAND_KIND).toBe("foundation.verification");
    // Neighbouring strings stay out: membership is exact, not prefix- or fuzzy-matched.
    for (const lookalike of [
      "foundation.verify", "foundation.dispatch ", "Foundation.dispatch", "foundation",
      "foundation.dispatch.v2",
    ]) {
      expect(isCommandKind(lookalike), `${lookalike} must not be a command kind`).toBe(false);
    }
  });

  it("closes every lifecycle tuple named by the design", () => {
    for (const aggregate of RUNTIME_AGGREGATES) {
      const states = RUNTIME_LIFECYCLES[aggregate];
      expect(Object.isFrozen(states)).toBe(true);
      expect(states.length).toBeGreaterThan(0);
      expect(new Set<string>(states).size).toBe(states.length);
    }
    expect(RUNTIME_LIFECYCLES.GOAL).toEqual([
      "DRAFT", "EXECUTION_ENABLED", "CLOSING", "COMPLETED", "CANCELLED",
    ]);
    expect(RUNTIME_LIFECYCLES.PROJECT).toEqual([
      "BOOTSTRAPPING", "READY", "DEGRADED", "QUIESCED",
    ]);
    expect(RUNTIME_LIFECYCLES.LEASE).toEqual([
      "ACTIVE", "SUSPECT", "DRAINING", "RELEASED", "REVOKED",
    ]);
    expect(RUNTIME_LIFECYCLES.CUTOVER).toContain("ACTIVATE_APPROVED");
    expect(RUNTIME_LIFECYCLES.PLANNING_RUN).toContain("SUBMISSION_DRAINING");
    expect(RUNTIME_LIFECYCLES.TRUTH_CLASS).toContain("UNKNOWN");
  });
});

describe("nextAllowedCommands grants no unknown authority", () => {
  it("sorts by commandKind then commandId and deeply freezes", () => {
    const built = buildNextAllowedCommands(SOURCE, [
      entry("work.claim", "b"), entry("goal.pause", "z"), entry("goal.pause", "a"),
    ]);
    expect(kinds(built)).toEqual(["goal.pause:a", "goal.pause:z", "work.claim:b"]);
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built[0])).toBe(true);
    expect(built[0]?.commandEnvelopeVersion).toBe(RUNTIME_COMMAND_ENVELOPE_VERSION);
  });

  it("carries optional lease and revision bindings only when fully formed", () => {
    const lease = {
      attemptBindingVersion: 2, authorityHash: "b".repeat(64), epoch: 4, graphEpoch: 3,
      leaseToken: "lease-1",
    };
    const full = { ...entry("work.claim", "a"), graphRevisionHash: "c".repeat(64), leaseAuthority: lease };
    const built = buildNextAllowedCommands(SOURCE, [full]);
    expect(built[0]?.leaseAuthority).toEqual(lease);
    expect(Object.isFrozen(built[0]?.leaseAuthority)).toBe(true);
    const partial = { ...entry("work.claim", "a"), leaseAuthority: { leaseToken: "lease-1" } };
    expect(buildNextAllowedCommands(SOURCE, [partial])).toEqual([]);
  });

  it("refuses duplicates, non-commands, and malformed entries without partial authority", () => {
    const duplicate = [entry("goal.pause", "a"), entry("goal.cancel", "a")];
    expect(buildNextAllowedCommands(SOURCE, duplicate)).toEqual([]);
    for (const bad of ["graph.preview", "events.wait", "goal.get", "presence.ping", "nope", ""]) {
      expect(buildNextAllowedCommands(SOURCE, [entry("goal.pause", "a"), entry(bad, "b")]))
        .toEqual([]);
    }
    for (const patch of [
      { expectedVersion: -1 }, { expectedVersion: 1.5 }, { expectedVersion: "7" },
      { commandId: "" }, { extra: 1 }, { inputSchemaVersion: 1 },
      { commandEnvelopeVersion: "moe-runtime-command/2" }, { targetAggregateId: "" },
    ]) {
      expect(buildNextAllowedCommands(SOURCE, [{ ...entry("goal.pause", "a"), ...patch }]))
        .toEqual([]);
    }
    expect(buildNextAllowedCommands(SOURCE, "not-an-array")).toBe(EMPTY_NEXT_ALLOWED_COMMANDS);
    expect(buildNextAllowedCommands(SOURCE, [null])).toEqual([]);
  });

  it("returns the shared frozen empty set for any unknown lifecycle source", () => {
    for (const source of [
      { aggregate: "GOAL", state: "NOT_A_STATE" }, { aggregate: "NOPE", state: "DRAFT" },
      { aggregate: "GOAL", state: "EXECUTION_ENABLED", extra: 1 },
      null, undefined, "GOAL", { aggregate: "GOAL" },
    ]) {
      expect(buildNextAllowedCommands(source, [entry("goal.pause", "a")]))
        .toBe(EMPTY_NEXT_ALLOWED_COMMANDS);
    }
    expect(Object.isFrozen(EMPTY_NEXT_ALLOWED_COMMANDS)).toBe(true);
    expect(EMPTY_NEXT_ALLOWED_COMMANDS).toEqual([]);
  });

  it("fails closed on revoked proxies instead of throwing", () => {
    const source = Proxy.revocable({}, {});
    const entries = Proxy.revocable([], {});
    const item = Proxy.revocable({}, {});
    source.revoke();
    entries.revoke();
    item.revoke();
    const known = { aggregate: "GOAL", state: "DRAFT" };
    expect(() => buildNextAllowedCommands(source.proxy, [])).not.toThrow();
    expect(buildNextAllowedCommands(source.proxy, [])).toBe(EMPTY_NEXT_ALLOWED_COMMANDS);
    expect(buildNextAllowedCommands(known, entries.proxy)).toBe(EMPTY_NEXT_ALLOWED_COMMANDS);
    expect(buildNextAllowedCommands(known, [item.proxy])).toBe(EMPTY_NEXT_ALLOWED_COMMANDS);
  });

  it("omits affordances from historical results and flags refresh", () => {
    const fresh = freshRuntimeResult(SOURCE, [entry("goal.pause", "a")]);
    expect(fresh).toMatchObject({ historical: false, requiresAffordanceRefresh: false });
    expect(kinds(fresh.nextAllowedCommands)).toEqual(["goal.pause:a"]);
    expect(Object.isFrozen(fresh)).toBe(true);
    const replay = historicalRuntimeResult();
    expect(replay).toMatchObject({ historical: true, requiresAffordanceRefresh: true });
    expect(replay.nextAllowedCommands).toBe(EMPTY_NEXT_ALLOWED_COMMANDS);
    expect(Object.isFrozen(replay)).toBe(true);
  });
});

it("loads the runtime contracts in Node's strip-types runtime", async () => {
  const payload = await new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(new URL("./runtime-entrypoint-smoke-worker.mjs", import.meta.url), {
      execArgv: ["--experimental-strip-types"],
    });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`runtime smoke worker exited with ${code}`));
    });
  });

  expect(payload).toEqual({
    affordanceKinds: ["goal.pause"],
    commandEnvelopeVersion: "moe-runtime-command/1",
    outcome: "IMPORTED",
    queryOk: true,
    unknownErrorCode: "UNKNOWN_ERROR",
    unknownSourceIsEmpty: true,
  });
});
