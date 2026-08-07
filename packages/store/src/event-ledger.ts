import { RECEIPT_OUTBOX_QUERY } from "./event-read-model.js";
import { EventTransactionStore } from "./event-ledger-transaction.js";

export { RECEIPT_OUTBOX_QUERY };

/** Public compatibility facade over the focused event-ledger layers. */
export class EventLedgerStore extends EventTransactionStore {}
