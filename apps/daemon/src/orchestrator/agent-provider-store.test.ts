import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";
import { KNOWN_PROVIDERS } from "../http/health-read.js";
import { readAgentProvider, setAgentProvider } from "./agent-provider-store.js";
import type { AgentProviderStoreConfig } from "./agent-provider-store.js";

const opened: SqliteEventStore[] = [];
const directories: string[] = [];
const now = () => "2026-09-06T00:00:00.000Z";
function config(projectId = "provider-project"): AgentProviderStoreConfig {
  const store = SqliteEventStore.openEphemeralForProjectTest(projectId);
  opened.push(store);
  return { now, projectId, store };
}
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("durable agent provider settings", () => {
  it("defaults absent project and goal settings to claude without writing", () => {
    const c = config();
    const before = c.store.readEventHorizon();
    expect(readAgentProvider(c, "")).toEqual({ ok: true, provider: "claude" });
    expect(readAgentProvider(c, "goal-a")).toEqual({ ok: true, provider: "claude" });
    expect(c.store.readEventHorizon()).toBe(before);
  });

  it("resolves overrides before the project default and preserves both scopes", () => {
    const c = config();
    expect(setAgentProvider(c, { goalId: "", provider: "codex" }).ok).toBe(true);
    expect(readAgentProvider(c, "goal-a")).toEqual({ ok: true, provider: "codex" });
    expect(setAgentProvider(c, { goalId: "goal-a", provider: "claude" }).ok).toBe(true);
    expect(readAgentProvider(c, "goal-a")).toEqual({ ok: true, provider: "claude" });
    expect(readAgentProvider(c, "")).toEqual({ ok: true, provider: "codex" });
    expect(setAgentProvider(c, { goalId: "goal-a", provider: "codex" }).ok).toBe(true);
    expect(setAgentProvider(c, { goalId: "", provider: "claude" }).ok).toBe(true);
    expect(readAgentProvider(c, "")).toEqual({ ok: true, provider: "claude" });
    expect(readAgentProvider(c, "goal-a")).toEqual({ ok: true, provider: "codex" });
    expect(readAgentProvider(c, "goal-b")).toEqual({ ok: true, provider: "claude" });
  });

  it("reads the written event through a new instance against the same SQLite file", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-provider-"));
    directories.push(directory);
    const path = join(directory, "events.sqlite");
    const writer = SqliteEventStore.openForProject(path, "durable-provider");
    try {
      expect(setAgentProvider({ now, projectId: "durable-provider", store: writer },
        { goalId: "", provider: "codex" }).ok).toBe(true);
    } finally { writer.close(); }
    const reader = SqliteEventStore.openForProject(path, "durable-provider");
    opened.push(reader);
    expect(readAgentProvider({ now, projectId: "durable-provider", store: reader }, "new-goal"))
      .toEqual({ ok: true, provider: "codex" });
    expect(reader.readEventsAfter(0n, 10).items).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(reader.readEventsAfter(0n, 10).items[0]!.payload)))
      .toMatchObject({ goalId: "", provider: "codex" });
  });

  it("accepts exactly the shared provider roster, including a rejected third-name control", () => {
    const c = config();
    const candidates: readonly unknown[] = [...KNOWN_PROVIDERS, "third-provider", "", "CODEX", null, 7];
    const accepted = candidates.filter(provider => setAgentProvider(c, { goalId: "", provider }).ok);
    expect(accepted).toEqual([...KNOWN_PROVIDERS]);
    expect(accepted.length).toBeGreaterThan(0);
  });

  it.each(["third-provider", "", "CODEX", null, 7, {}])("refuses unknown provider %j without writes", provider => {
    const c = config();
    const before = c.store.readEventHorizon();
    expect(setAgentProvider(c, { goalId: "", provider })).toMatchObject({
      ok: false, code: "AGENT_PROVIDER_UNKNOWN", layer: "DURABLE_STORE",
    });
    expect(c.store.readEventHorizon()).toBe(before);
  });

  it("never treats a mismatched project binding as an absent default", () => {
    const c = config();
    const other = { ...c, projectId: "different-project" };
    expect(readAgentProvider(other, "")).toMatchObject({
      ok: false, code: "AGENT_PROVIDER_SCOPE_INVALID", layer: "DURABLE_STORE",
    });
    expect(setAgentProvider(other, { goalId: "", provider: "codex" })).toMatchObject({
      ok: false, code: "AGENT_PROVIDER_SCOPE_INVALID", layer: "DURABLE_STORE",
    });
    expect(c.store.readEventHorizon()).toBe(0n);
  });

  it.each([null, 7])("refuses a runtime non-string goal scope %j without writes", goalId => {
    const c = config();
    // Exercise the untyped boundary without weakening the public string contract.
    const malformed = goalId as unknown as string;
    expect(readAgentProvider(c, malformed)).toMatchObject({
      ok: false, code: "AGENT_PROVIDER_SCOPE_INVALID", layer: "DURABLE_STORE",
    });
    expect(setAgentProvider(c, { goalId: malformed, provider: "codex" })).toMatchObject({
      ok: false, code: "AGENT_PROVIDER_SCOPE_INVALID", layer: "DURABLE_STORE",
    });
    expect(c.store.readEventHorizon()).toBe(0n);
  });

  it.each([
    ["agent_provider.set", '{"version":"moe-agent-provider/1","goalId":"","provider":"third-provider"}'],
    ["agent_provider.set", '{"version":"unknown","goalId":"","provider":"codex"}'],
    ["agent_provider.set", '{"version":"moe-agent-provider/1","goalId":"","provider":"codex","extra":true}'],
    ["agent_provider.set", "{"],
    ["agent_provider.set", "null"],
    ["agent_provider.set", "[]"],
    ["unknown.event", '{"version":"moe-agent-provider/1","goalId":"","provider":"codex"}'],
  ])("fails closed on corrupt durable settings %s/%s instead of returning a default", (eventType, payload) => {
    const c = config();
    setAgentProvider(c, { goalId: "", provider: "codex" });
    const event = c.store.readEventsAfter(0n, 10).items[0]!;
    c.store.commit({ aggregateId: event.aggregateId, commandId: randomUUID(),
      commandBytes: new TextEncoder().encode("corrupt-setting"), committedAt: now(), expectedVersion: 1,
      events: [{ eventId: randomUUID(), eventType, payload: new TextEncoder().encode(payload) }] });
    expect(readAgentProvider(c, "goal-a")).toMatchObject({
      ok: false, code: "AGENT_PROVIDER_STORE_UNREADABLE", layer: "DURABLE_STORE",
    });
    const before = c.store.readEventHorizon();
    expect(setAgentProvider(c, { goalId: "", provider: "claude" })).toMatchObject({
      ok: false, code: "AGENT_PROVIDER_STORE_UNREADABLE", layer: "DURABLE_STORE",
    });
    expect(c.store.readEventHorizon()).toBe(before);
  });
});
