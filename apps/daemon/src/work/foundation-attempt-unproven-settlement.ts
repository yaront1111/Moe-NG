import type { SqliteEventStore } from "@moe/store";

import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { recordTerminalEffect } from "./effect-terminal-ledger.js";
import {
  DAEMON_FOUNDATION_ATTEMPT, foundationAttemptRefusal, textOf,
} from "./foundation-attempt-contracts.js";
import type { FoundationAttemptBound } from "./foundation-attempt-contracts.js";
import { settleFoundationAttempt } from "./foundation-attempt-store.js";
import type { FoundationAttemptOutcome } from "./foundation-attempt-store.js";

/**
 * THE UNPROVEN SETTLEMENT, AND WHY IT IS GATED ON THE TERMINAL LEDGER'S OWN ANSWER
 * (task-89838d72).
 *
 * THE DEFECT. Every unproven dispatch used to note its release unconditionally. With no
 * terminal effect ever recorded, `release-terminal-evidence.ts:242` derived
 * `effectsTerminal = provenTerminal(effects)` over a split SEEDED from the binding — so
 * `terminal.length` was 0, `provenTerminal` was false, and the row landed DRAINING. That
 * row is FINAL: `commitRelease` writes at `expectedVersion: 0` under its own comment "a
 * second release on this aggregate cannot append", and attempt-release-disposition.ts
 * states the rule directly — once `commitRelease` lands a decision there is no
 * compensating path. Every unproven attempt was permanently stranded.
 *
 * THE FIX IS TO ASK THE LEDGER AND OBEY IT. `recordTerminalEffect` is a PROJECTION of
 * durable evidence, never a composition: `deriveTerminal` refuses
 * EFFECT_TERMINAL_EVIDENCE_ABSENT unless a bound activation, a readable activation record
 * AND a committed provider run all already exist. So calling it here cannot invent a
 * terminality the runner never asserted — where the evidence is absent it REFUSES, and
 * this module then declines to write a release at all. The ledger is the discriminator;
 * no daemon-side heuristic decides terminality, which is exactly what rail 1 demands.
 *
 * WHY NOT (A) ALONE — record a terminal effect on every unproven path, symmetrical with
 * the proven one. REJECTED ON MEASUREMENT. Of the five unproven call sites only the last,
 * an unreadable observation after `committed.ok && launched.ok`, has a committed provider
 * run. `prepareCapture` refused, `sealFoundationContext` refused, and `launched === null`
 * never reach a commit; and the `!committed.ok || !launched.ok` site cannot reach one
 * either, because `commitActivationProviderRun` opens `if (!input.launch.ok) return
 * input.launch;` — a non-ok launch returns the launch refusal WITHOUT committing, so its
 * "committed but not ok" sub-branch is unreachable. Recording a terminal at those four
 * would manufacture the durable fact this epic already rejected once, and an invention is
 * worse than a strand because a strand is visible.
 *
 * WHY NOT (C) — make the DRAINING append upgradeable. It treats the root cause, but
 * `expectedVersion: 0` IS the release aggregate's all-or-none rule, relied on by every
 * caller and pinned by the arm that "refuses a SECOND transition over a DRAINING row
 * rather than appending one". Changing it rewrites the aggregate's semantics far outside
 * this row's fence, which is the UNPROVEN attempt path and its release disposition.
 *
 * WHY NOT (B) ALONE — never write a release on the unproven path. It would also strand
 * nothing, but it discards the one site where the runner HAS asserted terminality and the
 * attempt can legitimately release. The composed form keeps that case.
 *
 * DEFERRING IS THE LANDED PRECEDENT, NOT A NEW SHAPE. task-1aa5a87b fixed the identical
 * class on the resources half the same way, and its own arm comment records the choice:
 * the resources case "is DEFERRED instead, with zero rows and zero decisions". A deferral
 * leaves the release aggregate EMPTY and therefore still appendable —
 * `attempt-finalization-service.ts` is a real later writer, and it reads
 * ATTEMPT_RELEASE_RECORD_ABSENT as a first-class state rather than an error.
 *
 * THE FENCE IS IN THIS SERVICE, NOT IN THE DISPOSITION LAYER, and that placement is
 * deliberate. `recordAttemptRelease` must keep writing a DRAINING row for a non-terminal
 * effect set — `attempt-release-disposition.test.ts`'s `drainedByEffects` and
 * `drainedByBoundary` are the negative controls task-1aa5a87b's approval rested on, and
 * they drive that writer directly. Moving the decision up to the caller leaves both arms
 * untouched.
 */
export function settleUnprovenFoundationAttempt(
  store: SqliteEventStore,
  bound: FoundationAttemptBound,
  record: ActivationLedgerRecord,
  input: Record<string, unknown>,
  result: Record<string, unknown> | null,
  noteRelease: (settled: FoundationAttemptOutcome) => FoundationAttemptOutcome,
): FoundationAttemptOutcome {
  const code = textOf(result, "code") ?? "FOUNDATION_ATTEMPT_LAUNCH_UNKNOWN";
  const layer = textOf(result, "layer") ?? DAEMON_FOUNDATION_ATTEMPT;
  // ORDER MIRRORS THE PROVEN PATH and is load-bearing for the same reason: the release
  // DERIVES its effect terminality from this ledger, so the terminal must be durable
  // before any release is noted, never after it.
  const terminal = recordTerminalEffect(store, {
    attemptRef: record.attempt.attemptId, projectId: bound.projectId,
  });
  const settled = settleFoundationAttempt(store, bound, record, input, {
    observation: result?.["observation"] ?? null, reasonCode: code, reasonLayer: layer,
    registration: result?.["registration"] ?? null, resultManifest: null,
    truthClass: result?.["truthClass"] === "UNSUPPORTED" ? "UNKNOWN" : "SUSPECT",
  }, foundationAttemptRefusal(code, layer));
  // THE SETTLE RECORD IS WRITTEN EITHER WAY. What the refusal withholds is the RELEASE,
  // because that is the write that can never be corrected. The attempt's own advisory
  // truth still lands under the upstream code and layer, unrestamped.
  return terminal.ok ? noteRelease(settled) : settled;
}
