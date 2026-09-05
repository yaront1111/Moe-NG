import { useEffect, useState } from "react";
import type { JSX } from "react";

import { CONTROL_ROOM_TRANSPORT_LAYER } from "@moe/control-room-client";
import type { ControlRoomTransport, SendResult } from "@moe/control-room-client";

import { createLiveDocumentDossierFeed, LIVE_DOCUMENT_DOSSIER_LOADING } from
  "../../live/live-document-dossier.js";
import type { DocumentDossierState } from "../../preview/document-dossier-state.js";
import { OutcomeNote } from "../components/outcome-note.js";
import { MIDDOT } from "../glyphs.js";
import { readFailedSaid } from "../outcome-words.js";

/**
 * THE DOCUMENT INTAKE DOSSIER, on the v2 PRD panel.
 *
 * REUSED, NOT REBUILT. The feed is the EXISTING createLiveDocumentDossierFeed and the state is
 * the EXISTING preview/document-dossier-state module, so one decoder answers for this read on
 * both surfaces and there is no second decoder free to disagree with the first.
 *
 * THE PRESENTATION IS v2-NATIVE, and that was measured rather than assumed. The existing
 * preview/document-dossier.tsx paints itself from styles/document-dossier.css, which is
 * reached only through the v1 control-room.css import chain; v2 never loads it, and 8 of the
 * 16 custom properties it reads (--cr-action, --cr-attention, --cr-attention-text,
 * --cr-attention-wash, --cr-font-utility, --cr-link, --cr-shadow-low, --cr-surface-muted) are
 * undefined in v2's token sheet. Dropping the component in unchanged would render its surface
 * gradient and its attention rail as invalid declarations; importing the v1 chain to fix that
 * is exactly the leak cordum-shell-firewall.test.tsx exists to stop. So this module renders
 * the same state through cr2 surfaces and touches neither the feed nor the state module.
 *
 * ABSENCE IS WORDS, NEVER BLANKNESS: a refused read shows its code and layer.
 */

const DOCUMENT_DOSSIER_PATH = "/documents/dossier/read";
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_INTERVAL_MS = 30_000;

export interface PrdDossierProps {
  readonly state: DocumentDossierState;
}

/** The one transport method the feed needs, over the attached session's headers. */
export function createDocumentDossierTransport(
  headers: Readonly<Record<string, string>>,
  send?: (body: string) => Promise<Response>,
): Pick<ControlRoomTransport, "readDocumentDossier"> {
  const post = send ?? ((body: string): Promise<Response> => fetch(DOCUMENT_DOSSIER_PATH, {
    body, headers, method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  return Object.freeze({
    readDocumentDossier: async (): Promise<SendResult> => {
      let response: Response;
      // The route's body fence is an EXACT empty object; it names no work.
      try {
        response = await post("{}");
      } catch {
        return Object.freeze({
          code: "TRANSPORT_REQUEST_FAILED" as const, delivered: false as const,
          layer: CONTROL_ROOM_TRANSPORT_LAYER,
        });
      }
      try {
        return Object.freeze({
          delivered: true as const, response: await response.json(), status: response.status,
        });
      } catch {
        return Object.freeze({
          code: "TRANSPORT_RESPONSE_UNREADABLE" as const, delivered: false as const,
          layer: CONTROL_ROOM_TRANSPORT_LAYER,
        });
      }
    },
  });
}

function SourceRow({ binding }: {
  readonly binding: {
    readonly byteLength: number; readonly contentSha256: string;
    readonly displayPath: string; readonly sourceRef: string;
  };
}): JSX.Element {
  return (
    <li
      className="cr2-approve-obligation"
      data-testid={`cr.prd.dossier.source.${binding.sourceRef}`}
    >
      <span className="cr2-approve-mono">{binding.sourceRef}</span>
      <span className="cr2-approve-step-body">
        {`${binding.displayPath} ${MIDDOT} ${binding.byteLength} bytes`}
      </span>
      <span className="cr2-approve-mono">{`sha256 ${binding.contentSha256}`}</span>
    </li>
  );
}

function CandidateRow({ candidate }: {
  readonly candidate: {
    readonly candidateRef: string; readonly objective: string;
    readonly sourceRefs: readonly string[]; readonly title: string;
  };
}): JSX.Element {
  return (
    <li
      className="cr2-approve-obligation"
      data-testid={`cr.prd.dossier.candidate.${candidate.candidateRef}`}
    >
      <span className="cr2-approve-mono">{candidate.candidateRef}</span>
      <span className="cr2-approve-step-body">{candidate.title}</span>
      <span className="cr2-approve-step-body">{candidate.objective}</span>
      <span className="cr2-approve-mono">
        {`cites ${candidate.sourceRefs.join(", ")}`}
      </span>
    </li>
  );
}

/** PURE. Every state the feed can be in has words of its own. */
export function PrdDossier({ state }: PrdDossierProps): JSX.Element {
  if (state.status === "LOADING") {
    return (
      <p className="cr2-slot-kicker" data-testid="cr.prd.dossier.loading" role="status">
        Reading the intake dossier...
      </p>
    );
  }
  if (state.status === "ERROR") {
    return (
      <OutcomeNote
        code={state.code}
        layer={state.layer}
        said={readFailedSaid("document dossier")}
        testId="cr.prd.dossier.refusal"
      />
    );
  }
  const { proposal } = state;
  return (
    <div className="cr2-approve-body" data-testid="cr.prd.dossier.body">
      <p className="cr2-approve-heading" data-testid="cr.prd.dossier.identity">
        {`${proposal.sources.length} source document${proposal.sources.length === 1 ? "" : "s"}`
          + ` ${MIDDOT} ${proposal.candidates.length} proposed work`
          + `${proposal.candidates.length === 1 ? "" : "s"}`
          + ` ${MIDDOT} advisory, proposed by an agent, authority ${proposal.authority}`}
      </p>
      <p className="cr2-approve-mono" data-testid="cr.prd.dossier.manifest">
        {`context manifest ${proposal.contextManifestDigest}`}
      </p>
      <ul className="cr2-approve-obligations">
        {proposal.sources.map((binding) => (
          <SourceRow binding={binding} key={binding.sourceRef} />
        ))}
      </ul>
      <ul className="cr2-approve-obligations">
        {proposal.candidates.map((candidate) => (
          <CandidateRow candidate={candidate} key={candidate.candidateRef} />
        ))}
      </ul>
    </div>
  );
}

export interface LivePrdDossierProps {
  readonly headers: Readonly<Record<string, string>>;
  readonly intervalMs?: number | undefined;
  /** Injectable for tests; the default reads POST /documents/dossier/read. */
  readonly transport?: Pick<ControlRoomTransport, "readDocumentDossier"> | undefined;
}

export function LivePrdDossier(
  { headers, intervalMs, transport }: LivePrdDossierProps,
): JSX.Element {
  const [state, setState] = useState<DocumentDossierState>(LIVE_DOCUMENT_DOSSIER_LOADING);
  useEffect(() => {
    const feed = createLiveDocumentDossierFeed({
      intervalMs: intervalMs ?? DEFAULT_INTERVAL_MS,
      onState: setState,
      transport: transport ?? createDocumentDossierTransport(headers),
    });
    feed.start();
    return (): void => { feed.stop(); };
  }, [headers, intervalMs, transport]);
  return (
    <section className="cr2-approve" data-testid="cr.prd.dossier.card">
      <p className="cr2-slot-kicker">Document intake, as the daemon proposed it</p>
      <PrdDossier state={state} />
    </section>
  );
}
