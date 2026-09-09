/**
 * THE ROUND TRIP (DoD 3): the daemon OFFERS a rollback, the daemon NAMES the receipt, and the
 * daemon's own registry ADMITS the tuple built from those two answers.
 *
 * Nothing below is hand-built. The envelope's commandKind, targetAggregateId and expectedVersion
 * come off `nextAllowedCommands`; `toReceiptRef` comes off the health frame's `rollbackTarget`.
 * A test that assembled either by hand would prove the handler works and say nothing about
 * whether a browser can ever reach it — which is precisely the hole this row exists to close.
 *
 * THE COMPOSITION IS PRODUCTION'S. `createStoreDependencies` is the factory the daemon entry
 * uses, so the affordance port, the health port and the command registry all come from one
 * composition root over one store file, exactly as they do at runtime.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { expect, it } from "vitest";

import { BOOTSTRAP_SCHEMA_VERSION } from "../bootstrap/bootstrap-contracts.js";
import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { recordDeployReceipt } from "../deployment/deploy-ledger.js";
import { setDeployTarget } from "../deployment/deploy-target-command.js";
import { MCP_EXCLUDED_COMMAND_KINDS, wiredMcpToolKinds } from "../mcp-tool-allowlist.js";
import { projectDeploymentsHealth } from "./deployments-health-read.js";
import type { CommandHandlerInput } from "./http-contract.js";

const PROJECT = "project-1";
const OPERATOR = "operator-1";
const ENVIRONMENT = "production";
const DIGEST = `sha256:${"b".repeat(64)}`;
/** Every capability the vocabulary hands out, so no capability gate can answer first in the
 *  non-operator arm — only the handler's own principal check can. */
const EVERY_CAPABILITY = Object.freeze([
  "admin", "goal.write", "work.write", "policy.write", "review.write", "approval.write",
]);
/** The four codes that are exactly how a WRONG offer or a WRONG receipt ref would surface. */
const ADMISSION_FAILURES = Object.freeze([
  "DEPLOY_ROLLBACK_RECEIPT_INVALID", "DEPLOY_ROLLBACK_TARGET_INVALID",
  "DEPLOY_ROLLBACK_REQUEST_INVALID", "EXPECTED_VERSION_CONFLICT",
]);

type Provider = ReturnType<typeof createStoreDependencies>;
interface Seeded { readonly close: () => void; readonly provider: Provider }

function inputFor(
  kind: string, commandId: string, payload: Record<string, unknown>, expectedVersion: number,
  principalId: string = OPERATOR,
): CommandHandlerInput {
  return {
    envelope: {
      commandId, commandKind: kind, correlationId: commandId, expectedVersion, payload,
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, targetAggregateId: PROJECT,
    },
    principal: { capabilities: EVERY_CAPABILITY, principalId, projectId: PROJECT },
  } as unknown as CommandHandlerInput;
}

/** A project with a bound deploy target and `deploys` DEPLOYED receipts, written through the
 *  REAL registry and the REAL ledger writer against the production composition's own store. */
function seed(deploys: number): Seeded {
  const directory = mkdtempSync(join(tmpdir(), "moe-rollback-round-trip-"));
  const storePath = join(directory, "store.sqlite");
  const provider = createStoreDependencies({
    credential: randomUUID(), principalId: OPERATOR, projectId: PROJECT,
    repositoryWorkspace: directory, storePath,
  });
  const close = (): void => {
    provider.close();
    rmSync(directory, { force: true, recursive: true });
  };
  try {
    // A SECOND SHORT-LIVED HANDLE for the seed: the provider exposes no store, and seeding
    // before it exists would make genesis refuse RECOVERY_INITIAL_INSTALL_HISTORY_PRESENT.
    const seeder = SqliteEventStore.openForProject(storePath, PROJECT);
    try {
      // THE TARGET IS BOUND BY THE PRODUCTION SETTER, `setDeployTarget` itself, so the binding
      // `deployBound` reads back is written by the code that writes it at runtime. Called
      // directly rather than through `registry.get("deployment.set_target").handler`, which
      // additionally enforces the whole bootstrap ladder (register -> bind -> policy -> ... ->
      // publish) and refuses BOOTSTRAP_PREREQUISITE_MISSING on a fresh store. That ladder gates
      // WHEN an operator may bind a target; it is not what this row tests, and climbing it here
      // would bury the round trip under a world-building fixture.
      const bound = setDeployTarget({
        ledger: readDurableLedger(seeder, PROJECT),
        request: {
          commandId: `set-target-${randomUUID()}`, correlationId: "round-trip",
          decidedAt: "2026-09-08T00:00:00.000Z", expectedVersion: 0,
          kind: "deployment.set_target",
          payload: { environment: ENVIRONMENT, network: "product-net", sshTarget: null, url: null },
          principalId: OPERATOR, projectId: PROJECT, schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
        },
        store: seeder,
      });
      if (!bound.ok) throw new Error(`deploy target seed refused: ${bound.code}`);
      for (let index = 0; index < deploys; index += 1) {
        const written = recordDeployReceipt(seeder, {
          decidedAt: `2026-09-08T0${index}:00:00.000Z`, decisionId: `deploy-${index}`,
          environment: ENVIRONMENT, imageDigest: DIGEST, projectId: PROJECT, refusal: null,
          releaseDecision: null, sha: (index + 1).toString(16).padStart(2, "0").repeat(20),
          url: null,
        });
        // Named-code throw: a silently refused seed leaves every assertion below vacuous.
        if (!written.ok) throw new Error(`deploy receipt seed refused: ${written.code}`);
      }
      // ADVANCE THE PROJECT AGGREGATE so the offered `expectedVersion` is NOT zero. Nothing
      // above writes to it - a receipt lands on `deploy:<project>:<environment>` and a target
      // binding on its own aggregate - so on a fresh store the project version is 0 and the
      // dispatch below would admit a hard-coded zero just as happily as a read one. Measured
      // during the step-9 drill: a `version = 0` mutant in the offer resolver kept this file
      // GREEN until this bump existed. With it, that mutant refuses EXPECTED_VERSION_CONFLICT.
      const encoder = new TextEncoder();
      seeder.commitExpectedVersionDecision({
        commandKind: "test.project_bump", committedResultBytes: encoder.encode("{}"),
        correlationId: "round-trip-bump", decidedAt: "2026-09-08T03:00:00.000Z",
        events: [{ eventId: "round-trip-bump", eventType: "TestProjectBumped",
          payload: encoder.encode("{}") }],
        expectedVersion: seeder.getAggregateVersion(PROJECT),
        key: { commandId: "round-trip-bump", principalId: "test-bump", projectId: PROJECT },
        requestBytes: encoder.encode("round-trip-bump"), targetAggregateId: PROJECT,
      });
    } finally { seeder.close(); }
  } catch (error) {
    close();
    throw error;
  }
  return { close, provider };
}

/** Every `deployment.rollback` entry the PRODUCTION surface minted. */
function rollbackOffers(provider: Provider): readonly {
  readonly commandId: string; readonly expectedVersion: number; readonly targetAggregateId: string;
}[] {
  const surface = provider.affordances?.().readSurface();
  if (surface === undefined || surface.outcome !== "SURFACE") {
    throw new Error(`the affordance surface refused: ${JSON.stringify(surface)}`);
  }
  return surface.nextAllowedCommands.filter((entry) => entry.commandKind === "deployment.rollback");
}

/** The binding the SERVED health projection names, exactly as a browser receives it. */
function servedRollbackTarget(
  provider: Provider,
): { readonly imageDigest: string; readonly sha: string; readonly toReceiptRef: string } | null {
  const source = provider.deploymentsHealth?.().read({ environment: ENVIRONMENT });
  if (source === undefined || !source.ok) {
    throw new Error(`the health port refused: ${JSON.stringify(source)}`);
  }
  return projectDeploymentsHealth(ENVIRONMENT, source.value).rollbackTarget;
}

async function refusalOf(run: () => Promise<unknown>): Promise<{ code: string; layer: string }> {
  try {
    await run();
    return { code: "ADMITTED", layer: "ADMITTED" };
  } catch (error) {
    const thrown = error as { code?: unknown; layer?: unknown; message?: unknown };
    return {
      code: typeof thrown.code === "string" ? thrown.code : String(thrown.message),
      layer: typeof thrown.layer === "string" ? thrown.layer : "NO_LAYER",
    };
  }
}

/**
 * THE ARM THAT PROVES A SPENDABLE CONTROL SHIPPED. The dispatch runs against an unwired test
 * daemon, so whatever terminal outcome it reaches is not the point — the point is that it gets
 * PAST rollback-command.ts:98-101. Pinning the four admission failures BY NAME is what keeps
 * this non-vacuous: a wrong aggregate, a wrong version, a wrong payload shape or a receipt the
 * handler will not admit each surface as exactly one of them.
 */
it("spends the daemon's own offer and the daemon's own receipt ref through the real registry", async () => {
  const seeded = seed(2);
  try {
    const offers = rollbackOffers(seeded.provider);
    expect(offers).toHaveLength(1);
    const offer = offers[0];
    const target = servedRollbackTarget(seeded.provider);
    if (offer === undefined || target === null) throw new Error("the daemon offered no authority");
    expect(offer.targetAggregateId).toBe(PROJECT);
    expect(target.toReceiptRef).toMatch(/^[0-9a-f]{64}$/u);
    // The offer carries a READ version, not a fresh store's zero - see the bump in `seed`.
    expect(offer.expectedVersion).toBeGreaterThan(0);

    const entry = seeded.provider.provide().registry.get("deployment.rollback");
    expect(entry?.asyncHandler).toBeTypeOf("function");
    const outcome = await refusalOf(() => entry!.asyncHandler!(inputFor(
      "deployment.rollback", offer.commandId,
      { environment: ENVIRONMENT, restoreDatabase: false, toReceiptRef: target.toReceiptRef },
      offer.expectedVersion,
    )));
    expect(ADMISSION_FAILURES).not.toContain(outcome.code);
    // THE POSITIVE HALF, and the half that makes this arm mean something. All four admission
    // failures are minted by this handler's own `refuse()` at DAEMON_COMMAND_SEAM, and the
    // principal check at DAEMON_AUTHORIZATION sits in front of them. Reaching neither layer is
    // the evidence the request left the admission stage and was handed to the engine. Measured
    // here: DEPLOY_BUILD_FAILED @ DAEMON_DEPLOY_ENGINE, i.e. it got all the way to the effect
    // and died on this box having no docker - which is the correct terminal outcome for an
    // unwired test daemon and cannot be reached by a wrong offer or a wrong receipt ref.
    expect(outcome.layer).not.toBe("DAEMON_COMMAND_SEAM");
    expect(outcome.layer).not.toBe("DAEMON_AUTHORIZATION");
  } finally { seeded.close(); }
});

/**
 * OPERATOR-ONLY, ASSERTED WITH ITS LAYER. `deployment.rollback` is served from an ASYNC entry
 * and so never reaches the registry's synchronous operator check — it fences itself at handler
 * entry (rollback-command.ts:80), stamped DAEMON_AUTHORIZATION rather than the DAEMON_COMMAND_SEAM
 * every other refusal in this handler carries. The principal below holds EVERY capability, so a
 * capability gate cannot be what answered.
 */
it("refuses a non-operator principal holding every capability, at DAEMON_AUTHORIZATION", async () => {
  const seeded = seed(2);
  try {
    const offer = rollbackOffers(seeded.provider)[0];
    const target = servedRollbackTarget(seeded.provider);
    if (offer === undefined || target === null) throw new Error("the daemon offered no authority");
    const entry = seeded.provider.provide().registry.get("deployment.rollback");
    expect(await refusalOf(() => entry!.asyncHandler!(inputFor(
      "deployment.rollback", offer.commandId,
      { environment: ENVIRONMENT, restoreDatabase: false, toReceiptRef: target.toReceiptRef },
      offer.expectedVersion, "planning-agent",
    )))).toEqual({ code: "OPERATOR_PRINCIPAL_REQUIRED", layer: "DAEMON_AUTHORIZATION" });
  } finally { seeded.close(); }
});

/**
 * NO AUTHORITY WITHOUT A TARGET, at BOTH seams at once. One DEPLOYED receipt is the image
 * running now; there is nothing behind it. Asserting only the offer would leave a card free to
 * build a rollback out of `rollbackSha`, and asserting only the frame would leave the surface
 * free to offer a control with no receipt to spend.
 */
it("emits neither an offer nor a target when the only deploy that ran is the running one", () => {
  const seeded = seed(1);
  try {
    expect(rollbackOffers(seeded.provider)).toHaveLength(0);
    expect(servedRollbackTarget(seeded.provider)).toBeNull();
  } finally { seeded.close(); }
});

/**
 * MCP EXCLUSION INTACT, derived from the SERVED seam rather than a hand-copied roster:
 * `wiredMcpToolKinds()` is the exact allowlist both MCP entries are handed. The MCP port
 * authenticates with the operator bootstrap credential, so an advertised kind is an agent
 * arriving AS the operator — a capability gate would pass and this roster is the fence.
 */
it("keeps deployment.rollback off the MCP allowlist while the browser surface offers it", () => {
  expect(MCP_EXCLUDED_COMMAND_KINDS).toContain("deployment.rollback");
  expect(wiredMcpToolKinds()).not.toContain("deployment.rollback");
  // CONTROL: the roster is non-empty and really does serve other command kinds, so the negative
  // above cannot pass by the allowlist having collapsed to nothing.
  expect(wiredMcpToolKinds().length).toBeGreaterThan(1);
  expect(wiredMcpToolKinds()).toContain("goal.create");
});
