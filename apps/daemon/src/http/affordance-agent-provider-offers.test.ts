import { buildNextAllowedCommands } from "@moe/contracts";
import { afterAll, describe, expect, it } from "vitest";

import {
  PROJECT_ID as BOOTSTRAP_PROJECT,
  closeStores as closeBootstrapStores,
  openStore as openBootstrapStore,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { SETTINGS_FAMILY, familyCapabilityOf } from "../daemon-command-vocabulary.js";
import {
  AGENT_PROVIDER_COMMAND_KIND, AGENT_PROVIDER_SCHEMA_VERSION, agentProviderAggregateId,
} from "../orchestrator/agent-provider-contracts.js";
import { setAgentProvider } from "../orchestrator/agent-provider-store.js";
import { resolveAgentProviderOffers } from "./affordance-agent-provider-offers.js";
import { createAffordancePort } from "./affordance-read.js";

/**
 * THE SEAM THIS FILE GUARDS: a command served by the daemon but never OFFERED by
 * `/affordances/read` is a dead control in the browser, and every other suite stays green
 * while it rots. `project.set_agent_provider` shipped that way — registry row, capability
 * binding, MCP exclusion, generated client, browser port and rendered toggle all present,
 * offer absent — so `commandBuilderFor` refused INPUT_INVALID for want of an affordance and
 * the toggle greyed itself under copy blaming the operator for not pairing.
 *
 * Every arm below reads the PRODUCTION surface (`createAffordancePort(...).readSurface()`),
 * never the resolver alone, except where the resolver's own refusal code is the subject.
 */

const decoder = new TextDecoder("utf-8", { fatal: true });
let minted = 0;

afterAll(() => { closeBootstrapStores(); });

function world() {
  const store = openBootstrapStore();
  const port = createAffordancePort({
    mintId: (kind: string) => `afford-provider-${kind}-${String(minted += 1)}`,
    projectId: BOOTSTRAP_PROJECT,
    store,
  });
  return { port, store };
}

function readOffers(port: ReturnType<typeof createAffordancePort>) {
  const result = port.readSurface();
  if (result.outcome !== "SURFACE") throw new Error(`refused: ${result.code}`);
  return result.nextAllowedCommands;
}

function providerOffersOf(port: ReturnType<typeof createAffordancePort>) {
  return readOffers(port).filter((entry) => entry.commandKind === AGENT_PROVIDER_COMMAND_KIND);
}

describe("the settings roster is served and advertised in BOTH directions", () => {
  /**
   * Global rail 9. A single-direction arm cannot see this defect: iterating the offers and
   * checking each is a known kind shrinks its own iteration when a mint is deleted, and stays
   * green while a served capability silently vanishes from the advertised surface.
   *
   * The two sides come from INDEPENDENT production modules, so deleting the kind from either
   * one reds: `SETTINGS_FAMILY` is the capability table `familyCapabilityOf` actually walks
   * when the registry authorises a dispatch, and the offer module is what mints the browser's
   * only route to the kind. Neither is a hand-copy of the other.
   */
  it("set-equals SETTINGS_FAMILY against the kinds the surface offers", () => {
    const { port, store } = world();
    const advertised = [...Object.keys(SETTINGS_FAMILY)].sort();
    const served = [...resolveAgentProviderOffers({ projectId: BOOTSTRAP_PROJECT, store })
      .offers.map((entry) => String(entry.kind))].sort();
    const onSurface = [...new Set(readOffers(port)
      .map((entry) => String(entry.commandKind))
      .filter((kind) => advertised.includes(kind)))].sort();

    expect(advertised).toEqual(served);
    expect(onSurface).toEqual(advertised);
    // Every advertised settings kind is one the registry's own capability walk resolves, so
    // the left-hand side is a SERVED roster rather than a list of names.
    for (const kind of advertised) expect(familyCapabilityOf(kind)).not.toBeNull();
    // The filter still discriminates: without this the two set-equalities above could both
    // hold over an empty roster and prove nothing.
    expect(advertised.length).toBeGreaterThan(0);
    expect(["not.a.settings.kind"].filter((kind) => advertised.includes(kind))).toEqual([]);
  });
});

describe("the offer names the aggregate the write lands on", () => {
  /**
   * THE ARM THAT CATCHES A FABRICATED IDENTITY, and it needs no literal on either side: drive
   * the PRODUCTION writer and watch the surface's own offer follow it. An offer minted at a
   * target the writer does not fence stays at version 0 here and reds; one minted at a
   * fabricated version reds on the first tuple.
   */
  it("advances with a real setAgentProvider write, at the writer's own aggregate", () => {
    const { port, store } = world();
    const aggregateId = agentProviderAggregateId(BOOTSTRAP_PROJECT);

    expect(providerOffersOf(port)).toMatchObject([{ expectedVersion: 0, targetAggregateId: aggregateId }]);

    const written = setAgentProvider(
      { now: () => "2026-09-07T00:00:01.000Z", projectId: BOOTSTRAP_PROJECT, store },
      { base: "main", goalId: "", provider: "codex" },
    );
    expect(written.ok).toBe(true);

    expect(providerOffersOf(port)).toMatchObject([{ expectedVersion: 1, targetAggregateId: aggregateId }]);
    // And the write really landed on the aggregate the offer named, not merely somewhere.
    expect(store.getAggregateVersion(aggregateId)).toBe(1);
  });

  it("advertises the schema version the writer actually stamps on the event", () => {
    const { port, store } = world();
    setAgentProvider(
      { now: () => "2026-09-07T00:00:02.000Z", projectId: BOOTSTRAP_PROJECT, store },
      { base: "main", goalId: "", provider: "codex" },
    );
    const events = store.readEvents(agentProviderAggregateId(BOOTSTRAP_PROJECT));
    const body: unknown = JSON.parse(decoder.decode(events[0]?.payload ?? new Uint8Array()));
    // Read back off the DURABLE EVENT rather than compared to a literal: the offer cannot
    // advertise a schema the command does not speak, whichever side is edited.
    expect((body as { version?: unknown }).version).toBe(AGENT_PROVIDER_SCHEMA_VERSION);
    expect(providerOffersOf(port)[0]?.inputSchemaVersion).toBe(AGENT_PROVIDER_SCHEMA_VERSION);
  });
});

describe("the minted offer is one the browser can actually spend", () => {
  /**
   * `buildNextAllowedCommands` is the contracts parser the browser's own affordance roster
   * runs: exact key set, non-empty `commandId`/`inputSchemaVersion`/`targetAggregateId`, a
   * safe-count `expectedVersion` and a known command kind. Any malformed entry collapses the
   * WHOLE list to the shared empty set, so a surviving offer is a spendable one. This is the
   * gate that answered INPUT_INVALID while no offer existed at all.
   */
  it("survives the contracts affordance parser with its identity intact", () => {
    const { port } = world();
    const offered = providerOffersOf(port);
    expect(offered).toHaveLength(1);
    const parsed = buildNextAllowedCommands({ aggregate: "PROJECT", state: "READY" }, offered);
    expect(parsed.map((entry) => entry.commandKind)).toEqual([AGENT_PROVIDER_COMMAND_KIND]);
    expect(parsed[0]).toMatchObject({
      expectedVersion: offered[0]?.expectedVersion,
      targetAggregateId: agentProviderAggregateId(BOOTSTRAP_PROJECT),
    });
    expect(parsed[0]?.commandId).toBe(offered[0]?.commandId);
    // NEGATIVE CONTROL, so the arm above is not "the parser accepts anything": drop one
    // required key from the SAME offer and the whole list collapses to the empty set.
    // Spread, not `as Record<string, unknown>`: NextAllowedCommand is an interface with no
    // index signature, so the cast is TS2352 under `pnpm typecheck` while vitest accepts it.
    const { inputSchemaVersion: _dropped, ...missingKey } = { ...offered[0] };
    expect(buildNextAllowedCommands({ aggregate: "PROJECT", state: "READY" }, [missingKey]))
      .toEqual([]);
  });
});

describe("the offer is withheld by the setter's own gate, not by a copy of it", () => {
  /**
   * Global rail 1: the reason code, and WHICH layer produced it. `readAgentProvider` runs the
   * identical `readState` that `setAgentProvider` runs, so a surface that would refuse at
   * dispatch offers nothing rather than handing an operator a control that fails when clicked.
   */
  it("answers AGENT_PROVIDER_SCOPE_INVALID and mints nothing for a foreign project", () => {
    const { store } = world();
    const result = resolveAgentProviderOffers({ projectId: "proj-not-this-store", store });
    expect(result.refused).toBe("AGENT_PROVIDER_SCOPE_INVALID");
    expect(result.offers).toEqual([]);
    // The positive control beside it: the SAME call on the store's own project does mint, so
    // the arm above is discriminating on scope rather than on the resolver being inert.
    expect(resolveAgentProviderOffers({ projectId: BOOTSTRAP_PROJECT, store }))
      .toMatchObject({ refused: null });
  });
});
