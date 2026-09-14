/** Trusted maintenance adapter output; never accepted from a recovery command payload. */
export interface RepositoryReviewDrainEvidence {
  readonly controllerPid: number;
  readonly controllerStartedAt: string;
  readonly brokerPid: number;
  readonly brokerStartedAt: string;
  readonly cliPid: number;
  readonly daemonPid: number;
  readonly observedAt: string;
  readonly jobEmpty: true;
}

export interface RepositoryReviewDrainPort {
  drain(input: { readonly controllerPid: number; readonly notStartedAfter: string; readonly workspace: string }): Promise<
    { readonly ok: true; readonly evidence: RepositoryReviewDrainEvidence; readonly close: () => Promise<void> }
    | { readonly ok: false; readonly code: string; readonly detail: string }
  >;
}
