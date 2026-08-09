import type { DaemonDependencyProvider } from "./daemon-entry.js";
import { streamPort } from "./http/event-stream-fixtures.js";
import type { CommandAdapterDeps } from "./http/http-contract.js";
import {
  CAPABILITY,
  authenticator,
  decisionPort,
  recordingHandler,
  registryOf,
} from "./http/http-test-fixtures.js";

/**
 * A dependency provider built from the committed HTTP fixtures, so the entry
 * point can be started as a real process without wiring a durable store.
 *
 * It adds NO authority: every part comes from `http-test-fixtures`, which the
 * committed adapter suite already uses. Wiring the production registry to the
 * event store is a separate task; until it lands, the bin refuses to start
 * unless a provider module is named explicitly.
 */
export function fixtureDependencies(): CommandAdapterDeps {
  return {
    authenticator: authenticator([CAPABILITY]),
    decisions: decisionPort(),
    registry: registryOf("goal.create", recordingHandler().handler, ["title"]),
  };
}

const provider: DaemonDependencyProvider = {
  provide: fixtureDependencies,
  subscriptions: () => streamPort(),
};

export default provider;
