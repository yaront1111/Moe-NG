import type {
  StreamCursor, StreamRefused, WireCursor,
} from "./event-stream-contract.js";

export interface StreamAcknowledgeRequest {
  readonly cursor: StreamCursor;
  readonly subscriberId: string;
}

export interface StreamAcknowledged {
  readonly cursor: StreamCursor;
  readonly outcome: "ACKNOWLEDGED";
}

export type StreamAcknowledgeResult = StreamAcknowledged | StreamRefused;

export interface EventAcknowledgeRequest {
  /** Compared with the server's pending offer; never treated as authority. */
  readonly presentedCursor: WireCursor;
  readonly subscriberId: string;
}

export interface EventAcknowledgedFrame {
  readonly cursor: WireCursor;
  readonly outcome: "ACKNOWLEDGED";
}

export type EventAcknowledgeFrame = EventAcknowledgedFrame | StreamRefused;
