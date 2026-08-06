export type GraphAnalysisErrorCode =
  | "FRONTIER_GRAPH_IDENTITY_MISMATCH"
  | "FRONTIER_VALIDATION_PROVENANCE_INVALID"
  | "GRAPH_ANALYSIS_CYCLE_PRECONDITION_INVALID"
  | "GRAPH_VALIDATION_PROVENANCE_INVALID";

export class GraphAnalysisError extends Error {
  public readonly code: GraphAnalysisErrorCode;

  public constructor(code: GraphAnalysisErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "GraphAnalysisError";
    this.code = code;
  }
}
