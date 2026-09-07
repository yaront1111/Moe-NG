import { randomUUID } from "node:crypto";
import type { SqliteEventStore } from "@moe/store";
import { KNOWN_PROVIDERS } from "../http/health-read.js";
import {
  AGENT_PROVIDER_SCHEMA_VERSION, AGENT_PROVIDER_SCOPE_INVALID,
  AGENT_PROVIDER_STORE_UNREADABLE, agentProviderAggregateId,
} from "./agent-provider-contracts.js";

type AgentProvider = (typeof KNOWN_PROVIDERS)[number];
type ProviderCode = "AGENT_PROVIDER_UNKNOWN" | typeof AGENT_PROVIDER_SCOPE_INVALID
  | typeof AGENT_PROVIDER_STORE_UNREADABLE;
interface ProviderRefusal {
  readonly ok: false;
  readonly code: ProviderCode;
  readonly layer: "DURABLE_STORE";
}
interface ProviderRead { readonly ok: true; readonly provider: AgentProvider }
export type AgentProviderReadResult = ProviderRead | ProviderRefusal;
export type AgentProviderWriteResult = ProviderRefusal | Readonly<{
  ok: true; commandId: string; disposition: "COMMITTED" | "REPLAYED";
}>;
interface ProviderState { readonly ok: true; readonly values: ReadonlyMap<string, AgentProvider> }
const VERSION = AGENT_PROVIDER_SCHEMA_VERSION;
const EVENT_TYPE = "agent_provider.set";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface AgentProviderStoreConfig {
  readonly now: () => string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

export interface SetAgentProviderInput {
  readonly goalId: string;
  readonly provider: unknown;
  readonly commandId?: string;
  /** Retained in request identity when supplied by the operator command. */
  readonly base?: string;
}

function refused(code: ProviderCode): ProviderRefusal {
  return Object.freeze({ ok: false, code, layer: "DURABLE_STORE" });
}

function isProvider(value: unknown): value is AgentProvider {
  return typeof value === "string" && (KNOWN_PROVIDERS as readonly string[]).includes(value);
}

/** The leaf facts travel on, so a consumer of the store needs no second import — and so a
 *  consumer that must NOT import the store (see agent-provider-contracts.ts) can take them
 *  from the leaf without either side holding a duplicate literal. */
export {
  AGENT_PROVIDER_SCHEMA_VERSION, AGENT_PROVIDER_SCOPE_INVALID,
  AGENT_PROVIDER_STORE_UNREADABLE, agentProviderAggregateId,
} from "./agent-provider-contracts.js";

function readState(config: AgentProviderStoreConfig): ProviderState | ProviderRefusal {
  try {
    if (typeof config.projectId !== "string" || config.projectId.length === 0
      || config.store.getHealth().projectId !== config.projectId) {
      return refused(AGENT_PROVIDER_SCOPE_INVALID);
    }
    const values = new Map<string, AgentProvider>();
    for (const event of config.store.readEvents(agentProviderAggregateId(config.projectId))) {
      const body: unknown = JSON.parse(decoder.decode(event.payload));
      if (event.eventType !== EVENT_TYPE || typeof body !== "object" || body === null
        || Array.isArray(body) || Object.keys(body).length !== 3
        || !("version" in body) || body.version !== VERSION
        || !("goalId" in body) || typeof body.goalId !== "string"
        || !("provider" in body) || !isProvider(body.provider)) {
        return refused(AGENT_PROVIDER_STORE_UNREADABLE);
      }
      values.set(body.goalId, body.provider);
    }
    return { ok: true, values };
  } catch { return refused(AGENT_PROVIDER_STORE_UNREADABLE); }
}

/** Empty goalId is the existing command contract's project-default sentinel, not a real goal.
 * Keep it explicit instead of inventing a nullable field incompatible with that wire shape. */
export function readAgentProvider(config: AgentProviderStoreConfig, goalId: string): AgentProviderReadResult {
  if (typeof goalId !== "string") return refused(AGENT_PROVIDER_SCOPE_INVALID);
  const state = readState(config);
  if (!state.ok) return state;
  return Object.freeze({ ok: true, provider: state.values.get(goalId) ?? state.values.get("") ?? "claude" });
}

/** One event commit, like the environment store. A repeated command id may conflict rather than
 * replay because the event identity is fresh; the store owns that refusal and never writes twice.
 * No domain decision-ledger row is manufactured for this direct setting write. */
export function setAgentProvider(config: AgentProviderStoreConfig,
  input: SetAgentProviderInput): AgentProviderWriteResult {
  if (!isProvider(input.provider)) return refused("AGENT_PROVIDER_UNKNOWN");
  if (typeof input.goalId !== "string") return refused(AGENT_PROVIDER_SCOPE_INVALID);
  const state = readState(config);
  if (!state.ok) return state;
  const aggregate = agentProviderAggregateId(config.projectId);
  const result = config.store.commit({
    aggregateId: aggregate,
    commandBytes: encoder.encode(JSON.stringify({ kind: "project.set_agent_provider",
      projectId: config.projectId, goalId: input.goalId, provider: input.provider, base: input.base })),
    commandId: input.commandId ?? randomUUID(), committedAt: config.now(),
    expectedVersion: config.store.getAggregateVersion(aggregate),
    events: [{ eventId: randomUUID(), eventType: EVENT_TYPE,
      payload: encoder.encode(JSON.stringify({ version: VERSION, goalId: input.goalId, provider: input.provider })) }],
  });
  return Object.freeze({ ok: true, commandId: result.commandId, disposition: result.disposition });
}
