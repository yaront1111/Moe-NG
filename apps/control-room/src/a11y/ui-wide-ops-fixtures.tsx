import type { JSX } from "react";

import { AttemptDetail } from "../attempts/attempt-detail.js";
import { ReviewSurface } from "../attempts/review-surface.js";
import { NodeAuthority } from "../nodes/node-authority.js";
import type { SuppliedFact } from "../nodes/node-authority.js";
import { ReconciliationInventory } from "../recovery/reconciliation-inventory.js";
import { RecoveryStatus } from "../recovery/recovery-status.js";
import type { SurfaceFixture } from "./ui-wide-core-fixtures.js";

const ver = (value: string): SuppliedFact => ({ truthClass: "DAEMON_VERIFIED", value });
const obs = (value: string): SuppliedFact => ({ truthClass: "OBSERVED", value });
const reported = (value: string): SuppliedFact => ({ truthClass: "AGENT_REPORTED", value });

function reconciliation(): JSX.Element {
  return <ReconciliationInventory authorityMode="LIVE"
    coverageLimitation={obs("scanned committed inventory at cursor 4819")} rows={[]} />;
}

function recovery(): JSX.Element {
  return <RecoveryStatus authorityMode="LIVE" backup={{
    byteVerification: ver("verified"), committedCursor: ver("4819"), generation: obs("gen-7"),
    keyChain: ver("complete"), manifestDigest: ver("sha256:manifest"),
    objectCoverage: ver("all objects"), rpo: obs("5 minutes"),
  }} export={{ committedSequence: ver("4819"), generation: obs("export-9") }} inventory={[]}
  outbox={{ aggregate: ver("project-a11y"), appliedCursor: obs("4819"),
    emittedCursor: obs("4819"), lagState: ver("caught up"), poison: ver("none") }}
  projectActions={[]} versions={{ compatibility: ver("COMPATIBLE"), engineVersion: obs("1.0"),
    requiredMinimum: ver("1.0"), schemaVersion: obs("7") }} />;
}

function nodeAuthority(): JSX.Element {
  return <NodeAuthority identity={{
    acceptanceCriteria: ver("tests pass"), nodeAuthorityHash: ver("sha256:authority"),
    nodeId: obs("node-a11y"), objective: ver("accessible control room"),
    writeScope: ver("apps/control-room/**"),
  }} lease={{ activitySilence: obs("4s"), epoch: obs("2"), expiry: obs("in 5m"),
    principal: obs("worker-a11y"), renewalSilence: obs("2s") }}
  legalCommandKinds={["approval.decide"]} phase={{ phase: obs("WORK_REVIEW"),
    reopenCount: obs("0 of 3") }} plan={{ approvalHash: ver("sha256:approval"),
    approvalValidity: { truthClass: "HUMAN_APPROVED", value: "CURRENT" },
    planHash: ver("sha256:plan"), planRevision: obs("rev 1") }} />;
}

function attemptDetail(): JSX.Element {
  return <AttemptDetail attemptId="attempt-a11y" currentBinding={{
    bindingVersion: obs("binding 2"), graphEpoch: obs("graph 13"), leaseEpoch: obs("lease 2"),
  }} journal={[{ entryId: "journal-1", summary: reported("implemented keyboard map") }]}
  receipts={[{ provenanceRef: "receipt/a11y", receiptId: "receipt-a11y",
    recipe: ver("pnpm test"), result: ver("exit 0") }]}
  recovery={{ reason: obs("none"), state: obs("ACTIVE") }} source={{
    attemptNumber: obs("#1"), inputBindingHash: ver("sha256:input"), outcome: obs("SUCCEEDED"),
    startedRevision: obs("rev 1"),
  }} transcript={["Keyboard audit completed."]} />;
}

function reviewSurface(): JSX.Element {
  return <ReviewSurface context={{ graphHash: ver("sha256:graph"), planHash: ver("sha256:plan"),
    planRevision: obs("rev 1") }} criteria={[{ criterionId: "criterion-a11y",
    state: ver("MET"), statement: obs("keyboard path passes") }]} diff={{
    baseSha: ver("base"), dirtyTree: ver("clean"), headSha: ver("head"),
    paths: [{ outOfScope: false, path: "apps/control-room/src/a11y" }],
  }} findings={[{ category: obs("accessibility"), detail: obs("none"),
    findingId: "finding-a11y", severity: obs("LOW") }]}
  receipts={[{ provenanceRef: "receipt/a11y", receiptId: "receipt-a11y",
    recipe: ver("pnpm test"), result: ver("exit 0") }]}
  reviewer={{ calibration: obs("reported only"), independence: ver("distinct principal"),
    principal: obs("reviewer-a11y") }} />;
}

export const OPS_SURFACE_FIXTURES: readonly SurfaceFixture[] = [
  { commands: [], id: "reconciliation-inventory", render: reconciliation },
  { commands: [], id: "recovery-status", render: recovery },
  { commands: [], id: "node-authority", render: nodeAuthority },
  { commands: [], id: "attempt-detail", render: attemptDetail },
  { commands: [], id: "review-surface", render: reviewSurface },
];
