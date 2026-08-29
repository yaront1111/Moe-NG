import { useRef, useState } from "react";

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
  readonly prd: PrdFile | null;
  readonly read: PrdReadState;
  /** Present only for a file this browser actually read; otherwise absent. */
  readonly submittedPrd: GoalDraftPrd | undefined;
}

function localError(code: string): Exclude<PrdReadState, null> {
  return Object.freeze({ code, layer: PRD_LOCAL_LAYER, status: "ERROR" as const });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function useGoalPrd(): GoalPrdState {
  const [prd, setPrd] = useState<PrdFile | null>(null);
  const [read, setRead] = useState<PrdReadState>(null);
  const [submittedPrd, setSubmittedPrd] = useState<GoalDraftPrd | undefined>(undefined);
  const generationRef = useRef(0);

  const acceptFile = (file: File | null | undefined): void => {
    if (file === null || file === undefined) return;
    const generation = (generationRef.current += 1);
    setPrd(null);
    setSubmittedPrd(undefined);
    if (file.size > PRD_FILE_PREFLIGHT_MAX_BYTES) {
      setRead(localError("PRD_FILE_TOO_LARGE"));
      return;
    }
    setRead("READING");
    void (async (): Promise<void> => {
      let text: string;
      try {
        text = await file.text();
      } catch {
        if (generationRef.current !== generation) return;
        setRead(localError("PRD_FILE_UNREADABLE"));
        return;
      }
      const sha256 = await sha256Hex(text);
      // A newer selection supersedes this one; a late read must not overwrite it.
      if (generationRef.current !== generation) return;
      setPrd({ name: file.name, sha256, size: file.size, text });
      // The BYTES travel with the draft: the source is written inside the
      // goal-creation command, so stripping them here would leave the dispatcher
      // with a digest and nothing to send.
      setSubmittedPrd({
        localSha256: sha256,
        mediaType: prdMediaType(file.name),
        name: file.name,
        size: file.size,
        text,
      });
      setRead(Object.freeze({ sha256, status: "READ" as const }));
    })();
  };

  return { acceptFile, prd, read, submittedPrd };
}
