import { describe, expect, it } from "vitest";

import {
  APPROVAL_INTENT_FAMILY,
  BOOTSTRAP_FAMILY, CAPABILITIES, COMPILER_FAMILY, GRAPH_FAMILY,
  GRAPH_MUTATION_COMMAND_KINDS,
  OPERATOR_CAPABILITIES, OPERATOR_PRINCIPAL_KINDS,
  PAYLOAD_KEYS, REVIEW_FAMILY, SESSION_FAMILY, STEP_FAMILY, WORK_FAMILY,
  agentCapabilitiesFor, type WiredCommandKind,
} from "./daemon-command-vocabulary.js";

/**
 * Content characterization of the extracted command vocabulary. Every expectation
 * below is a LITERAL, transcribed by hand from the mapping measured on the registry
 * before it was split; nothing is read back out of the tables under test, so a payload
 * key that loses a character, a capability that swaps family or a kind that is dropped
 * reddens a named case instead of regenerating its own expectation.
 *
 * `daemon-command-registry.test.ts` asserts the same mapping from the far side, through
 * the registry the HTTP seam actually serves. This file asserts it at the source, which
 * is where the next command kind will be registered.
 */
type Family =
  | "APPROVAL_INTENT" | "BOOTSTRAP" | "COMPILER" | "GRAPH" | "REVIEW" | "SESSION"
  | "STANDALONE" | "STEP" | "WORK";

interface VocabularyRow {
  readonly agent: readonly string[] | null;
  readonly capability: string;
  readonly family: Family;
  readonly kind: WiredCommandKind;
  readonly payloadKeys: readonly string[];
}

const ADMIN = "project.admin";
const GOAL = "goal.write";
const PLANNING = "planning.write";
const REVIEW = "review.write";
const WORK = "work.write";

/**
 * In PAYLOAD_KEYS insertion order, which is the order `buildCommandRegistry` fills its
 * Map in. Alphabetical would agree with a reshuffled table; this does not.
 */
const ROWS: readonly VocabularyRow[] = [
  { agent: [PLANNING, WORK], capability: PLANNING, family: "BOOTSTRAP",
    kind: "approval.decide",
    payloadKeys: ["activation", "command", "graphRevisionRef", "record", "runId"] },
  // task-6646f888. The SAME authority as approval.decide on a different wire, so it carries
  // approval.decide's capability exactly: a narrower or wider one here would make the wire the
  // fence instead of the principal. What makes it human-only is OPERATOR_ONLY below. The four
  // keys are human-authored identity and intent; authority remains unrepresentable by construction.
  { agent: [PLANNING, WORK], capability: PLANNING, family: "APPROVAL_INTENT",
    kind: "approval.decide_intent",
    payloadKeys: ["decision", "decisionReason", "dependencyChanges", "runId"] },
  // THE PRD COMPILER LANE (four kinds, one family, all PLANNING): contract authorship and
  // decomposition are planning acts on their own wires. The payload rosters are SPREAD from
  // each seam's own constant in production; the literals here are the drift alarm.
  { agent: [PLANNING, WORK], capability: PLANNING, family: "COMPILER",
    kind: "planning.submit_decomposition",
    payloadKeys: ["gateRef", "goalRef", "structure"] },
  // HUMAN wire: `agent` is null (never staffable) and OPERATOR_ONLY below is the fence.
  // The operator ANSWERS a material product question; an agent transport presenting that
  // answer would be quiet invention with a human label.
  { agent: null, capability: PLANNING, family: "COMPILER",
    kind: "product_contract.answer_clarification",
    payloadKeys: ["answerProjectionDigest", "clarificationId", "contractId"] },
  { agent: [PLANNING, WORK], capability: PLANNING, family: "COMPILER",
    kind: "product_contract.ask_clarification",
    payloadKeys: ["contractId", "options", "question"] },
  { agent: [PLANNING, WORK], capability: PLANNING, family: "COMPILER",
    kind: "product_contract.propose_revision",
    payloadKeys: ["draft", "goalRef"] },
  { agent: null, capability: WORK, family: "STANDALONE", kind: "events.resume",
    payloadKeys: ["presentedCursor", "projection", "subscriberId"] },
  { agent: [WORK], capability: WORK, family: "STANDALONE", kind: "work.resume",
    payloadKeys: ["attemptRef", "successorRef"] },
  { agent: [WORK], capability: WORK, family: "STANDALONE", kind: "effect.activate",
    payloadKeys: ["activation", "effect", "lease", "liveClaims", "slot"] },
  { agent: [ADMIN, WORK], capability: ADMIN, family: "STANDALONE", kind: "recovery.complete",
    payloadKeys: ["approval", "authentication", "command", "reconciliationDigest"] },
  // task-7997ba7c. ADMIN mirrors recovery.complete exactly: it is the REACH fence, and the
  // human-only fence is the signed single-use session presentation the payload carries. It is
  // deliberately NOT operator-gated for the same reason recovery.complete is not: the human is
  // proven by the session proof, not by holding the daemon's configured operator credential.
  { agent: [ADMIN, WORK], capability: ADMIN, family: "STANDALONE",
    kind: "product_contract.approve_gate_1",
    payloadKeys: ["authentication", "contractId", "revisionDigest", "revisionId"] },
  // STANDALONE and WORK-capable: the agent holding the attempt's lease is exactly
  // who records why an approach failed, so this is never operator-gated.
  { agent: [WORK], capability: WORK, family: "STANDALONE", kind: "journal.append",
    payloadKeys: ["attemptAggregateId", "effectId", "entries"] },
  // Its service is asynchronous, so it is wired by the registry's own branch and belongs
  // to no family map. The base64 field is named in the allow-list or the whole request is
  // refused: a payload key that is not listed is never trimmed.
  { agent: [WORK], capability: WORK, family: "STANDALONE", kind: "foundation.dispatch",
    // NARROWED TO TWO: the graph snapshot, the input manifest AND the launch template are
    // all derived server-side, so a payload carrying any of those keys is refused at the
    // seam rather than admitted. Only which activation and which attempt still cross.
    payloadKeys: ["activationRequestBytesBase64", "binding"] },
  // Also asynchronous, also STANDALONE, and WORK-only rather than operator-gated: every
  // authority the verifier trusts is server-side sealed state and the payload only NAMES
  // which verification, so the human gate on this path is recipe sealing.
  { agent: [WORK], capability: WORK, family: "STANDALONE", kind: "foundation.verification",
    payloadKeys: [
      "attemptAggregateId", "candidateRoot", "expectedRecordDigest", "recipeAggregateId",
      "verificationId",
    ] },
  // The attempt's OWN authority over its OWN resources, and STANDALONE for the same reason
  // journal.append is: it belongs to no family map and is wired by the registry's own branch.
  // The allow-list is identity plus one adapter observation -- no state, no terminal flag.
  { agent: [WORK], capability: WORK, family: "STANDALONE", kind: "resource.reconcile",
    payloadKeys: ["activationAggregateId", "disposition", "epoch", "kind", "resourceId"] },
  // OPERATOR-ONLY and ADMIN-capable, unlike its resource.reconcile sibling. The
  // attempt reports what its adapter observed; a PROVEN RELEASE is a human's evidence
  // that a quarantined resource is genuinely free, so the attempt may not clear its own
  // quarantine. ADMIN is the reach fence and the configured operator identity is the
  // human-only one; the allow-list is identity plus a proof REFERENCE -- no resource id,
  // no state, no terminal flag.
  { agent: [ADMIN, WORK], capability: ADMIN, family: "STANDALONE",
    kind: "resource.confirm_released",
    payloadKeys: ["activationAggregateId", "proofRef"] },
  // The attempt reports its OWN step boundary, the same attempt-as-authenticated-reporter
  // grant journal.append and resource.reconcile carry. Three keys each: no ordinal, no
  // truthClass, no completed state and no roster replacement, so the daemon decides every
  // fact the durable record carries and ADMIN would fence reach without fencing anything.
  { agent: [WORK], capability: WORK, family: "STEP", kind: "step.start",
    payloadKeys: ["attemptAggregateId", "effectId", "label"] },
  { agent: [WORK], capability: WORK, family: "STEP", kind: "step.finish",
    payloadKeys: ["attemptAggregateId", "effectId", "stepRef"] },
  { agent: [WORK], capability: WORK, family: "STEP", kind: "step.checkpoint",
    payloadKeys: ["attemptAggregateId", "effectId", "nextSafeActionRef"] },
  // task-b8272ee0. STANDALONE on purpose: its service takes generation PORTS no family
  // handler signature can carry, which is why it is not a `BootstrapCommandKind` and why its
  // capability is decided by the registry's own branch. `agent` is NULL, the only wired kind
  // with none, and that is the point -- no minted agent session may be granted the one-way GA
  // activation at all, so `agentCapabilitiesFor` answers UNWIRED_KIND to the orchestrator
  // rather than a capability an agent could hold. ADMIN fences REACH; OPERATOR_ONLY below is
  // the human fence. One key: everything except the GO_ACTIVATE binding is a server fact.
  { agent: null, capability: ADMIN, family: "STANDALONE", kind: "cutover.activate",
    payloadKeys: ["record"] },
  { agent: [REVIEW, WORK], capability: REVIEW, family: "REVIEW", kind: "escalation.decide",
    payloadKeys: ["decision", "escalationRef", "subjectRef"] },
  { agent: [GOAL, WORK], capability: GOAL, family: "BOOTSTRAP", kind: "goal.close",
    payloadKeys: ["closureWitness", "goalId", "zeroAuthorityWitness"] },
  { agent: [GOAL, WORK], capability: GOAL, family: "BOOTSTRAP", kind: "goal.create",
    payloadKeys: ["instructions", "title"] },
  { agent: [GOAL, WORK], capability: GOAL, family: "BOOTSTRAP",
    kind: "goal.create_with_source", payloadKeys: ["instructions", "source", "title"] },
  // THE FIVE GRAPH MUTATION KINDS (task-931f99e8). Every allow-list is caller INTENT ONLY: the
  // commandId, correlationId, decidedAt, principalId and projectId each service's exact request
  // also carries are SERVER facts, absent here so a caller naming one is refused structurally.
  { agent: [PLANNING, WORK], capability: PLANNING, family: "GRAPH", kind: "graph.approve",
    payloadKeys: ["activation", "command", "graphRevisionRef", "record", "runId"] },
  { agent: [PLANNING, WORK], capability: PLANNING, family: "GRAPH",
    kind: "graph.prepare_supersession",
    payloadKeys: ["approvedTargetRevisionRef", "goalRef"] },
  { agent: [PLANNING, WORK], capability: PLANNING, family: "GRAPH",
    kind: "graph.release_preparation",
    payloadKeys: ["expectedPreparationVersion", "generation", "goalRef"] },
  { agent: [PLANNING, WORK], capability: PLANNING, family: "GRAPH",
    kind: "graph.request_expansion",
    payloadKeys: ["goalRef", "parentNodeRef", "parentRunRef", "rationale"] },
  { agent: [PLANNING, WORK], capability: PLANNING, family: "GRAPH", kind: "graph.supersede",
    payloadKeys: [
      "command", "expectedPredecessorRevisionRef", "expectedPreparationVersion", "generation",
      "goalRef", "record", "successorGraphContentHash", "successorRevisionRef",
    ] },
  { agent: [REVIEW, WORK], capability: REVIEW, family: "REVIEW",
    kind: "integration.accept_output", payloadKeys: ["receiptId", "subjectRef"] },
  { agent: [PLANNING, WORK], capability: PLANNING, family: "BOOTSTRAP", kind: "plan.propose",
    payloadKeys: ["commands", "runId"] },
  { agent: [ADMIN, WORK], capability: ADMIN, family: "BOOTSTRAP", kind: "policy.install",
    payloadKeys: ["slice"] },
  { agent: [ADMIN, WORK], capability: ADMIN, family: "BOOTSTRAP", kind: "policy.validate",
    payloadKeys: ["input"] },
  { agent: [ADMIN, WORK], capability: ADMIN, family: "BOOTSTRAP", kind: "project.activate",
    payloadKeys: ["witness"] },
  { agent: [ADMIN, WORK], capability: ADMIN, family: "BOOTSTRAP",
    kind: "project.bind_repository", payloadKeys: ["observation"] },
  { agent: [ADMIN, WORK], capability: ADMIN, family: "BOOTSTRAP", kind: "project.register",
    payloadKeys: ["owner"] },
  { agent: [ADMIN, WORK], capability: ADMIN, family: "BOOTSTRAP", kind: "provider.probe",
    payloadKeys: ["observation"] },
  { agent: [GOAL, WORK], capability: GOAL, family: "BOOTSTRAP", kind: "repository.publish",
    payloadKeys: ["goalId", "remoteUrl"] },
  { agent: [REVIEW, WORK], capability: REVIEW, family: "REVIEW", kind: "qualification.replan",
    payloadKeys: ["nodes", "subjectRef", "successorPlanRef", "supportedCanonicalizerVersions"] },
  { agent: [REVIEW, WORK], capability: REVIEW, family: "REVIEW", kind: "review.submit",
    payloadKeys: ["findings", "packageItems", "round", "subjectRef"] },
  { agent: [ADMIN, WORK], capability: ADMIN, family: "SESSION", kind: "session.close",
    payloadKeys: ["sessionId"] },
  { agent: [ADMIN, WORK], capability: ADMIN, family: "SESSION", kind: "session.open",
    payloadKeys: ["capabilities", "credentialSha256", "expiresAt", "sessionId"] },
  { agent: [ADMIN, WORK], capability: ADMIN, family: "SESSION", kind: "session.renew",
    payloadKeys: ["expiresAt", "sessionId"] },
  { agent: [WORK], capability: WORK, family: "WORK", kind: "work.claim",
    payloadKeys: ["expiresAt", "workItemId"] },
  { agent: [WORK], capability: WORK, family: "WORK", kind: "work.release",
    payloadKeys: ["workItemId"] },
  { agent: [WORK], capability: WORK, family: "WORK", kind: "work.renew",
    payloadKeys: ["expiresAt", "workItemId"] },
];

/** Views over the production maps, so a value here is always the shipped value. */
const FAMILY_MAPS: Readonly<Record<Exclude<Family, "STANDALONE">, ReadonlyMap<string, string>>> = {
  APPROVAL_INTENT: new Map(Object.entries(APPROVAL_INTENT_FAMILY)),
  BOOTSTRAP: new Map(Object.entries(BOOTSTRAP_FAMILY)),
  COMPILER: new Map(Object.entries(COMPILER_FAMILY)),
  REVIEW: new Map(Object.entries(REVIEW_FAMILY)),
  SESSION: new Map(Object.entries(SESSION_FAMILY)),
  GRAPH: new Map(Object.entries(GRAPH_FAMILY)),
  STEP: new Map(Object.entries(STEP_FAMILY)),
  WORK: new Map(Object.entries(WORK_FAMILY)),
};

const FAMILY_NAMES = [
  "APPROVAL_INTENT", "BOOTSTRAP", "COMPILER", "GRAPH", "REVIEW", "SESSION", "STEP", "WORK",
] as const;

const OPERATOR_ONLY: readonly WiredCommandKind[] = [
  // Both approval wires are human-only: the intent seam derives the authority the caller-shaped
  // wire used to accept, so gating one and not the other would leave the derived wire reachable
  // by a non-operator principal and hand back exactly the authority this seam removes.
  "approval.decide", "approval.decide_intent", "goal.close",
  // Publishing pushes the operator's repository to the remote the operator named.
  "repository.publish",
  // The operator ANSWERS a material product question -- the human act the clarification
  // fence exists to keep off every agent wire.
  "product_contract.answer_clarification",
  // The two graph kinds that MOVE authority; the other three propose, release or request.
  "graph.approve", "graph.supersede",
  "integration.accept_output",
  "resource.confirm_released", "session.open",
  // The one-way GA activation: the act that makes v2 authoritative for good.
  "cutover.activate",
];

describe("command vocabulary", () => {
  it("carries exactly the forty-six wired kinds in their registration order", () => {
    // Pins the swept case count: an it.each over a shortened table would otherwise
    // pass while asserting nothing.
    expect(ROWS).toHaveLength(46);
    expect(new Set(ROWS.map((row) => row.kind)).size).toBe(46);
    expect(Object.keys(PAYLOAD_KEYS)).toEqual(ROWS.map((row) => row.kind));
  });

  it("names the five capabilities it hands out and nothing else", () => {
    expect(CAPABILITIES).toEqual({
      ADMIN: "project.admin", GOAL: "goal.write", PLANNING: "planning.write",
      REVIEW: "review.write", WORK: "work.write",
    });
  });

  it.each(ROWS)("$kind keeps its exact payload allow-list", (row) => {
    expect(PAYLOAD_KEYS[row.kind]).toEqual(row.payloadKeys);
  });

  it.each(ROWS)("$kind belongs to its family alone, at its capability", (row) => {
    for (const name of FAMILY_NAMES) {
      const map = FAMILY_MAPS[name];
      if (name === row.family) {
        expect(map.get(row.kind)).toBe(row.capability);
      } else {
        expect(map.has(row.kind)).toBe(false);
      }
    }
    // A standalone kind is in NO family map: its capability is decided by the
    // registry's own branch, and a family entry appearing here would shadow it.
    if (row.family === "STANDALONE") {
      expect(FAMILY_NAMES.some((name) => FAMILY_MAPS[name].has(row.kind))).toBe(false);
    }
  });

  it.each(ROWS)("$kind hands an agent its ordered, frozen capability list", (row) => {
    const capabilities = agentCapabilitiesFor(row.kind);
    expect(capabilities).toEqual(row.agent);
    if (capabilities !== null) expect(Object.isFrozen(capabilities)).toBe(true);
  });

  it("holds no family entry beyond the transcribed kinds", () => {
    const declared = ROWS.filter((row) => row.family !== "STANDALONE");
    expect(declared).toHaveLength(35);
    for (const name of FAMILY_NAMES) {
      expect([...FAMILY_MAPS[name].keys()].sort()).toEqual(
        declared.filter((row) => row.family === name).map((row) => row.kind).sort(),
      );
    }
    expect(FAMILY_MAPS.APPROVAL_INTENT.size).toBe(1);
    expect(FAMILY_MAPS.BOOTSTRAP.size).toBe(12);
    expect(FAMILY_MAPS.COMPILER.size).toBe(4);
    expect(FAMILY_MAPS.GRAPH.size).toBe(5);
    expect(FAMILY_MAPS.REVIEW.size).toBe(4);
    expect(FAMILY_MAPS.SESSION.size).toBe(3);
    expect(FAMILY_MAPS.STEP.size).toBe(3);
    expect(FAMILY_MAPS.WORK.size).toBe(3);
  });

  it("keeps every shared table frozen", () => {
    // A table moved through a spread silently unfreezes, and a caller that can
    // write a family entry can hand itself any capability it likes.
    expect(Object.isFrozen(APPROVAL_INTENT_FAMILY)).toBe(true);
    expect(Object.isFrozen(BOOTSTRAP_FAMILY)).toBe(true);
    expect(Object.isFrozen(COMPILER_FAMILY)).toBe(true);
    expect(Object.isFrozen(GRAPH_FAMILY)).toBe(true);
    expect(Object.isFrozen(GRAPH_MUTATION_COMMAND_KINDS)).toBe(true);
    expect(Object.isFrozen(REVIEW_FAMILY)).toBe(true);
    expect(Object.isFrozen(SESSION_FAMILY)).toBe(true);
    expect(Object.isFrozen(STEP_FAMILY)).toBe(true);
    expect(Object.isFrozen(WORK_FAMILY)).toBe(true);
    expect(Object.isFrozen(PAYLOAD_KEYS)).toBe(true);
    expect(Object.isFrozen(OPERATOR_CAPABILITIES)).toBe(true);
  });

  it("answers node.deliver and refuses an unknown kind", () => {
    const delivered = agentCapabilitiesFor("node.deliver");
    expect(delivered).toEqual([REVIEW, WORK]);
    expect(Object.isFrozen(delivered)).toBe(true);
    expect(agentCapabilitiesFor("cutover.preview")).toBeNull();
    expect(agentCapabilitiesFor("")).toBeNull();
  });

  it("keeps the operator capability set frozen and ordered", () => {
    expect(OPERATOR_CAPABILITIES).toEqual([ADMIN, GOAL, PLANNING, REVIEW, WORK]);
  });

  it("gates exactly eleven kinds behind the operator principal", () => {
    expect(OPERATOR_ONLY).toHaveLength(11);
    expect(OPERATOR_PRINCIPAL_KINDS.size).toBe(11);
    // Both directions over every wired kind: a kind added to the set reddens on the
    // thirty-five that must stay open, one dropped reddens on the eleven that must not.
    for (const row of ROWS) {
      expect(OPERATOR_PRINCIPAL_KINDS.has(row.kind)).toBe(OPERATOR_ONLY.includes(row.kind));
    }
  });
});
