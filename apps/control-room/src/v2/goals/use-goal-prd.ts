import { useRef, useState } from "react";

import type { DocumentIngestOutcome, DocumentIngestRequest } from "../../live/live-document-ingest.js";
import type { GoalDraftPrd } from "./goal-model.js";
import { PRD_INGEST_NOTE } from "./new-goal-form-model.js";
import type { IngestState } from "./new-goal-form-model.js";

export interface PrdFile {
  readonly name: string;
  readonly size: number;
}

/** Browser preflight only; the daemon independently enforces its UTF-8 byte limit. */
export const PRD_FILE_PREFLIGHT_MAX_BYTES = 128 * 1024;

interface GoalPrdState {
  readonly acceptFile: (file: File | null | undefined) => void;
  readonly ingest: IngestState;
  readonly prd: PrdFile | null;
  readonly submittedPrd: GoalDraftPrd | undefined;
}

function notIngested(file: File, code?: string): GoalDraftPrd {
  return {
    ...(code === undefined ? {} : { code }),
    name: file.name,
    size: file.size,
    status: "NOT_INGESTED",
  };
}

/** Owns file reads and ingest receipts separately from the form's prose fields. */
export function useGoalPrd(
  onIngestPrd: ((request: DocumentIngestRequest) => Promise<DocumentIngestOutcome>) | undefined,
  seedOutcome: (seed: string) => void,
): GoalPrdState {
  const [prd, setPrd] = useState<PrdFile | null>(null);
  const [ingest, setIngest] = useState<IngestState>(null);
  const [submittedPrd, setSubmittedPrd] = useState<GoalDraftPrd | undefined>(undefined);
  const generationRef = useRef(0);

  const acceptFile = (file: File | null | undefined): void => {
    if (file === null || file === undefined) return;
    const generation = (generationRef.current += 1);
    setPrd({ name: file.name, size: file.size });
    setSubmittedPrd(notIngested(file));
    if (onIngestPrd === undefined) {
      setIngest(null);
      seedOutcome(`Ingest ${file.name} (${PRD_INGEST_NOTE})`);
      return;
    }
    if (file.size > PRD_FILE_PREFLIGHT_MAX_BYTES) {
      setSubmittedPrd(notIngested(file, "PRD_FILE_TOO_LARGE"));
      setIngest(Object.freeze({
        code: "PRD_FILE_TOO_LARGE", layer: "CONTROL_ROOM_NEWGOAL", status: "ERROR" as const,
      }));
      return;
    }
    setIngest("READING");
    void (async (): Promise<void> => {
      let text: string;
      try {
        text = await file.text();
      } catch {
        if (generationRef.current !== generation) return;
        setSubmittedPrd(notIngested(file, "PRD_FILE_UNREADABLE"));
        setIngest(Object.freeze({
          code: "PRD_FILE_UNREADABLE", layer: "CONTROL_ROOM_NEWGOAL", status: "ERROR" as const,
        }));
        return;
      }
      if (generationRef.current !== generation) return;
      const mediaType = file.name.endsWith(".md") ? "text/markdown" : "text/plain";
      const answer = await onIngestPrd({ displayPath: file.name, mediaType, text }).catch(() => ({
        code: "TRANSPORT_REQUEST_FAILED",
        layer: "CONTROL_ROOM_NEWGOAL",
        status: "ERROR" as const,
      }));
      if (generationRef.current !== generation) return;
      setIngest(answer);
      if (answer.status === "INGESTED") {
        setSubmittedPrd({
          contentSha256: answer.contentSha256,
          name: file.name,
          size: file.size,
          status: "INGESTED",
        });
        if (answer.candidateTitle !== null) seedOutcome(answer.candidateTitle);
      } else {
        setSubmittedPrd(notIngested(file, answer.code));
      }
    })();
  };

  return { acceptFile, ingest, prd, submittedPrd };
}
