import type { JSX } from "react";

import type { HealthOutcome, PolicyOutcome, PolicySliceKind } from "../../live/live-ops.js";
import { MIDDOT } from "../glyphs.js";

/**
 * POLICY and HEALTH, the pure screens. Both render only what the daemon stated: a slice's
 * kind, digest check and counts; the verifier's standing; the process facts and ledger
 * counts. Words are a person's, codes stay in mono beside them. No fetch, no clock beyond
 * the `nowMs` handed in for relative times.
 */

const KIND_WORDS: Readonly<Record<PolicySliceKind, string>> = Object.freeze({
  ARTIFACT: "Artifact",
  EVALUATION: "Evaluation policy",
  REVIEWER_CALIBRATION: "Reviewer calibration",
  VERIFIER_POLICY: "Verifier policy",
});

function ago(iso: string | null, nowMs: number): string {
  if (iso === null) return "never";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const minutes = Math.max(0, Math.round((nowMs - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${String(hours)} h ago` : `${String(Math.round(hours / 24))} d ago`;
}

function Refusal({ outcome, testId }: {
  readonly outcome: Extract<PolicyOutcome | HealthOutcome, { status: "ERROR" | "REFUSED" }>; readonly testId: string;
}): JSX.Element {
  return (
    <p className="cr2-approve-refusal" data-testid={testId}>
      {`${outcome.status} ${MIDDOT} ${outcome.code} ${MIDDOT} ${outcome.layer}`}
    </p>
  );
}

function Fact({ label, value, testId }: {
  readonly label: string; readonly value: string; readonly testId?: string | undefined;
}): JSX.Element {
  return (
    <div className="cr2-ops-fact">
      <dt className="cr2-ops-fact-label">{label}</dt>
      <dd className="cr2-ops-fact-value" data-testid={testId}>{value}</dd>
    </div>
  );
}

export function verifierWords(verifier: { readonly calibration: boolean; readonly policy: boolean }): string {
  if (verifier.policy && verifier.calibration) return "The verifier can accept delivered work.";
  const missing = [
    ...(verifier.policy ? [] : ["the verifier policy (moe-verifier-policy/1)"]),
    ...(verifier.calibration ? [] : ["the reviewer calibration (moe-reviewer-calibration/1)"]),
  ];
  return `Delivered work cannot be accepted until ${missing.join(" and ")} is installed with policy.install.`;
}

export function PolicyScreen({ nowMs, outcome }: { readonly nowMs: number; readonly outcome: PolicyOutcome | null }): JSX.Element {
  if (outcome === null) {
    return <section className="cr2-ops" data-testid="cr.policy.root"><p className="cr2-slot-kicker" data-testid="cr.policy.loading">Reading the policy...</p></section>;
  }
  if (outcome.status !== "POLICY") {
    return <section className="cr2-ops" data-testid="cr.policy.root"><Refusal outcome={outcome} testId="cr.policy.refusal" /></section>;
  }
  return (
    <section className="cr2-ops" data-testid="cr.policy.root">
      <p
        className="cr2-approve-banner"
        data-reviewable={outcome.verifier.policy && outcome.verifier.calibration ? "true" : undefined}
        data-testid="cr.policy.verifier"
      >
        {verifierWords(outcome.verifier)}
      </p>
      <span className="cr2-goals-count" data-testid="cr.policy.count">
        {`${String(outcome.slices.length)} INSTALLED ${MIDDOT} ${String(outcome.evaluations.length)} EVALUATIONS ${MIDDOT} VERSION ${String(outcome.aggregateVersion)}`}
      </span>
      {outcome.slices.length === 0 ? (
        <div className="cr2-goals-empty" data-testid="cr.policy.empty">
          <p className="cr2-goals-empty-title">No policy installed.</p>
          <p className="cr2-goals-empty-body">A fresh project needs the verifier policy, the reviewer calibration and one evaluation policy installed with policy.install before delivered work can be accepted.</p>
        </div>
      ) : (
        <ul className="cr2-needs-list" data-testid="cr.policy.slices">
          {outcome.slices.map((slice) => (
            <li className="cr2-ops-card" data-kind={slice.kind} data-testid={`cr.policy.slice.${slice.sliceRef}`} key={slice.sliceRef}>
              <p className="cr2-slot-kicker">
                {`${KIND_WORDS[slice.kind]} ${MIDDOT} installed ${ago(slice.installedAt, nowMs)}`}
                {slice.contentDigestMatches === null ? "" : slice.contentDigestMatches
                  ? ` ${MIDDOT} bytes match the ref` : ` ${MIDDOT} BYTES DO NOT MATCH THE REF`}
              </p>
              <p className="cr2-approve-mono cr2-ops-ref">{slice.sliceRef}</p>
              {slice.rules === null ? null : (
                <p className="cr2-needs-detail">
                  {`${String(slice.rules)} rules ${MIDDOT} ${String(slice.autoApprovalOptIns ?? 0)} auto-approval opt-ins ${MIDDOT} ${String(slice.riskClassifications ?? 0)} risk classifications`}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <details className="cr2-approve-inspect" data-testid="cr.policy.evaluations">
        <summary className="cr2-approve-inspect-summary">{`Evaluations ${MIDDOT} ${String(outcome.evaluations.length)}`}</summary>
        <ul className="cr2-approve-obligations">
          {outcome.evaluations.map((row, index) => (
            <li className="cr2-coverage-section" key={`${row.decidedAt}:${String(index)}`}>
              <span className="cr2-approve-step-body">{`${row.decision ?? "decided"} ${MIDDOT} ${ago(row.decidedAt, nowMs)} ${MIDDOT} by ${row.principalId ?? "unknown"}`}</span>
              <span className="cr2-approve-mono">{row.policyRef.slice(0, 16)}</span>
            </li>
          ))}
        </ul>
      </details>
      <p className="cr2-needs-note" data-testid="cr.policy.waivers">{`Waivers: not supported here. ${outcome.waivers.reason}`}</p>
    </section>
  );
}

export function HealthScreen({ nowMs, outcome }: { readonly nowMs: number; readonly outcome: HealthOutcome | null }): JSX.Element {
  if (outcome === null) {
    return <section className="cr2-ops" data-testid="cr.health.root"><p className="cr2-slot-kicker" data-testid="cr.health.loading">Reading the daemon...</p></section>;
  }
  if (outcome.status !== "HEALTH") {
    return <section className="cr2-ops" data-testid="cr.health.root"><Refusal outcome={outcome} testId="cr.health.refusal" /></section>;
  }
  const { daemon, ledger } = outcome;
  return (
    <section className="cr2-ops" data-testid="cr.health.root">
      <p className="cr2-approve-banner" data-reviewable="true" data-testid="cr.health.banner">
        {`The daemon answered ${ago(outcome.readAt, nowMs)} ${MIDDOT} up since ${daemon.startedAt} ${MIDDOT} last decision ${ago(ledger.lastDecidedAt, nowMs)}`}
      </p>
      <dl className="cr2-ops-facts" data-testid="cr.health.facts">
        <Fact label="Project" testId="cr.health.project" value={daemon.projectId} />
        <Fact label="Process id" value={String(daemon.pid)} />
        <Fact label="Command plane" testId="cr.health.plane" value={daemon.commandAuthorityPlane} />
        <Fact label="Protocol" value={daemon.protocolVersion} />
        <Fact label="Store" testId="cr.health.store" value={daemon.storePath} />
        <Fact label="Node specs" value={daemon.nodeSpecsDir ?? "none configured"} />
        <Fact label="Decisions recorded" testId="cr.health.decisions" value={String(ledger.decisionCount)} />
        <Fact label="Aggregates" value={String(ledger.aggregates)} />
        <Fact label="Command kinds used" value={String(ledger.commandKinds)} />
        <Fact label="Goals bound to a PRD" value={ledger.goals === null ? "unreadable" : String(ledger.goals)} />
      </dl>
      <p className="cr2-approve-banner" data-testid="cr.health.verifier">{verifierWords(outcome.verifier)}</p>
    </section>
  );
}
