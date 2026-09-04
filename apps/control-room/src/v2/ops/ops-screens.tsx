import type { JSX } from "react";

import type { HealthOutcome, PolicyOutcome, PolicySliceKind, ProviderPauseView } from "../../live/live-ops.js";
import { OutcomeNote } from "../components/outcome-note.js";
import { ActionButton } from "../components/primitives.js";
import { MIDDOT } from "../glyphs.js";
import { readFailedSaid } from "../outcome-words.js";

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

/** "2 h 15 min" from a start instant; the raw instant stays in the fact list. */
function upFor(startedAt: string, nowMs: number): string {
  const at = Date.parse(startedAt);
  if (Number.isNaN(at)) return "an unknown time";
  const minutes = Math.max(0, Math.round((nowMs - at) / 60_000));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
  return `${String(Math.floor(hours / 24))} d ${String(hours % 24)} h`;
}

/**
 * What the fleet is waiting for, in the reader's own words and time zone.
 *
 * The reset instant is the daemon's fact; the LOCALE is the reader's, so the resume time is
 * formatted here rather than served pre-rendered. Date and time both, because a weekly limit
 * resumes on another day.
 */
function agentsWords(paused: ProviderPauseView | null): string {
  if (paused === null) return "not paused";
  const at = Date.parse(paused.resetAt);
  // An instant this browser cannot read is shown RAW, never as "Invalid Date", and never as calm:
  // hiding a live pause behind a formatting miss is the one thing this line must not do.
  const when = Number.isNaN(at) ? paused.resetAt : new Date(at).toLocaleString();
  return `paused: ${paused.provider} limit, resumes ${when}`;
}

function Refusal({ outcome, testId, what }: {
  readonly outcome: Extract<PolicyOutcome | HealthOutcome, { status: "ERROR" | "REFUSED" }>;
  readonly testId: string;
  readonly what: string;
}): JSX.Element {
  return (
    <OutcomeNote code={outcome.code} layer={outcome.layer} said={readFailedSaid(what)} testId={testId} />
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

/** What the screen knows about installing: the handler (null when no wire is attached), whether one is running, and each step's answer. */
export interface PolicyInstallState {
  readonly busy: boolean;
  readonly onInstall: (() => void) | null;
  readonly steps: readonly { readonly kind: string; readonly sliceRef: string; readonly outcome: { readonly ok: true } | { readonly code: string; readonly layer: string; readonly ok: false } }[];
}

export function PolicyScreen({ install, nowMs, outcome }: {
  readonly install?: PolicyInstallState | undefined; readonly nowMs: number; readonly outcome: PolicyOutcome | null;
}): JSX.Element {
  if (outcome === null) {
    return <section className="cr2-ops" data-testid="cr.policy.root"><p className="cr2-slot-kicker" data-testid="cr.policy.loading">Reading the policy...</p></section>;
  }
  if (outcome.status !== "POLICY") {
    return <section className="cr2-ops" data-testid="cr.policy.root"><Refusal outcome={outcome} testId="cr.policy.refusal" what="policy" /></section>;
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
      {outcome.standard.some((row) => !row.installed) ? (() => {
        const missing = outcome.standard.filter((row) => !row.installed);
        return (
          <div className="cr2-ops-card cr2-policy-standard" data-testid="cr.policy.standard">
            <p className="cr2-slot-kicker">{`Standard policy ${MIDDOT} ${String(missing.length)} of ${String(outcome.standard.length)} slices missing`}</p>
            <ul className="cr2-approve-obligations" data-testid="cr.policy.standard.list">
              {outcome.standard.map((row) => (
                <li className="cr2-coverage-section" data-installed={row.installed ? "true" : "false"} data-testid={`cr.policy.standard.${row.kind}`} key={row.sliceRef}>
                  <span className="cr2-approve-step-body">{`${KIND_WORDS[row.kind]} ${MIDDOT} ${row.installed ? "installed" : "missing"}`}</span>
                  <span className="cr2-approve-mono">{row.sliceRef}</span>
                </li>
              ))}
            </ul>
            <p className="cr2-needs-detail">
              The daemon states these bodies; installing spends its own policy.install offer once per missing slice, in this order.
              The reviewer calibration is self-declared by the bootstrap, not a measured corpus.
            </p>
            {install === undefined || install.onInstall === null ? (
              <p className="cr2-needs-note" data-testid="cr.policy.install.nowire">Pair a session with project.admin to install from here.</p>
            ) : (
              <ActionButton disabled={install.busy} onClick={install.onInstall} testId="cr.policy.install">
                {install.busy ? "Installing..." : `Install the standard policy (${String(missing.length)} ${missing.length === 1 ? "slice" : "slices"})`}
              </ActionButton>
            )}
          </div>
        );
      })() : null}
      {install === undefined || install.steps.length === 0 ? null : (
        <ol className="cr2-approve-obligations cr2-policy-steps" data-testid="cr.policy.install.steps">
          {install.steps.map((step) => (
            <li className="cr2-coverage-section" data-ok={step.outcome.ok ? "true" : "false"} key={step.sliceRef}>
              <span className="cr2-approve-step-body">{`${KIND_WORDS[step.kind as PolicySliceKind] ?? step.kind} ${MIDDOT} ${step.outcome.ok ? "installed from here" : "refused"}`}</span>
              <span className="cr2-approve-mono">{step.outcome.ok ? step.sliceRef : `${step.outcome.code} ${MIDDOT} ${step.outcome.layer}`}</span>
            </li>
          ))}
        </ol>
      )}
      <span className="cr2-goals-count" data-testid="cr.policy.count">
        {`${String(outcome.slices.length)} installed ${MIDDOT} ${String(outcome.evaluations.length)} evaluation${outcome.evaluations.length === 1 ? "" : "s"} ${MIDDOT} version ${String(outcome.aggregateVersion)}`}
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
    return <section className="cr2-ops" data-testid="cr.health.root"><Refusal outcome={outcome} testId="cr.health.refusal" what="health" /></section>;
  }
  const { daemon, ledger } = outcome;
  return (
    <section className="cr2-ops" data-testid="cr.health.root">
      <p className="cr2-approve-banner" data-reviewable="true" data-testid="cr.health.banner">
        {`The daemon answered ${ago(outcome.readAt, nowMs)} ${MIDDOT} up for ${upFor(daemon.startedAt, nowMs)} ${MIDDOT} last decision ${ago(ledger.lastDecidedAt, nowMs)}`}
      </p>
      <dl className="cr2-ops-facts" data-testid="cr.health.facts">
        <Fact label="Project" testId="cr.health.project" value={daemon.projectId} />
        <Fact label="Up since" testId="cr.health.since" value={daemon.startedAt} />
        <Fact label="Process id" value={String(daemon.pid)} />
        <Fact label="Command plane" testId="cr.health.plane" value={daemon.commandAuthorityPlane} />
        <Fact label="Protocol" value={daemon.protocolVersion} />
        <Fact label="Store" testId="cr.health.store" value={daemon.storePath} />
        <Fact label="Node specs" value={daemon.nodeSpecsDir ?? "none configured"} />
        <Fact label="Decisions recorded" testId="cr.health.decisions" value={String(ledger.decisionCount)} />
        <Fact label="Aggregates" value={String(ledger.aggregates)} />
        <Fact label="Command kinds used" value={String(ledger.commandKinds)} />
        <Fact label="Goals bound to a PRD" value={ledger.goals === null ? "unreadable" : String(ledger.goals)} />
        <Fact label="Agents" testId="cr.health.agents" value={agentsWords(outcome.agents.paused)} />
      </dl>
      <p className="cr2-approve-banner" data-testid="cr.health.verifier">{verifierWords(outcome.verifier)}</p>
    </section>
  );
}
