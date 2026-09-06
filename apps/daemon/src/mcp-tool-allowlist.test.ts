import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { STDIO_TOOL_INDEX, allowlistedToolEntries, toolLabelForKind } from "@moe/mcp";
import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { OPERATOR_PRINCIPAL_KINDS, PAYLOAD_KEYS } from "./daemon-command-vocabulary.js";
import { createStoreDependencies } from "./daemon-store-dependencies.js";
import { installTestRecoveryBinding } from "./identity/session-test-fixtures.js";
import { createMcpDispatchPort, servedMcpQueryKinds } from "./mcp-dispatch-port.js";
import { createProductContractReadPort } from "./product-contract/product-contract-read-port.js";
import {
  MCP_EXCLUDED_COMMAND_KINDS, MCP_SERVED_QUERY_KINDS, wiredMcpToolKinds,
} from "./mcp-tool-allowlist.js";

/**
 * The allowlist is DERIVED, never hand-copied — that is the whole point of the rail.
 *
 * The command half is asserted against the live `PAYLOAD_KEYS` import, so a kind another
 * task adds to the vocabulary flows through with no edit here. The query half cannot be
 * enumerated from the port (its branches are literals), so it is bound BEHAVIOURALLY:
 * every kind this module claims is served must survive the PRODUCTION dispatch port, and
 * a kind it does not claim must hit the port's generic INPUT_INVALID refusal.
 */

const CREDENTIAL = "allowlist-operator-credential";
const PROJECT = "proj-mcp-allowlist";

const directory = mkdtempSync(join(tmpdir(), "moe-mcp-allowlist-"));
const storePath = join(directory, "store.db");
const provider = createStoreDependencies({
  clock: () => "2026-08-09T12:00:00.000Z",
  credential: CREDENTIAL,
  principalId: "operator-local",
  projectId: PROJECT,
  storePath,
});
const setupStore = SqliteEventStore.openForProject(storePath, PROJECT);
installTestRecoveryBinding(setupStore);
setupStore.close();
const subscriptions = provider.subscriptions?.();
if (subscriptions === undefined) throw new Error("provider serves no subscription port");

const contractStore = SqliteEventStore.openForProject(storePath, PROJECT);
const port = createMcpDispatchPort({
  affordances: provider.affordances?.(),
  contract: createProductContractReadPort({ projectId: PROJECT, store: contractStore }),
  deps: provider.provide(),
  // Composed, not omitted: an ADVERTISED query whose port is absent falls through to the
  // port's generic INPUT_INVALID, which is exactly the "phantom tool" the arm below forbids.
  design: provider.designReads?.(),
  documents: provider.goalSource?.(),
  fallbackCredential: CREDENTIAL,
  graph: provider.graph?.(),
  subscriptions,
});

afterAll(() => {
  contractStore.close();
  provider.close();
  try {
    rmSync(directory, { force: true, recursive: true });
  } catch {
    // A held handle on Windows must not redden a suite that already answered.
  }
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const PAYLOAD_FOR: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  "design.read": { goalRef: "goal-allowlist-probe" },
  "documents.source_read": { goalRef: "goal-allowlist-probe" },
  "product_contract.read": { goalRef: "goal-allowlist-probe" },
  "events.read": { limit: 5, projection: "moe.board", subscriberId: "control-room-1" },
  "graph.get": { projectId: PROJECT },
  "work.get_context": { projectId: PROJECT },
});

/** The port's generic "this is not a query I serve" answer, by its exact code. */
function refusalCodeOf(queryKind: string): string | null {
  const bytes = port.dispatchQueryBytes(
    encoder.encode(JSON.stringify({ payload: PAYLOAD_FOR[queryKind] ?? {}, queryKind })),
  );
  const frame = JSON.parse(decoder.decode(bytes as Uint8Array)) as Record<string, unknown>;
  const error = frame["error"] as { code?: string } | undefined;
  return typeof error?.code === "string" ? error.code : null;
}

describe("wiredMcpToolKinds command half", () => {
  it("equals the daemon's wired command vocabulary MINUS the excluded kinds", () => {
    const commands = wiredMcpToolKinds().filter((kind) => !MCP_SERVED_QUERY_KINDS.includes(kind));
    const expected = [...Object.keys(PAYLOAD_KEYS)]
      .filter((kind) => !MCP_EXCLUDED_COMMAND_KINDS.includes(kind))
      .sort();

    expect(Object.keys(PAYLOAD_KEYS).length).toBeGreaterThan(0);
    // Both directions spelled out: advertised-not-expected AND expected-not-advertised.
    expect([...commands].sort()).toEqual(expected);
    expect(expected).toEqual([...commands].sort());
  });

  it("excludes kinds that are REAL vocabulary keys, and excludes them from the roster", () => {
    const wired = wiredMcpToolKinds();
    const vocabulary = Object.keys(PAYLOAD_KEYS);

    for (const kind of MCP_EXCLUDED_COMMAND_KINDS) {
      // A MISSPELLED member would exclude nothing and leave every other arm green, so the
      // roster is pinned against the vocabulary it claims to subtract from — by exact
      // string equality, never a prefix test: "approval.decide" is a prefix of the
      // unrelated kind "approval.decide_intent".
      expect({ kind, real: vocabulary.includes(kind) }).toEqual({ kind, real: true });
      expect({ advertised: wired.includes(kind), kind }).toEqual({ advertised: false, kind });
    }
  });

  it("advertises events.resume only through the command half", () => {
    const commands = wiredMcpToolKinds().filter((kind) =>
      !MCP_SERVED_QUERY_KINDS.includes(kind));

    expect(commands.filter((kind) => kind === "events.resume")).toHaveLength(1);
    expect(MCP_SERVED_QUERY_KINDS).not.toContain("events.resume");
  });

  it("advertises far fewer kinds than the MCP package generates", () => {
    const wired = wiredMcpToolKinds();

    expect(wired.length).toBe(
      Object.keys(PAYLOAD_KEYS).length
      - MCP_EXCLUDED_COMMAND_KINDS.length
      + MCP_SERVED_QUERY_KINDS.length,
    );
    expect(allowlistedToolEntries(wired).length).toBe(wired.length);
  });

  /**
   * ROSTER DENOMINATORS (epic rail 7). These pin the SIZE of the exclusion, not its members,
   * so a silent shrink is visible even when every membership arm above still passes.
   */
  it("pins an EXACT, frozen exclusion denominator and the derived roster size", () => {
    // EXACT, not `> 0`: a ONE-member roster satisfies `length > 0` while silently
    // re-admitting one approval kind to MCP, which is the precise regression this row exists
    // to prevent. Drilled by deletion in step 7 D3.
    expect(MCP_EXCLUDED_COMMAND_KINDS.length).toBe(17);
    expect(Object.isFrozen(MCP_EXCLUDED_COMMAND_KINDS)).toBe(true);
    // Every operator-only kind but the operator's own scoped-session mint is off the MCP roster:
    // the exclusion is the vocabulary's human-only class, so a kind that joins it leaves the
    // roster with no edit here. `session.open` is the documented exception.
    const operatorOnly = [...OPERATOR_PRINCIPAL_KINDS].filter((kind) => kind !== "session.open").sort();
    expect([...MCP_EXCLUDED_COMMAND_KINDS].sort()).toEqual(operatorOnly);
    for (const kind of operatorOnly) expect(wiredMcpToolKinds()).not.toContain(kind);
    expect(wiredMcpToolKinds()).toContain("session.open");

    // The DERIVED denominator, from live imports on both sides, so it stays true as the
    // vocabulary grows and reds the moment the subtraction stops happening.
    expect(wiredMcpToolKinds().length).toBe(
      Object.keys(PAYLOAD_KEYS).length
      - MCP_EXCLUDED_COMMAND_KINDS.length
      + MCP_SERVED_QUERY_KINDS.length,
    );
    // The measured values behind that identity at delivery: 45 - 5 + 5 = 45. Pinned as a
    // second, INDEPENDENT witness: the identity above would still hold if both sides moved
    // together, and these literals would not. task-b8272ee0 moved vocabulary and excluded
    // together by one — `cutover.activate` is registered AND withheld from MCP — and the
    // human-approver fence widening moved excluded alone by one more
    // (`approval.decide_intent` left the MCP roster the moment paired HUMAN principals
    // could take the witness); `wired` moves only when the subtraction itself changes.
    // Deriving the exclusion from OPERATOR_PRINCIPAL_KINDS (less `session.open`) moved
    // excluded from 6 to 11: the five operator-only kinds that had stayed advertised left.
    expect({
      excluded: MCP_EXCLUDED_COMMAND_KINDS.length,
      queries: MCP_SERVED_QUERY_KINDS.length,
      vocabulary: Object.keys(PAYLOAD_KEYS).length,
      wired: wiredMcpToolKinds().length,
    // task-a2409cba moved BOTH sides by three and `wired` by ZERO, which is the point:
    // `environment.set_variable`, `environment.unset_variable` and `repository.bootstrap`
    // entered the vocabulary AND the operator-only class in the same change, so each one was
    // subtracted the moment it was added and never spent a commit MCP-advertised.
    // task-06ac0da1 moved `vocabulary` and `queries` by one each and `excluded` by ZERO, and
    // that zero IS the row: `design.submit` is a SEAT kind, so it entered the vocabulary
    // WITHOUT entering the operator-only class, and `wired` therefore moved by two -- one
    // advertised command plus one advertised query (`design.read`). A `design.submit` that had
    // been copied into OPERATOR_PRINCIPAL_KINDS by habit would show here as excluded: 18,
    // wired: 43.
    }).toEqual({ excluded: 17, queries: 7, vocabulary: 54, wired: 44 });
  });

  it("is deterministic and frozen", () => {
    expect(wiredMcpToolKinds()).toEqual(wiredMcpToolKinds());
    expect(Object.isFrozen(wiredMcpToolKinds())).toBe(true);
  });
});

describe("wiredMcpToolKinds query half, bound to the production port", () => {
  it("claims a nonempty query roster", () => {
    expect(MCP_SERVED_QUERY_KINDS.length).toBeGreaterThan(0);
  });

  it("names only query kinds the production port actually serves", () => {
    for (const queryKind of MCP_SERVED_QUERY_KINDS) {
      // A served kind may still refuse for its own reasons; what it must never do is
      // fall through to the port's generic unknown-query refusal.
      expect({ code: refusalCodeOf(queryKind), queryKind })
        .not.toEqual({ code: "INPUT_INVALID", queryKind });
    }
  });

  it("leaves an unserved query kind refused with the port's own stable code", () => {
    expect(MCP_SERVED_QUERY_KINDS).not.toContain("documents.dossier_read");

    expect(refusalCodeOf("documents.dossier_read")).toBe("INPUT_INVALID");
  });

  it("puts every claimed query kind into the derived allowlist", () => {
    const wired = wiredMcpToolKinds();

    for (const queryKind of MCP_SERVED_QUERY_KINDS) {
      expect({ kind: queryKind, listed: wired.includes(queryKind) })
        .toEqual({ kind: queryKind, listed: true });
    }
  });
});

/**
 * task-4dd05f0c: the roster rail wants BIDIRECTIONAL set-equality against the IMPLEMENTATION
 * SEAM, not a subset check computed by iterating the roster itself. Two independent
 * enumerations exist on purpose — the advertised roster (`wiredMcpToolKinds`) and the served
 * sets read out of production (`registry.keys()` for commands, `servedMcpQueryKinds()` for
 * queries) — so deleting an entry from either side reddens, which a self-iterating test
 * cannot see.
 */

const decisionsIn = (): readonly { readonly commandKind: string }[] => {
  const store = SqliteEventStore.openForProject(storePath, PROJECT);
  try {
    const items: { readonly commandKind: string }[] = [];
    let cursor = 0n;
    for (;;) {
      const page = store.readCommandDecisionsAfter(cursor, 100);
      items.push(...page.items);
      if (page.nextCursor === null || page.items.length === 0) return items;
      cursor = page.nextCursor;
    }
  } finally {
    store.close();
  }
};

describe("task-4dd05f0c served/advertised parity", () => {
  it("C1 advertises exactly the commands the registry serves, MINUS the excluded kinds", () => {
    const served = [...provider.provide().registry.keys()].sort();
    const advertised = wiredMcpToolKinds()
      .filter((kind) => !(MCP_SERVED_QUERY_KINDS as readonly string[]).includes(kind))
      .sort();
    const expected = served
      .filter((kind) => !MCP_EXCLUDED_COMMAND_KINDS.includes(kind));

    expect(served.length).toBeGreaterThan(0);
    expect(new Set(served).size).toBe(served.length);
    // Both directions spelled out: advertised-not-expected AND expected-not-advertised.
    expect(advertised).toEqual(expected);
    expect(expected).toEqual(advertised);
  });

  it("C2 keeps every excluded kind SERVED by the registry — this closes ONE transport", () => {
    // Widened to string[] deliberately: `registry.keys()` is typed as the closed command-kind
    // union, and MCP_EXCLUDED_COMMAND_KINDS is `readonly string[]` so the roster can name a
    // kind the union does not yet carry. Comparing as strings is what makes the misspelling
    // arm above meaningful — a union-typed compare would be a compile error, not a red test.
    const served: readonly string[] = [...provider.provide().registry.keys()];

    // The point of the row, stated as an assertion: the kinds leave the MCP ADVERTISEMENT
    // and stay fully wired in the daemon, so the browser/HTTP approval path is untouched.
    // Without this arm, deleting them from PAYLOAD_KEYS outright would also pass C1.
    for (const kind of MCP_EXCLUDED_COMMAND_KINDS) {
      expect({ kind, served: served.includes(kind) }).toEqual({ kind, served: true });
    }
  });

  it("C3 names the ONE advertised kind the /2 plane withholds, so the gap stays visible", () => {
    // The MCP port now follows the plane per dispatch (mcp-dispatch-port.ts), so after
    // `cutover.activate` every advertised command is answered by the /2 registry. That
    // registry withholds `planning.submit_decomposition` on purpose until its /2 service
    // lands; an agent calling it then gets the registry's exact REGISTRY refusal rather
    // than a fallback. This arm pins that set to exactly one kind, in both directions: a
    // second withheld kind, or the withheld kind quietly served, reddens here.
    const v2 = provider.provideV2?.();
    if (v2 === undefined) throw new Error("the /2 plane is always composed");
    const servedOnV2 = new Set<string>([...v2.registry.keys()]);
    const advertisedCommands = wiredMcpToolKinds()
      .filter((kind) => !(MCP_SERVED_QUERY_KINDS as readonly string[]).includes(kind));
    expect(advertisedCommands.filter((kind) => !servedOnV2.has(kind)))
      .toEqual(["planning.submit_decomposition"]);
    // And nothing /2 serves is missing from the advertisement, minus the excluded kinds.
    expect([...servedOnV2].filter((kind) => !MCP_EXCLUDED_COMMAND_KINDS.includes(kind))
      .filter((kind) => !advertisedCommands.includes(kind))).toEqual([]);
  });

  it("Q1 advertises exactly the queries the production port serves", () => {
    const served = [...servedMcpQueryKinds()].sort();
    const advertised = [...MCP_SERVED_QUERY_KINDS].sort();

    expect(served.length).toBeGreaterThan(0);
    expect(new Set(served).size).toBe(served.length);
    expect(advertised).toEqual(served);
    expect(served).toEqual(advertised);
  });

  it("Q2 routes every query through the enumerable table, with no literal branch left", () => {
    const source = readFileSync(new URL("./mcp-dispatch-port.ts", import.meta.url), "utf8");
    const pattern = /envelope\["queryKind"\]\s*[!=]==\s*"([^"]+)"/gu;
    // Positive control: the regex still matches the shape it was written for, so an
    // empty match set means "no literal branches", never "the anchor silently rotted".
    const control = [...'if (envelope["queryKind"] === "graph.get") {'.matchAll(pattern)]
      .map((match) => match[1]);
    expect(control).toEqual(["graph.get"]);

    expect([...source.matchAll(pattern)].map((match) => match[1])).toEqual([]);
    expect(servedMcpQueryKinds().length).toBeGreaterThanOrEqual(4);
  });

  it("S1 generates events_resume once, on the command surface", () => {
    const entries = allowlistedToolEntries(wiredMcpToolKinds())
      .filter((entry) => entry.tool.name === "events_resume");

    expect(entries).toHaveLength(1);
    expect(entries[0]?.surface).toBe("command");
    expect(entries[0]?.kind).toBe("events.resume");
  });

  it("P1 refuses an inherited Object.prototype key as a query kind", () => {
    // The table lookup is on ATTACKER-CONTROLLED wire input. A plain object literal still
    // inherits from Object.prototype, so "toString" and friends resolve to real functions
    // and would be CALLED as handlers. Each must reach the port's generic refusal instead.
    for (const queryKind of [
      "toString", "constructor", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf",
    ]) {
      const bytes = port.dispatchQueryBytes(
        encoder.encode(JSON.stringify({ payload: {}, queryKind })),
      );
      const frame = JSON.parse(decoder.decode(bytes as Uint8Array)) as Record<string, unknown>;

      expect({ code: (frame["error"] as { code?: string } | undefined)?.code, queryKind })
        .toEqual({ code: "INPUT_INVALID", queryKind });
      expect({ ok: frame["ok"], queryKind }).toEqual({ ok: false, queryKind });
    }
    expect(servedMcpQueryKinds()).not.toContain("toString");
  });

  it("D2 refuses events.resume on the query seam and writes no durable decision", () => {
    const before = decisionsIn();
    const bytes = port.dispatchQueryBytes(encoder.encode(JSON.stringify({
      payload: {
        presentedCursor: { generation: 0, position: "0" },
        projection: "moe.board",
        subscriberId: "control-room-1",
      },
      queryKind: "events.resume",
    })));
    const frame = JSON.parse(decoder.decode(bytes as Uint8Array)) as Record<string, unknown>;

    expect((frame["error"] as { code?: string } | undefined)?.code).toBe("INPUT_INVALID");
    expect(frame["ok"]).toBe(false);
    const after = decisionsIn();
    expect(after.filter((item) => item.commandKind === "events.resume")).toEqual([]);
    expect(after.length).toBe(before.length);
  });
});

/**
 * task-5f883e4e: `preview.decide` NAMED, not merely counted.
 *
 * The arms above are set arithmetic over whole rosters, so `preview.decide` is only ever
 * visible in them through a moving count literal a sibling kind-publishing row bumps. These
 * three name it, and each closes a different way the fence could be hollow:
 *
 *  - membership in BOTH directions (excluded AND unadvertised), so deleting it from
 *    `OPERATOR_PRINCIPAL_KINDS` reddens here by name rather than as `expected 10 to be 11`;
 *  - the tool label is GENERATED, which is the discriminator between the two refusal
 *    branches: `http-tool-bridge.ts:195` answers a KNOWN-but-omitted label with
 *    CAPABILITY_DENIED, `:193` answers an UNKNOWN one with INPUT_INVALID. A kind that
 *    vanished from the generated surface would also be "not advertised" — and would refuse
 *    for the wrong reason, which is not the fence this row is claiming;
 *  - the daemon's OWN seam still SERVES it under the operator credential, reaching the
 *    handler's refusal rather than an authorization one. That is what makes the exclusion
 *    load-bearing: the MCP port dispatches as the operator bootstrap credential
 *    (`mcp-dispatch-port.ts:343`, `mcp-main.ts:112-127`), so a capability gate would fence
 *    nothing and only omission from the advertisement refuses the caller.
 */
describe("task-5f883e4e preview.decide is fenced to the operator", () => {
  const PREVIEW_DECIDE = "preview.decide";

  it("is excluded from the MCP advertisement, in both directions, BY NAME", () => {
    expect(MCP_EXCLUDED_COMMAND_KINDS).toContain(PREVIEW_DECIDE);
    expect(wiredMcpToolKinds()).not.toContain(PREVIEW_DECIDE);
    // The roster is DERIVED from the vocabulary's operator-only class, so this is the
    // upstream fact the exclusion is computed from — not a second hand-kept list. Widened to
    // a string Set rather than cast at the call: `OPERATOR_PRINCIPAL_KINDS` is typed by the
    // closed command-kind union, and a cast would make a kind that LEFT the union a silent
    // pass instead of the compile error it should be.
    const operatorOnly: ReadonlySet<string> = OPERATOR_PRINCIPAL_KINDS;
    expect(operatorOnly.has(PREVIEW_DECIDE)).toBe(true);
    // A surviving control: a staffable kind of the same shape stays advertised, so
    // "advertises nothing" cannot pass this arm.
    expect(wiredMcpToolKinds()).toContain("goal.create");
  });

  it("is GENERATED but omitted, so the transport refuses CAPABILITY_DENIED, not INPUT_INVALID", () => {
    const label = toolLabelForKind(PREVIEW_DECIDE);
    // Derived through the production helper: a hand-spelled name would be UNKNOWN and would
    // green this arm on the INPUT_INVALID branch instead.
    expect(STDIO_TOOL_INDEX.get(label)).toBeDefined();
    const advertised = new Set(allowlistedToolEntries(wiredMcpToolKinds())
      .map((entry) => entry.tool.name));
    expect({ advertised: advertised.has(label), label })
      .toEqual({ advertised: false, label });
    expect(advertised.has(toolLabelForKind("goal.create"))).toBe(true);
  });

  it("still reaches the HANDLER on the daemon's own seam under the operator credential", async () => {
    const before = decisionsIn();
    const bytes = await port.dispatchCommandBytes(encoder.encode(JSON.stringify({
      commandId: "cmd-preview-decide-allowlist",
      commandKind: PREVIEW_DECIDE,
      correlationId: "corr-preview-decide-allowlist",
      expectedVersion: 0,
      // EMPTY on purpose: the preview decoder refuses the missing decision at REQUEST, which
      // is a HANDLER refusal. An authorization refusal (OPERATOR_PRINCIPAL_REQUIRED at
      // DAEMON_AUTHORIZATION) would mean the seam never reached the handler at all, and the
      // exclusion in the roster above would not be what is fencing the MCP caller.
      payload: {},
      requestDigest: "a".repeat(64),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: CREDENTIAL,
      targetAggregateId: "agg-preview-decide-allowlist",
    })));
    const frame = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
    const refusal = frame["refusal"] as { code?: string; layer?: string } | undefined;

    // Code AND layer together: the code alone cannot say WHICH layer refused.
    expect({ code: refusal?.code, layer: refusal?.layer })
      .toEqual({ code: "PREVIEW_DECISION_INVALID", layer: "REQUEST" });
    // The STAGE is the discriminator this arm turns on. `DISPATCH` means the seam ran the
    // command; an operator-principal refusal would answer earlier and never reach it, which
    // is exactly the outcome an MCP caller gets — and why the roster, not a capability, is
    // what fences that caller.
    expect(frame["stage"]).toBe("DISPATCH");
    expect(frame["outcome"]).toBe("PORT_REFUSED");
    expect(frame["ok"]).toBe(false);
    // A refused decision commits nothing, so the exclusion cannot be read as "harmless
    // because the command is inert" — it is a real seam that would have run.
    expect(decisionsIn().length).toBe(before.length);
  });
});
