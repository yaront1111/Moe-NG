import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderPauseGate } from "./agent-provider-pause.js";
import {
  agentProviderFact, decideSeatProvider, isCodexCommand, pauseProviderOf, resolveAgentProvider,
  settingOf, spawnSeatFor,
} from "./agent-provider-resolve.js";
import { setAgentProvider } from "./agent-provider-store.js";
import type { ProviderPauseFacts } from "./agent-spawn-contract.js";

/** An EXACT-scope fake: it answers only the scopes the caller recorded, and null for
 *  every other goalId. The production port collapses goal->project itself, so a
 *  collapsing fake here would make rungs 2 and 3 indistinguishable and the sweep
 *  would pass while the goal override never fired. */
function facts(recorded: Readonly<Record<string, string>>): (goalId: string) => string | null {
  return (goalId: string) => recorded[goalId] ?? null;
}

/** Pins MOE_AGENT_COMMAND for one arm and restores it: rung 1 wins over every rung
 *  below, so an arm about rungs 2-4 that leaves a host value in place tests nothing. */
function withEnv<T>(value: string | undefined, run: () => T): T {
  const before = process.env["MOE_AGENT_COMMAND"];
  if (value === undefined) delete process.env["MOE_AGENT_COMMAND"];
  else process.env["MOE_AGENT_COMMAND"] = value;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env["MOE_AGENT_COMMAND"];
    else process.env["MOE_AGENT_COMMAND"] = before;
  }
}

describe("agent provider precedence", () => {
  it("takes MOE_AGENT_COMMAND over both the goal override and the project setting", () => {
    expect(resolveAgentProvider({
      envCommand: "C:\\tools\\claude.exe",
      goalRef: "goal-a",
      settingFor: facts({ "": "codex", "goal-a": "codex" }),
    })).toBe("C:\\tools\\claude.exe");
  });

  it("takes the goal override over the project setting when the env is unset", () => {
    expect(resolveAgentProvider({
      envCommand: null,
      goalRef: "goal-a",
      settingFor: facts({ "": "claude", "goal-a": "codex" }),
    })).toBe("codex");
  });

  it("takes the project setting when the goal carries no override", () => {
    expect(resolveAgentProvider({
      envCommand: null,
      goalRef: "goal-without-override",
      settingFor: facts({ "": "codex" }),
    })).toBe("codex");
  });

  it("takes the project setting for a seat with no goal ref at all", () => {
    expect(resolveAgentProvider({
      envCommand: null,
      goalRef: null,
      settingFor: facts({ "": "codex", "node-7": "claude" }),
    })).toBe("codex");
  });

  it("takes claude when nothing above it answers", () => {
    expect(resolveAgentProvider({
      envCommand: null, goalRef: "goal-a", settingFor: facts({}),
    })).toBe("claude");
    expect(resolveAgentProvider({})).toBe("claude");
  });

  it("treats a blank MOE_AGENT_COMMAND as unset rather than as a command", () => {
    expect(resolveAgentProvider({
      envCommand: "   ", goalRef: null, settingFor: facts({ "": "codex" }),
    })).toBe("codex");
  });

  it("treats an empty goal ref as no goal ref instead of reading the project scope twice", () => {
    expect(resolveAgentProvider({
      envCommand: null, goalRef: "", settingFor: facts({ "": "codex" }),
    })).toBe("codex");
  });

  it("falls to claude when the durable fact throws instead of wedging staffing", () => {
    expect(resolveAgentProvider({
      envCommand: null,
      goalRef: "goal-a",
      settingFor: () => { throw new Error("AGENT_PROVIDER_STORE_UNREADABLE"); },
    })).toBe("claude");
  });
});

describe("codex seat predicate", () => {
  it("matches a bare, extensioned and path-qualified codex command", () => {
    expect(isCodexCommand("codex")).toBe(true);
    expect(isCodexCommand("codex.exe")).toBe(true);
    expect(isCodexCommand("C:\\Users\\x\\bin\\codex.cmd")).toBe(true);
    expect(isCodexCommand("/usr/local/bin/codex")).toBe(true);
    expect(isCodexCommand("CODEX")).toBe(true);
  });

  it("does not match claude or a command that merely contains codex", () => {
    expect(isCodexCommand("claude")).toBe(false);
    expect(isCodexCommand("/usr/local/bin/claude")).toBe(false);
    expect(isCodexCommand("codex-helper")).toBe(false);
    expect(isCodexCommand("mycodex")).toBe(false);
  });
});

describe("spawner seat resolution", () => {
  it("takes the request's provider over the spawner option and the host env", () => {
    expect(withEnv("claude", () => spawnSeatFor("codex", "claude")))
      .toEqual({ codex: true, command: "codex" });
  });

  it("takes the spawner option when the request carries no provider", () => {
    expect(withEnv("codex", () => spawnSeatFor(undefined, "claude")))
      .toEqual({ codex: false, command: "claude" });
  });

  it("takes the host env when neither the request nor the option names one", () => {
    expect(withEnv("codex", () => spawnSeatFor(undefined, undefined)))
      .toEqual({ codex: true, command: "codex" });
  });

  it("takes claude when the request, the option and the host env are all absent", () => {
    expect(withEnv(undefined, () => spawnSeatFor(undefined, undefined)))
      .toEqual({ codex: false, command: "claude" });
  });
});

describe("pause ledger provider name", () => {
  it("names the ledger key from the resolved command, not from the environment", () => {
    expect(pauseProviderOf("codex")).toBe("codex");
    expect(pauseProviderOf("C:\\tools\\codex.exe")).toBe("codex");
    expect(pauseProviderOf("/usr/bin/claude")).toBe("claude");
  });

  it("reads an unknown command as claude so a scripted seat parks a real provider", () => {
    expect(pauseProviderOf("some-other-cli")).toBe("claude");
  });
});

describe("one step's seat decision", () => {
  /** Records which provider the pause was actually asked about, so an arm can prove the
   *  gate is consulted for the RESOLVED command and not for some frozen default. */
  function gateAsking(paused: string | null): {
    readonly asked: string[];
    readonly gate: ProviderPauseGate;
  } {
    const asked: string[] = [];
    const facts: ProviderPauseFacts = {
      provider: paused ?? "", resetAt: "2026-09-07T01:00:00.000Z",
      since: "2026-09-07T00:00:00.000Z",
    };
    const gate = {
      exitObserver: () => () => "FAILED" as const,
      paused: (_nowMs: number, provider?: string) => {
        asked.push(provider ?? "<unset>");
        return provider === paused ? facts : null;
      },
    } as unknown as ProviderPauseGate;
    return { asked, gate };
  }

  it("keys a goal-targeted step on its goal and consults the pause for that command", () => {
    const { asked, gate } = gateAsking(null);
    const seat = withEnv(undefined, () => decideSeatProvider({
      aggregateId: "goal-a", kind: "planning.submit_decomposition", nowMs: 0,
      pauseGate: gate, settingFor: (id) => (id === "goal-a" ? "codex" : "claude"),
    }));
    expect(seat).toEqual({ command: "codex", pause: null });
    expect(asked).toEqual(["codex"]);
  });

  it("keys a node.deliver step on the PROJECT scope, never on its nodeRef", () => {
    const seat = withEnv(undefined, () => decideSeatProvider({
      aggregateId: "node-7", kind: "node.deliver", nowMs: 0,
      // A nodeRef reaching the goal rung would answer "codex" here; the project scope wins.
      settingFor: (id) => (id === "node-7" ? "codex" : id === "" ? "claude" : null),
    }));
    expect(seat.command).toBe("claude");
  });

  it("reports the live pause for the seat's OWN provider and none for the other", () => {
    const claudePaused = gateAsking("claude");
    expect(withEnv(undefined, () => decideSeatProvider({
      aggregateId: "goal-a", kind: "review.submit", nowMs: 0,
      pauseGate: claudePaused.gate, settingFor: () => "codex",
    })).pause).toBeNull();
    expect(withEnv(undefined, () => decideSeatProvider({
      aggregateId: "goal-a", kind: "review.submit", nowMs: 0,
      pauseGate: claudePaused.gate, settingFor: () => "claude",
    })).pause).toMatchObject({ provider: "claude" });
    expect(claudePaused.asked).toEqual(["codex", "claude"]);
  });

  it("answers no pause at all when no gate is wired", () => {
    expect(withEnv(undefined, () => decideSeatProvider({
      aggregateId: "goal-a", kind: "review.submit", nowMs: 0,
    }))).toEqual({ command: "claude", pause: null });
  });

  it("still takes MOE_AGENT_COMMAND over the durable setting at the seat decision", () => {
    expect(withEnv("codex", () => decideSeatProvider({
      aggregateId: "goal-a", kind: "review.submit", nowMs: 0, settingFor: () => "claude",
    })).command).toBe("codex");
  });
});

describe("durable setting adapter", () => {
  const opened: SqliteEventStore[] = [];
  afterEach(() => {
    for (const store of opened.splice(0)) store.close();
  });

  it("reads a provider from an ok result and null from every refusal", () => {
    expect(settingOf({ ok: true, provider: "codex" })).toBe("codex");
    expect(settingOf({ ok: false, code: "AGENT_PROVIDER_STORE_UNREADABLE", layer: "DURABLE_STORE" }))
      .toBeNull();
    expect(settingOf({ ok: false, code: "AGENT_PROVIDER_SCOPE_INVALID", layer: "DURABLE_STORE" }))
      .toBeNull();
  });

  it("binds one store and project, and answers the goal scope ahead of the project one", () => {
    const projectId = "proj-fact";
    const store = SqliteEventStore.openEphemeralForProjectTest(projectId);
    opened.push(store);
    const fact = agentProviderFact(store, projectId);
    expect(fact("")).toBe("claude");
    const now = (): string => "2026-09-07T00:00:00.000Z";
    expect(setAgentProvider({ now, projectId, store }, { goalId: "", provider: "codex" }).ok)
      .toBe(true);
    expect(fact("")).toBe("codex");
    expect(setAgentProvider({ now, projectId, store }, { goalId: "goal-b", provider: "claude" }).ok)
      .toBe(true);
    expect(fact("goal-b")).toBe("claude");
    expect(fact("")).toBe("codex");
  });

  it("answers null rather than a provider when the store refuses the scope", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest("proj-fact-scope");
    opened.push(store);
    // A fact bound to a project the store does not serve must not answer "claude".
    expect(agentProviderFact(store, "proj-someone-else")("")).toBeNull();
  });
});
