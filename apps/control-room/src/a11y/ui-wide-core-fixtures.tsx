import type { NextAllowedCommand } from "@moe/contracts";
import type { JSX } from "react";

import { ApprovalDetailAcceptance } from "../approvals/approval-detail-acceptance.js";
import { ApprovalDetailConfirmation } from "../approvals/approval-detail-confirmation.js";
import { ApprovalDetailExpansion } from "../approvals/approval-detail-expansion.js";
import { ApprovalDetailPlan } from "../approvals/approval-detail-plan.js";
import { ApprovalInbox } from "../approvals/approval-inbox.js";
import type { ApprovalInboxItem } from "../approvals/approval-inbox.js";
import {
  APPROVAL_FIXTURE_RECORDS,
  CUTOVER_CONSEQUENCE_FIXTURE,
  FIXTURE_REVISION_HASH,
  FIXTURE_SUPERSEDING_HASH,
  approvalAffordance,
  withRecord,
} from "../approvals/approval-fixtures.js";
import { BoardSurface } from "../board/board-surface.js";
import type { BoardFrontierLane, BoardSurfaceProps } from "../board/board-contract.js";
import { DoctorConsole } from "../doctor/doctor-console.js";
import type { DoctorConsoleProps } from "../doctor/doctor-console.js";
import { EvidenceInspect } from "../evidence/evidence-inspect.js";
import type { EvidenceReceiptRecord } from "../evidence/evidence-contract.js";
import { GoalsHome } from "../goals/goals-home.js";
import type { GoalRowProjection, GoalsHomeProps } from "../goals/goals-home.js";
import type { SuppliedFact } from "../nodes/node-authority.js";
import { TimelineList } from "../timeline/timeline-list.js";
import type {
  TimelineCursorState, TimelineEventRow, TimelineProvenance, TimelineSourcePage,
} from "../timeline/timeline-contract.js";

export interface SurfaceFixture {
  readonly commands: readonly NextAllowedCommand[];
  readonly id: string;
  readonly render: () => JSX.Element;
  readonly renderDegraded?: (() => JSX.Element) | undefined;
  readonly renderLoading?: (() => JSX.Element) | undefined;
}

const TARGET = "acceptance-target";
const ver = (value: string): SuppliedFact => ({ truthClass: "DAEMON_VERIFIED", value });
const obs = (value: string): SuppliedFact => ({ truthClass: "OBSERVED", value });
const command = (kind: Parameters<typeof approvalAffordance>[0]): NextAllowedCommand =>
  approvalAffordance(kind, { targetAggregateId: TARGET });
const record = (kind: keyof typeof APPROVAL_FIXTURE_RECORDS) => withRecord(
  APPROVAL_FIXTURE_RECORDS[kind],
  { exactRevisionHash: FIXTURE_REVISION_HASH },
);

const GOAL_ROW: GoalRowProjection = {
  approvals: ver("none"), budgetBasis: ver("$20 reserved"), budgetQuarantined: ver("$0"),
  budgetReserved: ver("$20"), budgetSpent: obs("$2"), budgetUnknown: ver("$0"),
  completion: obs("25%"), frontierStatus: ver("READY_NOW"), goalId: "goal-a11y",
  held: ver("not held"), lastEventAge: obs("4s"), phaseDistribution: obs("1 ready"),
  providerCapacity: obs("2 slots"), readyWidth: ver("1"), reconciliation: ver("clear"),
  state: obs("ACTIVE"), suspect: ver("none"), title: "Accessibility fixture goal",
};

const FRONTIER: BoardFrontierLane = {
  cursor: obs("4819"), graphEpoch: obs("13"), idleCapacity: obs("2"),
  lane: "READY_NOW", readinessExplanation: ver("requirements satisfied"),
  summary: ver("one node ready"),
};

const PLAN_COMMANDS = [command("approval.decide")];
const EXPANSION_COMMANDS = [command("graph.approve"), command("expansion.decline")];
const CONFIRM_COMMANDS = [command("cutover.activate")];

const INBOX_ITEM: ApprovalInboxItem = {
  affordances: PLAN_COMMANDS,
  age: obs("age 4m"),
  decisionId: "decision-a11y",
  kind: "PLAN",
  preconditions: ver("recipe valid"),
  record: record("PLAN"),
  subject: "node-a11y",
  title: "Approve accessibility plan",
};

function approvalPlan(): JSX.Element {
  return <ApprovalDetailPlan affordances={PLAN_COMMANDS} node="node-a11y"
    objective={ver("keyboard complete")} oracle={ver("focused tests exit 0")}
    recipeValid={ver("valid")} record={record("PLAN")} steps={["audit", "verify"]}
    targetAggregateId={TARGET} writeScope={ver("apps/control-room/**")} />;
}

function approvalExpansion(): JSX.Element {
  return <ApprovalDetailExpansion affordances={EXPANSION_COMMANDS} goal="goal-a11y"
    invalidates={ver("nothing")} preconditions={[
      { detail: ver("disjoint"), key: "scopes", label: "Scopes" },
    ]} record={record("EXPANSION")} subgraph={["node-a", "node-b"]}
    supersedesHash={FIXTURE_SUPERSEDING_HASH} targetAggregateId={TARGET} />;
}

function approvalAcceptance(): JSX.Element {
  return <ApprovalDetailAcceptance affordances={PLAN_COMMANDS} diff={{
    baseSha: ver("base"), fileCount: ver("2 files"), headSha: ver("head"),
    inScope: ver("all in scope"),
  }} node="node-a11y" receipt={{
    digest: ver("sha256:receipt"), exitCode: ver("0"), recipe: ver("pnpm test"), time: ver("now"),
  }} record={record("ACCEPTANCE")} reopenBound={3} reopenCount={0} review={{
    distinctPrincipal: ver("distinct"), findings: ver("0"), reviewer: ver("reviewer-1"),
  }} targetAggregateId={TARGET} />;
}

function approvalConfirmation(): JSX.Element {
  return <ApprovalDetailConfirmation affordances={CONFIRM_COMMANDS} auditEvent="cutover.activate"
    commandKind="cutover.activate" confirmLabel="Activate cutover"
    consequence={CUTOVER_CONSEQUENCE_FIXTURE} kind="CUTOVER_ACTIVATE"
    record={record("CUTOVER_ACTIVATE")} scope="one node" subject="goal-a11y"
    targetAggregateId={TARGET} />;
}

const PROVENANCE: TimelineProvenance = {
  actor: "worker-a11y", aggregateId: "node-a11y", commandId: "cmd-a11y",
  effectId: "effect-a11y", eventId: "event-a11y", leaseEpoch: 1,
  sessionId: "session-a11y", timestamp: "2026-08-09T09:41:02.000Z",
  typedLink: { kind: "receipt", label: "Receipt", ref: "receipt/a11y" },
};
const CURSOR: TimelineCursorState = { appliedSequence: 1, latestSequence: 1, live: true };
const TIMELINE_ROW: TimelineEventRow = {
  eventType: "step.finish", kind: "EVENT", provenance: PROVENANCE, sequence: 1,
  summary: "step finished", truthClass: "DAEMON_VERIFIED",
};
const timelineSource = (): TimelineSourcePage => ({ hasMore: false, nextCursor: 1, rows: [TIMELINE_ROW] });

const RECEIPT: EvidenceReceiptRecord = {
  artifacts: [], output: { digest: "sha256:output", tail: "1 passed" }, provenance: PROVENANCE,
  receiptId: "receipt-a11y", recipe: { argv: ["pnpm", "test"], cwd: "D:/projexts/moe-next",
    envFingerprint: "node22" },
  run: { endedAt: "2026-08-09T09:41:02.000Z", exitCode: 0,
    startedAt: "2026-08-09T09:40:00.000Z" },
  tree: { baseSha: "base", dirtyTreeDigest: null, headSha: "head" },
  truthClass: "DAEMON_VERIFIED",
};

function goals(overrides: Partial<GoalsHomeProps> = {}): JSX.Element {
  return <GoalsHome creation={{ budget: "20", policyNote: "policy", risk: "low",
    riskOptions: ["low"] }} filterOptions={["all"]} filterValue="all"
    projectAggregateId="project-a11y" rows={[GOAL_ROW]} searchValue="" {...overrides} />;
}

function board(overrides: Partial<BoardSurfaceProps> = {}): JSX.Element {
  return <BoardSurface cards={[]} frontier={[FRONTIER]} joins={[]} loadedEmptyColumns={[]}
    showTerminated={false} {...overrides} />;
}

function doctor(overrides: Partial<DoctorConsoleProps> = {}): JSX.Element {
  return <DoctorConsole checks={[]} overall={ver("HEALTHY")} overallOutcome="HEALTHY"
    {...overrides} />;
}

export const CORE_SURFACE_FIXTURES: readonly SurfaceFixture[] = [
  { commands: [], id: "goals-home", render: goals,
    renderDegraded: () => goals({ appliedCursorLabel: "cursor 4819", degraded: true }),
    renderLoading: () => goals({ loading: true }) },
  { commands: [], id: "board-surface", render: board,
    renderDegraded: () => board({ appliedCursorLabel: "cursor 4819", degraded: true }),
    renderLoading: () => board({ loading: true }) },
  { commands: PLAN_COMMANDS, id: "approval-inbox", render: () => <ApprovalInbox items={[INBOX_ITEM]} /> },
  { commands: PLAN_COMMANDS, id: "approval-detail-plan", render: approvalPlan },
  { commands: EXPANSION_COMMANDS, id: "approval-detail-expansion", render: approvalExpansion },
  { commands: PLAN_COMMANDS, id: "approval-detail-acceptance", render: approvalAcceptance },
  { commands: CONFIRM_COMMANDS, id: "approval-detail-confirmation", render: approvalConfirmation },
  { commands: [], id: "doctor-console", render: doctor,
    renderDegraded: () => doctor({ degraded: true, freshnessLabel: "cursor 4819" }),
    renderLoading: () => doctor({ loading: true }) },
  { commands: [], id: "evidence-inspect", render: () => <EvidenceInspect comparison={null}
    cursorState={CURSOR} receipt={RECEIPT} rejection={null} sessionMessages={[]} /> },
  { commands: [], id: "timeline-list", render: () => <TimelineList cursorState={CURSOR}
    filterOptions={{ actor: [], node: [], type: [] }} maxRows={10} source={timelineSource}
    startCursor={null} /> },
];
