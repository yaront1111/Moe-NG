import type { DatabaseSync } from "node:sqlite";

import type {
  CommandDecisionKey,
  CommandDecisionRecord,
  CommandDecisionResponse,
  CommandReceipt,
  CommitExpectedVersionDecisionInput,
  CommitInput,
  CommitResult,
  CursorPage,
  PendingOutboxMessage,
  StoredEvent,
  StoreHealth,
} from "./store-contracts.js";
import type { CommitApply } from "./event-ledger-transaction.js";
import { DecisionTransactionStore } from "./decision-ledger-transaction.js";

class DecisionLedgerStore extends DecisionTransactionStore {
  public constructor(
    database: DatabaseSync,
    databasePath: string | null,
    durability: StoreHealth["durability"],
    projectId: string | null,
    writeProjectAsserted: boolean,
  ) {
    super(database, databasePath, durability, projectId, writeProjectAsserted);
  }

  public validateStartup(): void {
    this.validateAllReceipts();
    this.validateAllCommandDecisions();
    this.validateReservedDecisionNamespace();
  }
}

export interface DecisionLedgerCore {
  readonly close: () => void;
  readonly commit: (input: CommitInput) => CommitResult;
  readonly commitExpectedVersionDecision: (
    input: CommitExpectedVersionDecisionInput,
  ) => CommandDecisionResponse;
  readonly commitWithApply: (input: CommitInput, apply: CommitApply) => CommitResult;
  readonly getAggregateVersion: (aggregateId: string) => number;
  readonly getCommandDecision: (key: CommandDecisionKey) => CommandDecisionRecord | null;
  readonly getCommandReceipt: (commandId: string) => CommandReceipt | null;
  readonly getHealth: () => StoreHealth;
  readonly readAggregateEvents: (
    aggregateId: string,
    afterAggregateSequence?: number,
    limit?: number,
    maxDecodedBytes?: number,
  ) => CursorPage<StoredEvent, number>;
  readonly readCommandDecisionsAfter: (
    afterDecisionPosition: bigint,
    limit?: number,
    maxDecodedBytes?: number,
  ) => CursorPage<CommandDecisionRecord, bigint>;
  readonly readEvents: (aggregateId: string) => readonly StoredEvent[];
  readonly readEventsAfter: (
    afterGlobalPosition: bigint,
    limit?: number,
    maxDecodedBytes?: number,
  ) => CursorPage<StoredEvent, bigint>;
  readonly readPendingOutbox: (limit?: number) => readonly PendingOutboxMessage[];
  readonly readPendingOutboxPage: (
    afterOutboxPosition: bigint,
    limit?: number,
    maxDecodedBytes?: number,
  ) => CursorPage<PendingOutboxMessage, bigint>;
  readonly validateStartup: () => void;
}

export function createDecisionLedgerCore(
  database: DatabaseSync,
  databasePath: string | null,
  durability: StoreHealth["durability"],
  projectId: string | null,
  writeProjectAsserted: boolean,
): DecisionLedgerCore {
  const ledger = new DecisionLedgerStore(
    database,
    databasePath,
    durability,
    projectId,
    writeProjectAsserted,
  );
  return Object.freeze({
    close: () => ledger.close(),
    commit: (input: CommitInput) => ledger.commit(input),
    commitExpectedVersionDecision: (input: CommitExpectedVersionDecisionInput) =>
      ledger.commitExpectedVersionDecision(input),
    commitWithApply: (input: CommitInput, apply: CommitApply) =>
      ledger.commitWithApply(input, apply),
    getAggregateVersion: (aggregateId: string) => ledger.getAggregateVersion(aggregateId),
    getCommandDecision: (key: CommandDecisionKey) => ledger.getCommandDecision(key),
    getCommandReceipt: (commandId: string) => ledger.getCommandReceipt(commandId),
    getHealth: () => ledger.getHealth(),
    readAggregateEvents: (
      aggregateId: string,
      afterAggregateSequence?: number,
      limit?: number,
      maxDecodedBytes?: number,
    ) =>
      ledger.readAggregateEvents(
        aggregateId,
        afterAggregateSequence,
        limit,
        maxDecodedBytes,
      ),
    readCommandDecisionsAfter: (
      afterDecisionPosition: bigint,
      limit?: number,
      maxDecodedBytes?: number,
    ) => ledger.readCommandDecisionsAfter(afterDecisionPosition, limit, maxDecodedBytes),
    readEvents: (aggregateId: string) => ledger.readEvents(aggregateId),
    readEventsAfter: (
      afterGlobalPosition: bigint,
      limit?: number,
      maxDecodedBytes?: number,
    ) => ledger.readEventsAfter(afterGlobalPosition, limit, maxDecodedBytes),
    readPendingOutbox: (limit?: number) => ledger.readPendingOutbox(limit),
    readPendingOutboxPage: (
      afterOutboxPosition: bigint,
      limit?: number,
      maxDecodedBytes?: number,
    ) => ledger.readPendingOutboxPage(afterOutboxPosition, limit, maxDecodedBytes),
    validateStartup: () => ledger.validateStartup(),
  });
}
