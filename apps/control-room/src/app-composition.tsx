import type { JSX } from "react";

import { ApprovalInbox } from "./approvals/approval-inbox.js";
import type { ApprovalInboxItem } from "./approvals/approval-inbox.js";
import { APPROVAL_FIXTURE_RECORDS } from "./approvals/approval-fixtures.js";
import { BoardSurface } from "./board/board-surface.js";
import type { BoardCardProjection, BoardFrontierLane } from "./board/board-contract.js";
import { DoctorConsole } from "./doctor/doctor-console.js";
import { EvidenceInspect } from "./evidence/evidence-inspect.js";
import type { EvidenceReceiptRecord } from "./evidence/evidence-contract.js";
import { CONTROL_ROOM_FIXTURES } from "./fixtures.js";
import type { FixtureAffordanceSnapshot } from "./fixtures.js";
import { GoalsHome } from "./goals/goals-home.js";
import type { GoalRowProjection } from "./goals/goals-home.js";
import type { SuppliedFact } from "./nodes/node-authority.js";
import { ActionBar, ShellFrame } from "./shell/frame.js";
import { TimelineList } from "./timeline/timeline-list.js";
import type {
  TimelineCursorState, TimelineEventRow, TimelineProvenance, TimelineSourcePage,
} from "./timeline/timeline-contract.js";

/**
 * The production composition root: the shell frame fed by the CONNECTED fixture
 * affordance snapshot, with every core surface mounted as a headed section. This
 * retires the kernel's placeholder scaffold. Every value below is a hand-written
 * literal (DEVELOPMENT_ONLY, like `fixtures.ts`); live data arrives through adapters
 * this module deliberately does not contain, and nothing here constructs a command.
 *
 * The surface props deliberately span all five truth classes — including one absent
 * fact rendered as UNKNOWN — so the chip-distinctness audits exercise real payload
 * variety rather than a monoculture of verified claims.
 */
const ver = (value: string): SuppliedFact => ({ truthClass: "DAEMON_VERIFIED", value });
const obs = (value: string): SuppliedFact => ({ truthClass: "OBSERVED", value });

const GOAL_ROW: GoalRowProjection = {
  approvals: { truthClass: "HUMAN_APPROVED", value: "J1 plan approved; 1 decision pending" },
  budgetBasis: ver("envelope-19"), budgetQuarantined: ver("$0"), budgetReserved: ver("$20"),
  budgetSpent: obs("$2"), budgetUnknown: ver("$0"), completion: obs("2 of 3 nodes accepted"),
  frontierStatus: ver("READY_NOW"), goalId: "goal-j1", held: ver("not held"),
  lastEventAge: obs("4s"), phaseDistribution: obs("1 review, 1 ready, 1 accepted"),
  providerCapacity: obs("2 slots idle"), readyWidth: ver("1"), reconciliation: ver("clear"),
  state: obs("ACTIVE"), suspect: ver("none"), title: "Ship the J1 vertical slice",
};

const REVIEW_CARD: BoardCardProjection = {
  actionTargetId: "integration-j1-node-2",
  activitySilence: obs("41s"), blockerOwner: ver("none"), blockerReason: ver("none"),
  blockerType: ver("none"), budgetBasis: ver("envelope-19"), budgetSpent: obs("$2"),
  criticalPath: ver("yes"), disposition: ver("none"), held: ver("not held"),
  latestClaim: { truthClass: "AGENT_REPORTED", value: "Tests green in 41s" },
  leaseEpoch: ver("7"), leaseExpiry: obs("in 9m"), leaseState: ver("ACTIVE"),
  nodeId: "node-2", owner: obs("agent/session-a"), phase: obs("WORK_REVIEW"),
  placement: "review", progress: obs("awaiting acceptance"), qualification: ver("none"),
  renewalSilence: obs("4s"), slack: ver("2h"), sourceAggregate: "goal-j1",
  suspect: ver("none"), title: "Wire the acceptance path",
  waitOwner: ver("none"), waitReason: ver("none"), waitRecheck: ver("none"),
};

/** `readinessExplanation` is deliberately absent: the honest render is UNKNOWN. */
const FRONTIER_LANE: BoardFrontierLane = {
  cursor: obs("4819"), graphEpoch: obs("13"), idleCapacity: obs("2"), lane: "READY_NOW",
  readinessExplanation: undefined, summary: ver("1 node ready, 1 blocked"),
};

const PROVENANCE: TimelineProvenance = {
  actor: "agent/session-a", aggregateId: "node-2", commandId: null, effectId: null,
  eventId: "evt-j1-0041", leaseEpoch: 7, sessionId: "session-j1",
  timestamp: "2026-08-07T08:41:00.000Z",
  typedLink: { kind: "receipt", label: "Receipt", ref: "receipt/node-2" },
};

const TIMELINE_ROWS: readonly TimelineEventRow[] = [
  {
    eventType: "step.finish", kind: "EVENT", provenance: PROVENANCE, sequence: 1,
    summary: "Attempt finished: tests green in 41s", truthClass: "AGENT_REPORTED",
  },
  {
    eventType: "approval.request", kind: "EVENT",
    provenance: { ...PROVENANCE, actor: "daemon/runner", eventId: "evt-j1-0042" },
    sequence: 2, summary: "Acceptance decision requested", truthClass: "DAEMON_VERIFIED",
  },
];

const CURSOR: TimelineCursorState = { appliedSequence: 2, latestSequence: 2, live: true };
const timelineSource = (): TimelineSourcePage =>
  ({ hasMore: false, nextCursor: 2, rows: TIMELINE_ROWS });

const RECEIPT: EvidenceReceiptRecord = {
  artifacts: [], output: { digest: "sha256:j1-output", tail: "2 passed, 0 failed" },
  provenance: PROVENANCE, receiptId: "receipt-node-2",
  recipe: { argv: ["pnpm", "test"], cwd: "D:/projexts/moe-next", envFingerprint: "node24" },
  run: {
    endedAt: "2026-08-07T08:41:41.000Z", exitCode: 0, startedAt: "2026-08-07T08:41:00.000Z",
  },
  tree: { baseSha: "base-j1", dirtyTreeDigest: null, headSha: "head-j1" },
  truthClass: "DAEMON_VERIFIED",
};

function inboxItems(snapshot: FixtureAffordanceSnapshot): readonly ApprovalInboxItem[] {
  return [{
    affordances: snapshot.nextAllowedCommands
      .filter((command) => command.commandKind === "approval.decide"),
    age: obs("4m"), decisionId: "approval-j1-plan", kind: "PLAN",
    preconditions: ver("recipe valid; write scope disjoint"),
    record: APPROVAL_FIXTURE_RECORDS.PLAN, subject: "node-2",
    title: "Approve the J1 execution plan",
  }];
}

/**
 * Resolves the snapshot the entry point boots with: the fixture set's CONNECTED
 * state. Anything else at first paint would claim a degradation nobody observed.
 */
export function resolveEntryAffordance(
  affordances: readonly FixtureAffordanceSnapshot[],
): FixtureAffordanceSnapshot {
  const connected = affordances.find((snapshot) => snapshot.connection === "CONNECTED");
  if (connected === undefined) {
    throw new Error(
      "APP_COMPOSITION_AFFORDANCE_MISSING: fixture set supplies no CONNECTED snapshot",
    );
  }
  return connected;
}

const ENTRY_AFFORDANCE = resolveEntryAffordance(CONTROL_ROOM_FIXTURES.affordances);

export const APP_SECTION_IDS = [
  "commands", "goals", "board", "approvals", "doctor", "evidence", "timeline",
] as const;
export type AppSectionId = (typeof APP_SECTION_IDS)[number];

function Section(props: {
  readonly children: JSX.Element;
  readonly heading: string;
  readonly id: AppSectionId;
}): JSX.Element {
  return (
    <section data-testid={`cr.app.section.${props.id}`}>
      <h2>{props.heading}</h2>
      {props.children}
    </section>
  );
}

function InspectorHint(): JSX.Element {
  return (
    <p data-testid="cr.app.inspectorhint">
      Select any truth chip (Enter, or p while it holds focus) to inspect the claim&apos;s
      provenance: actor, event, session, and its typed link.
    </p>
  );
}

export interface AppCompositionProps {
  /** Overridable for tests; the entry point mounts the CONNECTED fixture snapshot. */
  readonly affordance?: FixtureAffordanceSnapshot | undefined;
}

export function AppComposition({ affordance }: AppCompositionProps): JSX.Element {
  const snapshot = affordance ?? ENTRY_AFFORDANCE;
  return (
    <ShellFrame affordance={snapshot} inspector={<InspectorHint />}>
      <h1>Moe control room</h1>
      <Section heading="Next allowed commands" id="commands">
        <ActionBar />
      </Section>
      <Section heading="Goals" id="goals">
        <GoalsHome
          creation={{
            budget: "20", policyNote: "Policy rev q-3 applies.", risk: "low",
            riskOptions: ["low", "medium"],
          }}
          filterOptions={["all", "active"]} filterValue="all"
          projectAggregateId="project-j1" rows={[GOAL_ROW]} searchValue=""
        />
      </Section>
      <Section heading="Board" id="board">
        <BoardSurface
          cards={[REVIEW_CARD]} frontier={[FRONTIER_LANE]} joins={[]}
          loadedEmptyColumns={[]} showTerminated={false}
        />
      </Section>
      <Section heading="Approvals" id="approvals">
        <ApprovalInbox items={inboxItems(snapshot)} />
      </Section>
      <Section heading="Health" id="doctor">
        <DoctorConsole
          checks={[{
            affected: [ver("node-2")], area: ver("event store"), checkId: "event-store",
            evidence: ver("0 gaps across 4819 events"), outcome: "HEALTHY",
            severity: ver("none"),
          }]}
          overall={ver("HEALTHY")} overallOutcome="HEALTHY"
        />
      </Section>
      <Section heading="Evidence" id="evidence">
        <EvidenceInspect
          comparison={null} cursorState={CURSOR} receipt={RECEIPT} rejection={null}
          sessionMessages={[]}
        />
      </Section>
      <Section heading="Timeline" id="timeline">
        <TimelineList
          cursorState={CURSOR}
          filterOptions={{
            actor: ["agent/session-a", "daemon/runner"], node: ["node-2"],
            type: ["step.finish", "approval.request"],
          }}
          maxRows={10} source={timelineSource} startCursor={null}
        />
      </Section>
    </ShellFrame>
  );
}
