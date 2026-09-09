import { useState } from "react";
import type { JSX } from "react";

import { ARROW_RIGHT } from "../glyphs.js";
import type { PreviewFacts } from "./needs-you-preview.js";
import type { PreviewDecision, PreviewFinding } from "./preview-port.js";

/**
 * GATE 2, RENDERED: the running product, the pictures of it, and the operator's two answers.
 *
 * THE LINK OPENS IN A NEW TAB and keeps the queue where it was. `rel="noreferrer"` is not
 * decoration: the target is the operator's own product on loopback, and a referrer would hand
 * it the control-room url for free. The daemon already refuses to SERVE a url that is not
 * http/https and carries no userinfo (preview-read.ts), so what arrives here is safe to click.
 *
 * THE SCREENSHOTS COME FROM THE CAPTURE ROUTE, never from a filesystem path. Each `src` was
 * built by `previewCaptureUrl` from the receipt's own project-relative path, so a picture that
 * cannot be placed inside this receipt's own previews directory is simply not offered.
 *
 * REJECT NAMES A NODE, and the roster is the ACTIVE GRAPH's own nodes from the runs read - not
 * free text. That is what makes DoD 3's "the findings name nodes of the active graph" true in
 * the browser as well as in the daemon, and it is why the reject control is disabled while the
 * runs read has answered nothing: a finding against a node that does not exist is refused.
 *
 * NO COLUMN MOVES ON REJECT, deliberately. The daemon records the verdict and its findings and
 * performs NO node transition, so this card must not imply one. What it offers instead is the
 * path back to work the product already has - open the goal, where the plan and the re-run
 * affordance live. Inventing a SEVENTH board column here would be a design regression (rail
 * 2), and `preview-rejection-invariants.test.tsx` sweeps this whole tree to keep it so - the
 * forbidden spelling is deliberately absent even from this sentence.
 *
 * ANNOUNCED ONCE. One short live region, rendered only after the daemon ANSWERS, carrying one
 * sentence whose text does not change while the queue keeps polling - so it is announced once
 * and not again. The findings list and the captures sit OUTSIDE it: a screen reader should
 * hear "sent back", not have the whole list read out every two seconds.
 */

export interface PreviewCardProps {
  /** True once the daemon accepted this card's decision. */
  readonly accepted: boolean;
  readonly busy: boolean;
  readonly facts: PreviewFacts;
  readonly onDecide: (decision: PreviewDecision, findings: readonly PreviewFinding[]) => void;
}

const NO_FINDINGS: readonly PreviewFinding[] = Object.freeze([]);

function Captures({ facts }: { readonly facts: PreviewFacts }): JSX.Element | null {
  if (facts.captures.length === 0) return null;
  return (
    <ul className="cr2-preview-shots" data-testid="cr.needsyou.preview.shots">
      {facts.captures.map((capture) => (
        <li className="cr2-preview-shot" key={capture.url}>
          <img alt={capture.alt} className="cr2-preview-image" src={capture.url} />
        </li>
      ))}
    </ul>
  );
}

function SentFindings({ findings }: {
  readonly findings: readonly PreviewFinding[];
}): JSX.Element | null {
  if (findings.length === 0) return null;
  return (
    <div className="cr2-preview-sent" data-testid="cr.needsyou.preview.sent">
      <p className="cr2-preview-sent-lead">
        Sent back. The nodes below carry your findings; nothing moved on the board, and the
        work continues from the plan.
      </p>
      <ul className="cr2-preview-sent-list">
        {findings.map((finding) => (
          <li
            className="cr2-preview-sent-item"
            data-testid={`cr.needsyou.preview.finding.${finding.nodeRef}`}
            key={finding.nodeRef}
          >
            <span className="cr2-preview-sent-node">{finding.nodeRef}</span>
            <span className="cr2-preview-sent-detail">{finding.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PreviewCard({ accepted, busy, facts, onDecide }: PreviewCardProps): JSX.Element {
  const [nodeRef, setNodeRef] = useState("");
  const [detail, setDetail] = useState("");
  const [sent, setSent] = useState<readonly PreviewFinding[]>(NO_FINDINGS);
  const chosen = nodeRef === "" ? facts.nodes[0]?.nodeRef ?? "" : nodeRef;
  const canReject = chosen !== "" && detail.trim() !== "" && !busy && !accepted;

  return (
    <div className="cr2-preview" data-testid="cr.needsyou.preview.root">
      <a
        className="cr2-preview-link"
        data-testid="cr.needsyou.preview.link"
        href={facts.url}
        rel="noreferrer"
        target="_blank"
      >
        {`Open your product ${ARROW_RIGHT} ${facts.url}`}
      </a>
      <Captures facts={facts} />
      {accepted && sent.length === 0 ? null : (
        <div className="cr2-preview-reject">
          <label className="cr2-preview-label" htmlFor="cr-preview-node">
            Which node has to change
          </label>
          <select
            className="cr2-preview-node"
            data-testid="cr.needsyou.preview.node"
            disabled={facts.nodes.length === 0 || busy || accepted}
            id="cr-preview-node"
            onChange={(event): void => setNodeRef(event.target.value)}
            value={chosen}
          >
            {facts.nodes.map((node) => (
              <option key={node.nodeRef} value={node.nodeRef}>
                {node.objective === "" ? node.nodeKey : `${node.nodeKey}: ${node.objective}`}
              </option>
            ))}
          </select>
          <label className="cr2-preview-label" htmlFor="cr-preview-detail">
            What is wrong with it
          </label>
          <textarea
            className="cr2-preview-detail"
            data-testid="cr.needsyou.preview.detail"
            disabled={busy || accepted}
            id="cr-preview-detail"
            onChange={(event): void => setDetail(event.target.value)}
            value={detail}
          />
          {facts.nodes.length === 0 ? (
            <p className="cr2-preview-hint" data-testid="cr.needsyou.preview.nonodes">
              The daemon has not named this goal nodes yet, so a finding cannot be written
              against one. Approve it, or open the goal to see the plan.
            </p>
          ) : null}
        </div>
      )}
      <div className="cr2-preview-actions">
        <button
          aria-label="Approve the running preview"
          className="cr2-btn"
          data-testid="cr.needsyou.preview.approve"
          data-variant="primary"
          disabled={busy || accepted}
          onClick={(): void => onDecide("APPROVE", NO_FINDINGS)}
          type="button"
        >
          Approve it
        </button>
        <button
          aria-label="Send the preview back with a finding"
          className="cr2-btn"
          data-testid="cr.needsyou.preview.reject"
          data-variant="secondary"
          disabled={!canReject}
          onClick={(): void => {
            const findings = Object.freeze([Object.freeze({ detail: detail.trim(), nodeRef: chosen })]);
            setSent(findings);
            onDecide("REJECT", findings);
          }}
          type="button"
        >
          Send it back with a finding
        </button>
      </div>
      {!accepted ? null : (
        <p
          aria-live="polite"
          className="cr2-preview-said"
          data-testid="cr.needsyou.preview.said"
          role="status"
        >
          {sent.length > 0
            ? "Sent back. The daemon recorded your findings."
            : "Approved. The daemon recorded your verdict."}
        </p>
      )}
      {accepted && sent.length > 0 ? <SentFindings findings={sent} /> : null}
    </div>
  );
}
