import { afterEach, describe, expect, it } from "vitest";

import { activationReceiptInput, activationReceiptPorts } from "./activation-command-entry.js";
import { ACTIVATION_RECEIPT_CODES } from "./activation-receipts.js";
import { measureActivationReceipts } from "./activation-receipts-measure.js";
import type { ActivationReceiptPorts } from "./activation-receipts-ports.js";
import {
  PROJECT_ID,
  closeStores,
  driveThrough,
  envelope,
  openStore,
  send,
} from "./bootstrap-test-fixtures.js";
import type { ActivationReceipt } from "./activation-receipts.js";
import type { SqliteEventStore } from "@moe/store";

/**
 * THE TWO DURABLE-READER PORTS ARE ACTUALLY WIRED.
 *
 * `nodeActivationReceiptPorts` defaults `committedProbeRef` to `null` and
 * `installedPolicySliceRefs` to `[]` ON PURPOSE, so an unwired daemon refuses honestly instead
 * of inventing a ref. That makes a defaulted port and a wired one INDISTINGUISHABLE on any test
 * that only checks the happy path or only checks that the overrides exist.
 *
 * These arms therefore compare a store where the durable facts ARE committed against one where
 * they are not, through the SAME production ports. A reverted override fails them: with the
 * default `committedProbeRef` the first arm reads PROVIDER_UNMEASURED, and with the default
 * `installedPolicySliceRefs` it reads POLICY_UNMEASURED.
 */
describe("the daemon's activation receipt ports read the durable store", () => {
  afterEach(() => { closeStores(); });

  /** Everything EXCEPT the two durable readers is faked, so only they are under test. */
  function hostPorts(store: SqliteEventStore): ActivationReceiptPorts {
    const present = new Set(["/fixture/store.sqlite"]);
    return activationReceiptPorts(store, PROJECT_ID, {
      backup: () => Promise.resolve({ byteLength: 1, ok: true as const, sha256: "a".repeat(64) }),
      env: {},
      fs: {
        exists: (path: string) => present.has(path),
        mkdir: (path: string) => { present.add(path); },
        readBytes: () => null,
        list: () => [],
        remove: () => undefined,
        stat: () => ({ size: 1 }),
      },
      git: () => Promise.resolve({ code: 0, stderr: "", stdout: `${"1".repeat(40)}\n` }),
      now: () => new Date("2026-09-04T09:15:00.123Z"),
      // `fixture-agent` is not installed on any host, and the REAL reader would correctly
      // refuse it ACTIVATION_PROVIDER_UNMEASURED. What these arms measure is the two DURABLE
      // readers, so the CLI probe is faked out like every other non-durable port.
      providerVersion: () =>
        Promise.resolve({ code: 0, stderr: "", stdout: "fixture-agent 1.0.0\n" }),
      sqliteApplicationId: () => 1297040689,
    });
  }

  const INPUT = {
    agentCommand: "fixture-agent", artifactRoot: "/fixture", projectId: PROJECT_ID,
    projectRoot: "/fixture", storePath: "/fixture/store.sqlite",
  };

  const memberOf = (
    members: readonly ActivationReceipt[], member: string,
  ): ActivationReceipt => {
    const found = members.find((receipt) => receipt.member === member);
    if (found === undefined) throw new Error(`no ${member} receipt`);
    return found;
  };

  it("reads the COMMITTED provider probe rather than the absent default", async () => {
    const store = openStore();
    // `driveThrough` stops before `project.activate`, so probe and both policy installs
    // are durable here — the state an operator is in when they press Activate.
    driveThrough(store, "project.activate");

    const receipts = await measureActivationReceipts(INPUT, hostPorts(store));

    const provider = memberOf(receipts.members, "provider");
    expect(provider.measured).toBe(true);
    if (!provider.measured) throw new Error(provider.code);
    // The ref the committed probe envelope carried. The DEFAULT port returns null here, which
    // would have surfaced as ACTIVATION_PROVIDER_UNMEASURED instead.
    expect(provider.ref).toBe("provider-profile-1");
  });

  it("reads the INSTALLED policy slices rather than the empty default", async () => {
    const store = openStore();
    driveThrough(store, "project.activate");

    const receipts = await measureActivationReceipts(INPUT, hostPorts(store));

    const policy = memberOf(receipts.members, "policy");
    expect(policy.measured).toBe(true);
    if (!policy.measured) throw new Error(policy.code);
    // TWO slices are installed by the fixture chain. The DEFAULT port returns [], whose
    // `refs.length === 0` guard answers ACTIVATION_POLICY_UNMEASURED.
    expect(policy.ref).toBe("policy/2-slices");
  });

  it("refuses POLICY_UNMEASURED on a store where no policy is installed", async () => {
    const store = openStore();
    // Stops BEFORE the two `policy.install` commands, so probe is durable and policy is not.
    driveThrough(store, "policy.install");

    const receipts = await measureActivationReceipts(INPUT, hostPorts(store));
    const outcome = send(store, envelope("project.activate", 2, {}), receipts);

    // The whole activation fails closed under the POLICY member's own code — this is the arm
    // that separates a live override from a defaulted one, because a defaulted
    // `installedPolicySliceRefs` produces this SAME code on the store above too.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe(ACTIVATION_RECEIPT_CODES.policy);
    expect(outcome.refusedBy).toBe("DAEMON_ACTIVATION_RECEIPTS");
  });

  it("reads host-scoped configuration RAW, defaulting nothing that must fail closed", () => {
    // An unconfigured store path stays EMPTY so the measurer answers "no store path
    // configured" under ACTIVATION_STORE_UNMEASURED. Substituting a plausible default here
    // would let a misconfigured daemon activate against a store nobody chose.
    expect(activationReceiptInput(PROJECT_ID, {}, "/cwd")).toEqual({
      agentCommand: "claude", artifactRoot: "/cwd", projectId: PROJECT_ID,
      projectRoot: "/cwd", storePath: "",
    });
    expect(activationReceiptInput(PROJECT_ID, {
      MOE_AGENT_COMMAND: "codex", MOE_PROJECT_ROOT: "/repo", MOE_STORE_PATH: "/repo/moe.sqlite",
    }, "/cwd")).toEqual({
      agentCommand: "codex", artifactRoot: "/repo", projectId: PROJECT_ID,
      projectRoot: "/repo", storePath: "/repo/moe.sqlite",
    });
  });
});
