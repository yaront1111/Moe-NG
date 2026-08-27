import type { DocumentIngestOutcome } from "../../live/live-document-ingest.js";

/** Small pure presentation helpers kept out of the form component. */

export const RISK_OPTIONS = Object.freeze(["STANDARD", "ELEVATED", "RESTRICTED"] as const);
export const PLACEHOLDER_OUTCOME =
  "Ship the scoped MCP stdio entry behind per-agent bearer credentials";
export const PRD_INGEST_NOTE = "Moe will read this once ingest is wired.";

export type IngestState = "READING" | DocumentIngestOutcome | null;

/** Render a live ingest state as one plain ASCII status line. */
export function ingestStatusText(state: Exclude<IngestState, null>): string {
  if (state === "READING") return "Reading...";
  if (state.status === "INGESTED") {
    return state.candidateTitle === null
      ? "Ingested - the daemon returned no candidate title"
      : `Ingested - candidate: ${state.candidateTitle}`;
  }
  if (state.status === "REFUSED") return `Refused - ${state.code}`;
  return `Error - ${state.code}`;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${String(size)} B`;
  const kib = size / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KB`;
  return `${(kib / 1024).toFixed(1)} MB`;
}
