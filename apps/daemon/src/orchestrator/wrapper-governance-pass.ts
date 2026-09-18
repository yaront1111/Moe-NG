import type { SqliteEventStore } from "@moe/store";

import { decideGovernanceEscalation } from "../review/governance-escalation-decider.js";
import type {
  GovernanceAdvisor,
  GovernanceOutcome,
} from "../review/governance-escalation-decider.js";
import { governanceOpen } from "../review/governance-policy-settings.js";
import type { GovernancePolicy } from "../review/governance-policy-settings.js";
import { reviewContinuationAvailable } from "../review/review-continuation.js";
import { readReviewLedgers } from "../review/review-read-model.js";
import { reviewDecisionRequired } from "../review/review-stall.js";

/**
 * Governance, run once per wrapper pass over every node the project knows.
 *
 * WHERE IT SITS. The pass loop already walks `delivery.advance()` and `wrapper.runOnce()` each
 * interval. A node whose review is exhausted is invisible to both: the affordance surface offers
 * it nothing but `escalation.decide` and marks its step BLOCKED, precisely so the wrapper does
 * NOT staff agents into a refusal loop. So the node sits there until a human answers — which is
 * the behaviour this pass exists to end.
 *
 * IT IS INERT UNTIL THE OWNER SAYS OTHERWISE. With no stated policy `governanceOpen` is false
 * and this returns before reading anything, so an unconfigured daemon behaves exactly as it does
 * today, down to the store reads it does not make.
 *
 * ONE NODE'S ANSWER IS NEVER ANOTHER'S PROBLEM. Each node is decided independently and a refusal
 * is logged and stepped over, because a single unreadable ledger must not stop governance
 * answering every other node in the project.
 *
 * IT SAYS WHAT IT DID, AND ONLY WHEN IT DID SOMETHING. The quiet outcomes — closed, not due,
 * already funded — are the overwhelming majority on every pass and say nothing worth a line.
 * Acting outcomes are always logged, because a decision taken on the owner's behalf that left no
 * trace in the log would be exactly the thing they could not audit afterwards.
 */
export interface GovernancePassConfig {
  readonly advisor: GovernanceAdvisor;
  readonly clock: () => string;
  readonly log: (line: string) => void;
  readonly nodes: () => readonly { readonly nodeRef: string }[];
  readonly policy: GovernancePolicy | undefined;
  readonly projectId: string;
  /** The wrapper's own handle, which is undefined before the store is opened. */
  readonly store: () => SqliteEventStore | undefined;
}

type HumanNeededWhy = Extract<GovernanceOutcome, { readonly kind: "HUMAN_NEEDED" }>["why"];

/**
 * ONE SENTENCE PER REASON, KEYED SO A NEW REASON CANNOT COMPILE WITHOUT ITS OWN. This was a chain
 * whose last arm absorbed every reason it did not name, and that catch-all is what hid a ledger
 * the daemon could not READ behind "no answer could be produced" — 302 such lines on UnAI
 * 2026-09-18 while the advisor was never once asked, so the owner was told a model had failed
 * when the thing to fix was the store.
 */
const HUMAN_NEEDED_BECAUSE: Readonly<Record<HumanNeededWhy, string>> = {
  BOUND_SPENT: "its governance decision bound is spent",
  LEDGER_UNREADABLE: "the daemon could not read its governance decision history from the store, "
    + "a store problem and not a model that declined to answer",
  NO_ANSWER: "no answer could be produced",
  ROUND_CEILING: "its review has reached the absolute round ceiling, which no decision can raise",
};

export function createGovernancePass(config: GovernancePassConfig): () => Promise<void> {
  return async function governancePass(): Promise<void> {
    if (!governanceOpen(config.policy)) return;
    const store = config.store();
    if (store === undefined) return;
    let nodes: readonly { readonly nodeRef: string }[];
    try { nodes = config.nodes(); } catch { return; }
    // ONE walk of the decision ledger for every node, not one walk EACH. `readReviewLedger` folds
    // the whole durable log per subject; calling it per node turned a 15-second pass over 70
    // nodes into ~70 folds of a 20 MB log, which held the event loop at ~90% of a core
    // continuously and starved the MCP host the seats call (measured on UnAI 2026-09-16: the
    // wrapper logged nothing for 54 minutes while burning 5,100 CPU-seconds). `readReviewLedgers`
    // exists for exactly this and says so in its own doc comment.
    //
    // This is a PREFILTER and nothing more. It decides only who is worth looking at; the decider
    // still takes its own fresh read before committing, because a ledger read once at the top of
    // a pass is stale by the time the last node is decided — which is how a decision gets refused
    // REVIEW_ESCALATION_NOT_REACHED after the state moved underneath it.
    let candidates: readonly string[];
    try {
      const refs = new Set(nodes.map((node) => node.nodeRef));
      if (refs.size === 0) return;
      const { ledgers } = readReviewLedgers(store, config.projectId, refs);
      candidates = [...refs].filter((nodeRef) => {
        const ledger = ledgers.get(nodeRef);
        if (ledger === undefined || ledger.unreadable || ledger.replanned) return false;
        if (ledger.accepted !== undefined || reviewContinuationAvailable(ledger)) return false;
        const latest = ledger.rounds.at(-1);
        if (latest === undefined || latest.routing.route === "ACCEPT") return false;
        return reviewDecisionRequired(ledger);
      });
    } catch { return; }
    for (const nodeRef of candidates) {
      // EACH NODE ALONE, AND THAT NOW NEEDS A GUARD. The decider contains its own failures, but
      // the advisor it awaits is a model in a process this module does not own. An advisor that
      // REJECTS rather than returning null would abandon every node after it in the candidate
      // list — and this pass is the only thing that moves any of them, so one bad node would
      // park the rest indefinitely with nothing in the log to say why.
      try {
        const outcome = await decideGovernanceEscalation({
          advisor: config.advisor, clock: config.clock, policy: config.policy,
          projectId: config.projectId, store,
        }, nodeRef);
        if (outcome.kind === "ALLOWED") {
          config.log(`[governance] ${nodeRef}: answered its exhausted review and funded one more attempt (${String(outcome.decisionIds.length)} decision(s) recorded)`);
        } else if (outcome.kind === "HUMAN_NEEDED") {
          config.log(`[governance] ${nodeRef}: ${HUMAN_NEEDED_BECAUSE[outcome.why]}; it needs your decision in the control room, and its work is untouched`);
        } else if (outcome.kind === "REFUSED") {
          config.log(`[governance] ${nodeRef}: the daemon refused the decision (${outcome.code}); it stays exactly as it was`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        config.log(`[governance] ${nodeRef}: the decision could not be taken (${message}); it stays exactly as it was`);
      }
    }
  };
}
