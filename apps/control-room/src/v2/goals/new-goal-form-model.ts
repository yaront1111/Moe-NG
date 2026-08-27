/** Small pure presentation helpers kept out of the form component. */

export const RISK_OPTIONS = Object.freeze(["STANDARD", "ELEVATED", "RESTRICTED"] as const);
export const PLACEHOLDER_OUTCOME =
  "Ship the scoped MCP stdio entry behind per-agent bearer credentials";
/** The layer every refusal on this path carries: the browser refused, no route was reached. */
export const PRD_LOCAL_LAYER = "CONTROL_ROOM_NEWGOAL";

/**
 * The state of a PRD the BROWSER read. There is deliberately no variant that can
 * hold a daemon answer: selecting a PRD reaches no route, so no code path here
 * can present a server receipt, and none can be mistaken for one.
 */
export type PrdReadState =
  | "READING"
  | { readonly code: string; readonly layer: typeof PRD_LOCAL_LAYER; readonly status: "ERROR" }
  | { readonly sha256: string; readonly status: "READ" }
  | null;

/** Render a local read state as one plain ASCII status line. */
export function prdStatusText(state: Exclude<PrdReadState, null>): string {
  if (state === "READING") return "Reading...";
  if (state.status === "READ") return `Read in this browser - sha256 ${state.sha256}`;
  return `Error - ${state.code} @ ${state.layer}`;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${String(size)} B`;
  const kib = size / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KB`;
  return `${(kib / 1024).toFixed(1)} MB`;
}
