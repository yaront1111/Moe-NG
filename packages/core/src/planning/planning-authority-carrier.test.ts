/**
 * The carrier half: what `propose()` does with the admitted authority, and what the sealed event
 * preserves for the durable envelope.
 *
 * COMPATIBILITY DECISION (pinned here, not assumed): the authority field is OPTIONAL in core and
 * refused-when-absent by the daemon later (task-3544d11c). Evidence: the daemon folds each chain
 * entry through `as unknown as PlanningRunCommand` (planning-services.ts:70), so a REQUIRED field
 * would not red a typecheck — it would silently start refusing live plan.propose chains that
 * exist on disk today. BOTH arms are pinned below so the semantics are chosen, not accidental.
 *
 * The event carries IDENTITY only. Steps, obligations, node ids, recipe refs and approval state
 * are execution authority and must not ride along; the absence sweep below is what enforces that.
 */
import { describe, expect, it } from "vitest";

import { deriveAcceptanceContractDigest } from "./acceptance-contract-codec.js";
import { derivePlanRevisionDigest } from "./plan-revision-codec.js";
import { carriedAuthority, planAuthorityCarry } from "./planning-authority-submission.js";
import type { PlanningRunCommand, PlanningRunEvent } from "./planning-contract.js";
import { reducePlanningRun } from "./planning-run-reducer.js";
import {
  accepted, expansionPropose, expansionState, expectIllegal,
} from "./planning-run-test-fixtures.js";
import {
  buildAuthority, claimedState, CONTRACT_ID, GRAPH_CONTENT_HASH, GRAPH_REVISION_REF,
  proposeCommand, REVISION_ID,
} from "./planning-authority-test-fixtures.js";

const authority = buildAuthority();
const HASH = authority.planRevision.planHash;
const forged = buildAuthority({ approvalState: "APPROVED" });

/** The six-field identity the envelope's cross-binding table consumes, and nothing more. */
const IDENTITY_KEYS = Object.freeze([
  "criteriaDigest", "criteriaRef", "graphContentHash", "graphRevisionRef", "planHash",
  "revisionId",
]);

/** Every one of these names a body member that would make the event execution-bearing. */
const EXECUTION_MEMBERS = Object.freeze([
  "affectedNodeIds", "approvalState", "evidenceRequirements", "obligations", "statement",
  "steps", "verificationRecipeRefs",
]);

function without(command: unknown, key: string): PlanningRunCommand {
  const record = { ...(command as Record<string, unknown>) };
  delete record[key];
  return record as unknown as PlanningRunCommand;
}

const asCommand = (value: unknown): PlanningRunCommand => value as PlanningRunCommand;

function soleEvent(command: unknown, state = claimedState()): PlanningRunEvent {
  const result = reducePlanningRun(state, asCommand(command));
  if (!result.ok) throw new Error(`propose refused: ${JSON.stringify(result)}`);
  expect(result.events.length).toBe(1);
  const event = result.events[0];
  if (event === undefined) throw new Error("propose sealed no event");
  return event;
}

const carriedAuthorityOf = (event: PlanningRunEvent): Readonly<Record<string, unknown>> =>
  (event as unknown as Record<string, Record<string, unknown>>)["authority"] ?? {};

describe("plan.propose authority carrier — the compatibility decision", () => {
  const legacyEvent = soleEvent(without(proposeCommand({ authority: undefined }), "authority"));

  it("admits an authority-less legacy proposal, leaving the daemon's chains intact", () => {
    expect(legacyEvent).toStrictEqual({
      commandId: "cmd-propose", draining: true, kind: "PlanningSubmissionSealed",
      submissionHash: HASH, version: 4,
    });
  });

  it("keeps the legacy sealed event byte-identical: no authority key at all", () => {
    expect(Object.keys(legacyEvent)).not.toContain("authority");
  });

  it("treats an explicitly undefined authority as absent, matching effectTerminalProof", () => {
    expect(soleEvent(proposeCommand({ authority: undefined }))).toStrictEqual(legacyEvent);
  });

  it("refuses a null authority rather than collapsing it to absence", () => {
    expectIllegal(
      reducePlanningRun(claimedState(), asCommand(proposeCommand({ authority: null }))),
      "plan.propose", "PLANNING",
    );
  });
});

describe("plan.propose authority carrier — preserved identity", () => {
  const event = soleEvent(proposeCommand({ authority, submissionHash: HASH }));
  const carried = carriedAuthorityOf(event);

  it("seals exactly the identity fields the envelope binds on", () => {
    expect(Object.keys(carried).sort()).toStrictEqual([...IDENTITY_KEYS]);
  });

  it("preserves the admitted plan revision identity", () => {
    expect(carried["revisionId"]).toBe(REVISION_ID);
    expect(carried["graphRevisionRef"]).toBe(GRAPH_REVISION_REF);
    expect(carried["graphContentHash"]).toBe(GRAPH_CONTENT_HASH);
  });

  it("preserves the criteria digest and ref, recomputed through the production derivations", () => {
    const criteria = deriveAcceptanceContractDigest(authority.acceptanceContract);
    const plan = derivePlanRevisionDigest(authority.planRevision);
    if (!criteria.ok || !plan.ok) throw new Error("a production derivation refused the control");
    expect(carried["criteriaDigest"]).toBe(criteria.criteriaDigest);
    expect(carried["criteriaRef"]).toBe(CONTRACT_ID);
    expect(carried["planHash"]).toBe(plan.planHash);
  });

  it("leaves the rest of the sealed event exactly its legacy shape", () => {
    expect({ ...event, authority: undefined }).toStrictEqual({
      authority: undefined, commandId: "cmd-propose", draining: true,
      kind: "PlanningSubmissionSealed", submissionHash: HASH, version: 4,
    });
  });

  it("embeds no execution authority, over a nonempty member sweep", () => {
    const serialized = JSON.stringify(event);
    expect(EXECUTION_MEMBERS.length).toBeGreaterThan(0);
    for (const member of EXECUTION_MEMBERS) {
      expect(serialized).not.toContain(member);
    }
  });

  it("freezes the carried identity", () => {
    expect(Object.isFrozen(carried)).toBe(true);
  });
});

describe("plan.propose authority carrier — refusal is the authority's decision", () => {
  const command = proposeCommand({ authority: forged, submissionHash: HASH });

  it("refuses a proposal whose authority the parser rejected", () => {
    expectIllegal(reducePlanningRun(claimedState(), asCommand(command)), "plan.propose",
      "PLANNING");
  });

  it("admits the identical command once the authority is removed, pinning the discriminator", () => {
    const result = reducePlanningRun(claimedState(), without(command, "authority"));
    expect(result.ok).toBe(true);
  });
});

describe("plan.propose authority carrier — the idempotency short-circuit", () => {
  const sealed = accepted(
    reducePlanningRun(claimedState(), asCommand(proposeCommand({ authority, submissionHash: HASH }))),
  );
  const replay = (value: unknown): PlanningRunCommand =>
    asCommand(proposeCommand({ ...(value as object), expectedVersion: 4, submissionHash: HASH }));

  it("re-seals nothing on an identical replay", () => {
    const result = reducePlanningRun(sealed, replay({ authority }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("the replay control was refused");
    expect(result.events).toStrictEqual([]);
  });

  it("refuses a forged authority replayed under the already-sealed submission hash", () => {
    expectIllegal(reducePlanningRun(sealed, replay({ authority: forged })), "plan.propose",
      "SUBMISSION_DRAINING");
  });
});

/**
 * The member read itself, exercised directly. Driving these through `reducePlanningRun` would
 * prove nothing: `snapshotCommand` flattens the command into inert data first, so an accessor
 * member is already gone by the time the carry runs. Every OTHER in-package caller of `propose()`
 * — including every core test that skips the reducer — reaches this guard unprotected.
 */
describe("plan.propose authority carrier — the member read", () => {
  const accessorCommand = (): Record<string, unknown> => {
    const command: Record<string, unknown> = { kind: "plan.propose" };
    Object.defineProperty(command, "authority", {
      configurable: true, enumerable: true, get: () => authority,
    });
    return command;
  };

  it("admits an absent member as the legacy arm", () => {
    expect(planAuthorityCarry({ kind: "plan.propose" }, HASH)).toStrictEqual({ ok: true });
  });

  it("admits an explicitly undefined member as the legacy arm", () => {
    expect(planAuthorityCarry({ authority: undefined, kind: "plan.propose" }, HASH))
      .toStrictEqual({ ok: true });
  });

  it("refuses an accessor member rather than reading it as absent", () => {
    expect(planAuthorityCarry(accessorCommand(), HASH)).toStrictEqual({ ok: false });
  });

  it("refuses a member the parser rejected", () => {
    expect(planAuthorityCarry({ authority: forged, kind: "plan.propose" }, HASH))
      .toStrictEqual({ ok: false });
  });

  it("carries the identity through for an admitted member", () => {
    const carry = planAuthorityCarry({ authority, kind: "plan.propose" }, HASH);
    expect(carry.ok).toBe(true);
    expect(Object.keys(carriedAuthority(carry)["authority"] ?? {}).sort())
      .toStrictEqual([...IDENTITY_KEYS]);
  });
});

/**
 * MEASURED, not assumed: an EXPANSION proposal is admitted through an EXACT key roster
 * (`planning-expansion-validation.ts:65-68`, `proposeShape`), and its sealed event through
 * another (`SEALED_KEYS`, :73-76). Widening the shared base would therefore have refused every
 * live EXPANSION proposal on a shape check. The authority rides the INITIAL/REVISION arm only;
 * the EXPANSION arm keeps both rosters byte-identical and fails CLOSED on a smuggled member.
 */
describe("plan.propose authority carrier — the expansion arm stays byte-identical", () => {
  it("still seals its exact legacy event, with no authority member", () => {
    const event = soleEvent(expansionPropose(), expansionState("PLANNING"));
    expect(Object.keys(event)).not.toContain("authority");
    expect(carriedAuthorityOf(event)).toStrictEqual({});
  });

  it("refuses an EXPANSION proposal that smuggles an authority member", () => {
    expectIllegal(
      reducePlanningRun(expansionState("PLANNING"), expansionPropose({ authority })),
      "plan.propose", "PLANNING",
    );
  });
});
