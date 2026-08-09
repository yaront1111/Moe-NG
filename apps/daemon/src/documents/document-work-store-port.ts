import type {
  CommandDecisionKey,
  CommandDecisionRecord,
  CommandDecisionResponse,
  CommitExpectedVersionDecisionInput,
  CursorPage,
  StoredEvent,
} from "@moe/store";

/** The document service depends only on this narrow public durable-store surface. */
export interface DocumentWorkStorePort {
  readonly commitExpectedVersionDecision: (
    input: CommitExpectedVersionDecisionInput,
  ) => CommandDecisionResponse;
  readonly getAggregateVersion: (aggregateId: string) => number;
  readonly getCommandDecision: (key: CommandDecisionKey) => CommandDecisionRecord | null;
  readonly readAggregateEvents: (
    aggregateId: string,
    afterSequence: number,
    limit: number,
    maxBytes?: number,
  ) => CursorPage<StoredEvent, number>;
}
