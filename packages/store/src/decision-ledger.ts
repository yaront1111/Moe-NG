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
import type { CommitExpectedVersionDecisionLegsInput } from "./decision-legs-contracts.js";
import { RecoveryInitialInstallStore } from "./recovery-initial-install.js";
import type { RecoveryInitialInstallResult } from "./recovery-initial-install-contracts.js";
import type {
  RecoveryBindingReadResult,
  RecoveryInstallResult,
} from "./recovery-install-contracts.js";

class DecisionLedgerStore extends RecoveryInitialInstallStore {
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
    // One read snapshot for all three sweeps: assertAggregateTail issues two
    // SELECTs (head, then tail), and in autocommit a writer committing between
    // them would surface as a false STORE_CORRUPT on a healthy store — the
    // same hazard the public read paths already close with snapshot reads.
    this.readSnapshotOperation("startup validation", () => {
      // The receipt sweep memoizes each receipt it proves so the decision sweep
      // reuses that materialization instead of re-reading and re-hashing the
      // same rows; the memo lives exactly as long as this call.
      this.withStartupReceiptMemo(() => {
        this.validateAllReceipts();
        this.validateAllCommandDecisions();
        this.validateReservedDecisionNamespace();
      });
    });
  }
}

export interface DecisionLedgerCore {
  readonly readCommandDecisionCacheVersion: () => number;
  readonly close: () => void;
  readonly commit: (input: CommitInput) => CommitResult;
  readonly commitExpectedVersionDecision: (
    input: CommitExpectedVersionDecisionInput,
  ) => CommandDecisionResponse;
  readonly commitExpectedVersionDecisionLegs: (
    input: CommitExpectedVersionDecisionLegsInput,
  ) => CommandDecisionResponse;
  readonly commitExpectedVersionDecisionWithApply: (
    input: CommitExpectedVersionDecisionInput,
    apply: CommitApply,
  ) => CommandDecisionResponse;
  readonly commitWithApply: (input: CommitInput, apply: CommitApply) => CommitResult;
  readonly enumerateAggregateIdsByPrefix: (aggregateIdPrefix: string) => readonly string[];
  readonly getAggregateVersion: (aggregateId: string) => number;
  readonly getCommandDecision: (key: CommandDecisionKey) => CommandDecisionRecord | null;
  readonly getCommandReceipt: (commandId: string) => CommandReceipt | null;
  readonly getHealth: () => StoreHealth;
  readonly installInitialRecoveryBinding: (input: unknown) => RecoveryInitialInstallResult;
  readonly installRecoveryBinding: (input: unknown) => RecoveryInstallResult;
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
  readonly readEventHorizon: () => bigint;
  readonly readEventsAfter: (
    afterGlobalPosition: bigint,
    limit?: number,
    maxDecodedBytes?: number,
  ) => CursorPage<StoredEvent, bigint>;
  readonly readEventsByTypeAfter: (
    eventType: string,
    afterGlobalPosition: bigint,
    limit?: number,
    maxDecodedBytes?: number,
  ) => CursorPage<StoredEvent, bigint>;
  readonly readPendingOutbox: (limit?: number) => readonly PendingOutboxMessage[];
  readonly readRecoveryBinding: (slot: unknown) => RecoveryBindingReadResult;
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
    commitExpectedVersionDecisionLegs: (input: CommitExpectedVersionDecisionLegsInput) =>
      ledger.commitExpectedVersionDecisionLegs(input),
    commitExpectedVersionDecisionWithApply: (
      input: CommitExpectedVersionDecisionInput,
      apply: CommitApply,
    ) => ledger.commitExpectedVersionDecisionWithApply(input, apply),
    commitWithApply: (input: CommitInput, apply: CommitApply) =>
      ledger.commitWithApply(input, apply),
    enumerateAggregateIdsByPrefix: (aggregateIdPrefix: string) =>
      ledger.enumerateAggregateIdsByPrefix(aggregateIdPrefix),
    getAggregateVersion: (aggregateId: string) => ledger.getAggregateVersion(aggregateId),
    getCommandDecision: (key: CommandDecisionKey) => ledger.getCommandDecision(key),
    getCommandReceipt: (commandId: string) => ledger.getCommandReceipt(commandId),
    getHealth: () => ledger.getHealth(),
    installInitialRecoveryBinding: (input: unknown) => ledger.installInitialRecoveryBinding(input),
    installRecoveryBinding: (input: unknown) => ledger.installRecoveryBinding(input),
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
    readCommandDecisionCacheVersion: () => ledger.readCommandDecisionCacheVersion(),
    readCommandDecisionsAfter: (
      afterDecisionPosition: bigint,
      limit?: number,
      maxDecodedBytes?: number,
    ) => ledger.readCommandDecisionsAfter(afterDecisionPosition, limit, maxDecodedBytes),
    readEvents: (aggregateId: string) => ledger.readEvents(aggregateId),
    readEventHorizon: () => ledger.readEventHorizon(),
    readEventsAfter: (
      afterGlobalPosition: bigint,
      limit?: number,
      maxDecodedBytes?: number,
    ) => ledger.readEventsAfter(afterGlobalPosition, limit, maxDecodedBytes),
    readEventsByTypeAfter: (
      eventType: string,
      afterGlobalPosition: bigint,
      limit?: number,
      maxDecodedBytes?: number,
    ) => ledger.readEventsByTypeAfter(eventType, afterGlobalPosition, limit, maxDecodedBytes),
    readPendingOutbox: (limit?: number) => ledger.readPendingOutbox(limit),
    readRecoveryBinding: (slot: unknown) => ledger.readRecoveryBinding(slot),
    readPendingOutboxPage: (
      afterOutboxPosition: bigint,
      limit?: number,
      maxDecodedBytes?: number,
    ) => ledger.readPendingOutboxPage(afterOutboxPosition, limit, maxDecodedBytes),
    validateStartup: () => ledger.validateStartup(),
  });
}
