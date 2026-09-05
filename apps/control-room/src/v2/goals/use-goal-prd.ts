import { useCallback, useRef, useState } from "react";

import type { GoalDraftPrd } from "./goal-model.js";
import { PRD_LOCAL_LAYER } from "./new-goal-form-model.js";
import type { PrdReadState } from "./new-goal-form-model.js";

/**
 * Owns PRD selection for the new-goal form. Everything here happens IN THE
 * BROWSER: the file is read with `File.text()` and digested with
 * `crypto.subtle`, and no route is ever called.
 *
 * That is the point of the hook, not an implementation detail. Selecting a file
 * is not a decision to publish it, so selection must not write anything the
 * operator would then have to retract - no DocumentSourceTextRecorded row, no
 * work proposal, nothing durable at all. The bytes reach the daemon only when
 * the operator clicks Create, and then only inside the goal-creation command.
 */

export interface PrdFile {
  readonly name: string;
  readonly sha256: string;
  readonly size: number;
  /** The bytes this browser read; kept for the command, never posted on selection. */
  readonly text: string;
}

export type PrdFileReadRefusalCode =
  | "PRD_FILE_TOO_LARGE"
  | "PRD_FILE_UNREADABLE";

interface PrdFileReadRefusal {
  readonly code: PrdFileReadRefusalCode;
  readonly layer: typeof PRD_LOCAL_LAYER;
  readonly status: "ERROR";
}

interface PrdFileReadSuccess {
  readonly prd: PrdFile;
  readonly status: "READ";
  readonly submittedPrd: GoalDraftPrd;
}

export type PrdFileReadResult = PrdFileReadRefusal | PrdFileReadSuccess;

/** Browser preflight only; the daemon independently enforces its own byte limit. */
export const PRD_FILE_PREFLIGHT_MAX_BYTES = 128 * 1024;

const MARKDOWN_SUFFIXES = Object.freeze([".md", ".markdown"] as const);

/**
 * The media type this browser is willing to STAND BEHIND. A platform's own
 * `File.type` is not evidence - Windows reports an empty string for `.md` and a
 * page can be handed any string at all - so the type is derived from the name
 * that was read and narrowed to the shared admitted roster. Anything that is not
 * recognisably markdown is offered as plain text, which the roster also admits;
 * the daemon's contract independently re-admits whatever is sent.
 */
export function prdMediaType(name: string): GoalDraftPrd["mediaType"] {
  const lowered = name.toLowerCase();
  return MARKDOWN_SUFFIXES.some((suffix) => lowered.endsWith(suffix))
    ? "text/markdown"
    : "text/plain";
}

interface GoalPrdState {
  readonly acceptFile: (file: File | null | undefined) => void;
  readonly clearFile: () => void;
  readonly prd: PrdFile | null;
  readonly read: PrdReadState;
  /** Present only for a file this browser actually read; otherwise absent. */
  readonly submittedPrd: GoalDraftPrd | undefined;
}

function localError(code: PrdFileReadRefusalCode): PrdFileReadRefusal {
  return Object.freeze({ code, layer: PRD_LOCAL_LAYER, status: "ERROR" as const });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readGoalPrdFile(file: File): Promise<PrdFileReadResult> {
  if (file.size > PRD_FILE_PREFLIGHT_MAX_BYTES) {
    return localError("PRD_FILE_TOO_LARGE");
  }
  let text: string;
  let sha256: string;
  try {
    text = await file.text();
    sha256 = await sha256Hex(text);
  } catch {
    return localError("PRD_FILE_UNREADABLE");
  }
  const prd = { name: file.name, sha256, size: file.size, text };
  return {
    prd,
    status: "READ",
    submittedPrd: {
      localSha256: sha256,
      mediaType: prdMediaType(file.name),
      name: file.name,
      size: file.size,
      text,
    },
  };
}

export function useGoalPrd(): GoalPrdState {
  const [prd, setPrd] = useState<PrdFile | null>(null);
  const [read, setRead] = useState<PrdReadState>(null);
  const [submittedPrd, setSubmittedPrd] = useState<GoalDraftPrd | undefined>(undefined);
  const generationRef = useRef(0);

  const clearFile = useCallback((): void => {
    generationRef.current += 1;
    setPrd(null);
    setSubmittedPrd(undefined);
    setRead(null);
  }, []);

  const acceptFile = (file: File | null | undefined): void => {
    if (file === null || file === undefined) return;
    const generation = (generationRef.current += 1);
    setPrd(null);
    setSubmittedPrd(undefined);
    setRead("READING");
    void (async (): Promise<void> => {
      const result = await readGoalPrdFile(file);
      // A newer selection supersedes this one; a late read must not overwrite it.
      if (generationRef.current !== generation) return;
      if (result.status === "ERROR") {
        setRead(result);
        return;
      }
      setPrd(result.prd);
      // The BYTES travel with the draft: the source is written inside the
      // goal-creation command, so stripping them here would leave the dispatcher
      // with a digest and nothing to send.
      setSubmittedPrd(result.submittedPrd);
      setRead(Object.freeze({ sha256: result.prd.sha256, status: "READ" as const }));
    })();
  };

  return { acceptFile, clearFile, prd, read, submittedPrd };
}
