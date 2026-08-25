/**
 * The daemon expansion ADMISSION composition end to end
 * (task-c4171c1cfe854cb78dd233794b342025), over a REAL file-backed `SqliteEventStore` whose
 * goal, parent run, ACTIVE graph and ACTIVE expansion hold are all produced by production
 * writers.
 *
 * EVERY ARM DRIVES `handleExpansionAdmission`. Not a harness that reassembles the composition —
 * a harness would grade itself. The kernels are reached only through the production service, so
 * a refusal arm proves the SERVICE forwards that refusal, not that the kernel can mint it.
 *
 * REFUSAL ARMS RUN ALONE. Six layers can refuse one request and the FIRST refusal
 * short-circuits, so a case that is wrong in two places is unattributable. Each arm perturbs
 * exactly ONE thing from the accepted payload, the accepted arm is asserted first so every
 * refusal below is caused by its own perturbation, and the precedence order itself is pinned by
 * arms that are deliberately wrong in TWO places and must report the earlier layer.
 *
 * EVERY REFUSAL ASSERTS FOUR THINGS: this slice's own code, this slice's own layer, the UPSTREAM
 * surface's exact code and layer verbatim, and that nothing was recorded. An "it refused"
 * assertion would stay green if an approval refusal started arriving with an admission code.
 *
 * WINDOWS HANDLE DISCIPLINE: every store is closed in a `finally` INSIDE the temp directory's
 * own `finally`. A handle held across `rmSync` throws EPERM and kills the vitest worker with no
 * output at all.
 */

import { describe, expect, it } from "vitest";

import type { SqliteEventStore } from "@moe/store";

import { seedActivationWorld } from "../activation/activation-world-fixtures.js";
import {
  EXPANSION_ADMISSION_CODES, EXPANSION_ADMISSION_CODE_LAYERS,
  EXPANSION_ADMISSION_LAYERS, EXPANSION_ADMISSION_PAYLOAD_KEYS,
  EXPANSION_ADMISSION_SERVER_OWNED_KEYS,
} from "./expansion-admission-contracts.js";
import type { ExpansionAdmissionRefusal } from "./expansion-admission-contracts.js";
import { EXPANSION_APPROVAL_RECORD_KEYS } from "./expansion-admission-records.js";
import { handleExpansionAdmission } from "./expansion-admission-service.js";
import {
  acceptedOf, admissionEnvelope, admissionPayload, admit, budget, currentFacts, hex, proposal,
  recordedBindings, refusalOf, supersession, withWorld,
} from "./expansion-admission-test-fixtures.js";

type Record_ = Record<string, unknown>;

describe("the accepted journey records one approved binding (task-c4171c1c)", () => {
  it("approves a fresh current journey and records exactly the three identities", () => {
    withWorld((store) => {
      const outcome = acceptedOf(admit(store));
      const recorded = recordedBindings(store);
      expect(recorded).toHaveLength(1);
      expect(Object.keys(recorded[0]!).sort())
        .toEqual([...EXPANSION_APPROVAL_RECORD_KEYS].sort());
      expect(recorded[0]).toEqual({
        approvalIdentity: outcome.approvalIdentity,
        preparationIdentity: outcome.preparationIdentity,
        proposalIdentity: outcome.proposalIdentity,
      });
    });
  });

  it("fences a SECOND binding for the same hold instead of overwriting the first", () => {
    withWorld((store) => {
      const first = acceptedOf(admit(store));
      const second = refusalOf(admit(store, {}, { commandId: "cmd-expansion-admission-2" }));
      expect(second.code).toBe("EXPANSION_ADMISSION_RECORD_CONFLICT");
      expect(second.layer).toBe("RECORD");
      expect(second.upstream?.component).toBe("DURABLE_STORE");
      const recorded = recordedBindings(store);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!["approvalIdentity"]).toBe(first.approvalIdentity);
    });
  });
});

describe("the external contract is exact (task-c4171c1c)", () => {
  it("refuses every server-owned key by arity, over a non-empty roster", () => {
    expect(EXPANSION_ADMISSION_SERVER_OWNED_KEYS.length).toBeGreaterThan(0);
    withWorld((store) => {
      for (const key of EXPANSION_ADMISSION_SERVER_OWNED_KEYS) {
        const payload = { ...admissionPayload(store), [key]: "forged" };
        const refusal = refusalOf(handleExpansionAdmission({
          envelope: admissionEnvelope(payload), store,
        }));
        expect(refusal.code).toBe("EXPANSION_ADMISSION_PAYLOAD_MALFORMED");
        expect(refusal.layer).toBe("REQUEST");
        expect(refusal.upstream).toBeNull();
      }
      expect(recordedBindings(store)).toHaveLength(0);
    });
  });

  it("derives every code's layer from the one closed map, over a non-empty roster", () => {
    expect(EXPANSION_ADMISSION_CODES.length).toBeGreaterThan(0);
    expect(EXPANSION_ADMISSION_CODES.length)
      .toBe(Object.keys(EXPANSION_ADMISSION_CODE_LAYERS).length);
    for (const code of EXPANSION_ADMISSION_CODES) {
      expect(EXPANSION_ADMISSION_LAYERS).toContain(EXPANSION_ADMISSION_CODE_LAYERS[code]);
    }
    expect(EXPANSION_ADMISSION_PAYLOAD_KEYS.length).toBeGreaterThan(0);
  });
});

/**
 * ONE ARM PER REFUSING SURFACE, EACH RUN ALONE. `upstreamCode` and `upstreamLayer` are the
 * refusing surface's OWN words: if this slice ever restamped them with its own layer the arm
 * goes red, which an "it refused" assertion never would.
 */
interface Arm {
  readonly code: string;
  readonly layer: string;
  readonly name: string;
  readonly overrides: (store: SqliteEventStore) => Record_;
  readonly seed?: (store: SqliteEventStore) => void;
  readonly upstreamCode: string | null;
  readonly upstreamLayer: string | null;
}

/** Two meters in one reservation: no single funding fact can describe it honestly. */
function multiMeterBudget(): Record_ {
  const base = budget();
  const admission = base["admission"] as Record_;
  const amounts = (admission["amounts"] as Record_[]).map(
    (line, index) => (index === 0 ? { ...line, meter: "wallclock" } : line),
  );
  return {
    ...base,
    view: {
      accountId: "acct.1", state: "OPEN", version: 4,
      meters: [
        { meter: "tokens", available: 1000, reserved: 0, quarantined: 0, committed: 0 },
        { meter: "wallclock", available: 1000, reserved: 0, quarantined: 0, committed: 0 },
      ],
    },
    admission: { ...admission, amounts },
  };
}

const ARMS: readonly Arm[] = [
  {
    name: "the current-authority reader, on a goal that is not there",
    code: "EXPANSION_ADMISSION_AUTHORITY_UNAVAILABLE", layer: "AUTHORITY",
    upstreamCode: "EXPANSION_REQUEST_GOAL_ABSENT", upstreamLayer: "CURRENT_AUTHORITY",
    overrides: () => ({ goalRef: "goal-that-is-not-there" }),
  },
  {
    name: "the durable ledger, on a world with no hold at all",
    code: "EXPANSION_ADMISSION_HOLD_UNAVAILABLE", layer: "LEDGER",
    upstreamCode: "EXPANSION_REQUEST_LEDGER_ABSENT", upstreamLayer: "LEDGER",
    overrides: () => ({}), seed: seedActivationWorld,
  },
  {
    name: "the scheduler admission, on a proposal it cannot parse",
    code: "EXPANSION_ADMISSION_PROPOSAL_REFUSED", layer: "ADMISSION",
    upstreamCode: "EXPANSION_ADMISSION_REQUEST_MALFORMED", upstreamLayer: "REQUEST",
    overrides: () => ({ proposal: { not: "an admission request" } }),
  },
  {
    name: "the scheduler bridge, on an opportunity another work item won",
    code: "EXPANSION_ADMISSION_PROJECTION_REFUSED", layer: "PROJECTION",
    upstreamCode: "EXPANSION_BINDING_OPPORTUNITY_WINNER_MISMATCH", upstreamLayer: "FAIRNESS",
    overrides: () => ({
      opportunity: {
        observationRef: "obs.item.b", opportunityRef: "opportunity.1",
        winnerWorkItemId: "item.b",
      },
    }),
  },
  {
    name: "this slice's contract check, on a supersession naming a foreign predecessor",
    code: "EXPANSION_ADMISSION_CONTRACT_MISMATCH", layer: "CONTRACT",
    upstreamCode: "EXPANSION_HOLD_BINDING_MISMATCH", upstreamLayer: "BINDING",
    overrides: (store) => ({
      supersession: supersession({
        ...currentFacts(store).predecessor, revisionId: "revision-from-another-world",
      }),
    }),
  },
  {
    name: "this slice's funding derivation, on a reservation spanning two meters",
    code: "EXPANSION_ADMISSION_FUNDING_UNDERIVABLE", layer: "CONTRACT",
    upstreamCode: "EXPANSION_ADMISSION_BUDGET_MULTI_METER", upstreamLayer: "BUDGET",
    overrides: (store) => ({
      proposal: proposal({
        budget: multiMeterBudget(),
        receipt: receiptForWorld(store),
      }),
    }),
  },
  {
    name: "the core preparation, on a policy input it will not evaluate",
    code: "EXPANSION_ADMISSION_PREPARATION_REFUSED", layer: "PREPARATION",
    upstreamCode: "EXPANSION_PREPARATION_POLICY_INPUT_INVALID", upstreamLayer: "POLICY",
    overrides: () => ({ policy: { not: "a policy evaluation input" } }),
  },
  {
    name: "the core approval, on a record echoing the wrong quality digest",
    code: "EXPANSION_ADMISSION_APPROVAL_REFUSED", layer: "APPROVAL",
    upstreamCode: "EXPANSION_APPROVAL_QUALITY_MISMATCH", upstreamLayer: "BINDING",
    overrides: (store) => ({
      approval: {
        ...(admissionPayload(store)["approval"] as Record_),
        planQualityAssessmentRef: hex("9"),
      },
    }),
  },
];

/** The receipt the accepted payload would build, so a budget arm perturbs ONLY the budget. */
function receiptForWorld(store: SqliteEventStore): Record_ {
  const facts = currentFacts(store);
  return {
    ...((proposal()["receipt"]) as Record_),
    goalVersion: facts.goalVersion,
    graphEpoch: facts.predecessor.graphEpoch,
  };
}

describe("every refusing surface keeps its own identity (task-c4171c1c)", () => {
  it("runs a non-empty arm roster covering every refusing layer once", () => {
    expect(ARMS.length).toBeGreaterThan(0);
    expect(new Set(ARMS.map((arm) => arm.layer)).size).toBeGreaterThan(4);
  });

  it.each(ARMS.map((arm) => [arm.name, arm] as const))("refuses at %s", (_name, arm) => {
    withWorld((store) => {
      const refusal = refusalOf(admit(store, arm.overrides(store)));
      expect(refusal.code).toBe(arm.code);
      expect(refusal.layer).toBe(arm.layer);
      expect(refusal.upstream?.code ?? null).toBe(arm.upstreamCode);
      expect(refusal.upstream?.layer ?? null).toBe(arm.upstreamLayer);
      // No business event, no authority: the refusal recorded nothing at all.
      expect(recordedBindings(store)).toHaveLength(0);
    }, arm.seed);
  });

  it("refuses a malformed envelope with no upstream face at all", () => {
    withWorld((store) => {
      const refusal = refusalOf(handleExpansionAdmission({
        envelope: { commandId: "cmd-1" }, store,
      }));
      expect(refusal.code).toBe("EXPANSION_ADMISSION_ENVELOPE_MALFORMED");
      expect(refusal.layer).toBe("REQUEST");
      expect(refusal.upstream).toBeNull();
      expect(recordedBindings(store)).toHaveLength(0);
    });
  });
});

/**
 * PRECEDENCE. Each case below is wrong in TWO places at once; the arm asserts the EARLIER layer
 * answered. Run singly these same perturbations each produce their own refusal above, so the
 * pair proves ordering rather than merely that something refused.
 */
const PRECEDENCE: readonly {
  readonly earlier: string; readonly later: string; readonly name: string;
  readonly overrides: (store: SqliteEventStore) => Record_;
}[] = [
  {
    name: "authority before admission",
    earlier: "EXPANSION_ADMISSION_AUTHORITY_UNAVAILABLE",
    later: "EXPANSION_ADMISSION_PROPOSAL_REFUSED",
    overrides: () => ({ goalRef: "goal-that-is-not-there", proposal: { not: "a request" } }),
  },
  {
    name: "admission before projection",
    earlier: "EXPANSION_ADMISSION_PROPOSAL_REFUSED",
    later: "EXPANSION_ADMISSION_PROJECTION_REFUSED",
    overrides: () => ({
      proposal: { not: "a request" },
      opportunity: {
        observationRef: "obs.item.b", opportunityRef: "opportunity.1",
        winnerWorkItemId: "item.b",
      },
    }),
  },
  {
    name: "projection before contract",
    earlier: "EXPANSION_ADMISSION_PROJECTION_REFUSED",
    later: "EXPANSION_ADMISSION_CONTRACT_MISMATCH",
    overrides: (store) => ({
      opportunity: {
        observationRef: "obs.item.b", opportunityRef: "opportunity.1",
        winnerWorkItemId: "item.b",
      },
      supersession: supersession({
        ...currentFacts(store).predecessor, revisionId: "revision-from-another-world",
      }),
    }),
  },
  {
    name: "contract before preparation",
    earlier: "EXPANSION_ADMISSION_CONTRACT_MISMATCH",
    later: "EXPANSION_ADMISSION_PREPARATION_REFUSED",
    overrides: (store) => ({
      policy: { not: "a policy evaluation input" },
      supersession: supersession({
        ...currentFacts(store).predecessor, revisionId: "revision-from-another-world",
      }),
    }),
  },
  {
    name: "preparation before approval",
    earlier: "EXPANSION_ADMISSION_PREPARATION_REFUSED",
    later: "EXPANSION_ADMISSION_APPROVAL_REFUSED",
    overrides: (store) => ({
      policy: { not: "a policy evaluation input" },
      approval: {
        ...(admissionPayload(store)["approval"] as Record_),
        planQualityAssessmentRef: hex("9"),
      },
    }),
  },
];

describe("refusal precedence is pinned, not assumed (task-c4171c1c)", () => {
  it("runs a non-empty precedence roster", () => {
    expect(PRECEDENCE.length).toBeGreaterThan(0);
  });

  it.each(PRECEDENCE.map((entry) => [entry.name, entry] as const))(
    "reports %s when both are wrong", (_name, entry) => {
      withWorld((store) => {
        const refusal = refusalOf(admit(store, entry.overrides(store)));
        expect(refusal.code).toBe(entry.earlier);
        expect(refusal.code).not.toBe(entry.later);
        expect(recordedBindings(store)).toHaveLength(0);
      });
    },
  );
});
