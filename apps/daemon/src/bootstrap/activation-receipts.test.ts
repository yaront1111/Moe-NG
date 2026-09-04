import { reduceProject } from "@moe/core";
import type { ProjectCommand } from "@moe/core";
import { describe, expect, it } from "vitest";

import {
  ACTIVATION_RECEIPT_CODES,
  ACTIVATION_RECEIPT_MEMBERS,
  SIGNING_UNSIGNED_REASON,
  SIGNING_UNSIGNED_REF,
  activationWitnessOf,
  repositoryObservationOf,
} from "./activation-receipts.js";
import type {
  ActivationReceiptMember,
  ActivationReceipts,
  MeasuredReceipt,
  UnmeasuredReceipt,
} from "./activation-receipts.js";

const LAYER = "DAEMON_ACTIVATION_RECEIPTS";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const hex64 = (seed: string): string => seed.repeat(64).slice(0, 64);

function measured(member: ActivationReceiptMember, ref: string, detail: string, hash?: string): MeasuredReceipt {
  return Object.freeze(
    hash === undefined
      ? { detail, measured: true as const, member, ref }
      : { detail, hash, measured: true as const, member, ref },
  );
}

function unmeasured(member: ActivationReceiptMember): UnmeasuredReceipt {
  return Object.freeze({
    code: ACTIVATION_RECEIPT_CODES[member],
    detail: `${member} could not be measured`,
    layer: LAYER as UnmeasuredReceipt["layer"],
    measured: false as const,
    member,
  });
}

/** A fully measured receipt set; `broken` replaces those members with refusals. */
function receiptsFixture(
  broken: readonly ActivationReceiptMember[] = [],
  overrides: Partial<Record<ActivationReceiptMember, MeasuredReceipt>> = {},
): ActivationReceipts {
  const healthy: Record<ActivationReceiptMember, MeasuredReceipt> = {
    backup: measured("backup", `/p/.moe-next/backups/1.sqlite@sha256:${hex64("b")}`, "4096", hex64("b")),
    distribution: measured("distribution", "source-checkout/D:/repo", "SOURCE_CHECKOUT", hex64("d")),
    policy: measured("policy", "policy/2-slices", "2 slices", hex64("c")),
    provider: measured("provider", "probe/abc", "credential/claude/env:ANTHROPIC_AUTH_TOKEN"),
    repository: measured("repository", `repository/D:/repo@${HEAD_SHA}`, HEAD_SHA),
    store: measured("store", "store/node-sqlite/1298231107", "opened read-only"),
    ...overrides,
  };
  const members = ACTIVATION_RECEIPT_MEMBERS.map((member) =>
    broken.includes(member) ? unmeasured(member) : healthy[member]);
  return Object.freeze({
    distribution: broken.includes("distribution")
      ? null : Object.freeze({ kind: "SOURCE_CHECKOUT" as const, root: "D:/repo" }),
    measuredAt: "2026-09-04T09:15:00.123Z",
    members: Object.freeze(members),
    repository: broken.includes("repository")
      ? null : Object.freeze({ headSha: HEAD_SHA, toplevel: "D:/repo" }),
    schemaVersion: "moe-activation-receipts/1" as const,
    signing: Object.freeze({
      measured: false as const, member: "signing" as const, minted: true as const,
      reason: SIGNING_UNSIGNED_REASON, ref: SIGNING_UNSIGNED_REF,
    }),
    store: broken.includes("store") ? null : Object.freeze({ storePath: "D:/repo/moe.sqlite" }),
  });
}

/** Drives core's own reducer, so the witness is graded by production validation. */
function driveProjectChain(receipts: ActivationReceipts): ReturnType<typeof reduceProject> {
  const assembled = activationWitnessOf(receipts);
  if (!assembled.ok) throw new Error(`witness not assembled: ${assembled.refusals.map((r) => r.code).join(",")}`);
  const observation = repositoryObservationOf(receipts);
  if (observation === null) throw new Error("observation not assembled");
  const registered = reduceProject(undefined, {
    commandId: "cmd-1", expectedVersion: 0, kind: "project.register",
    owner: "operator-1", projectId: "project-1",
  } satisfies ProjectCommand);
  if (!registered.ok) throw new Error("register refused");
  const bound = reduceProject(registered.state, {
    commandId: "cmd-2", expectedVersion: 1, kind: "project.bind_repository", observation,
  } satisfies ProjectCommand);
  if (!bound.ok) throw new Error(`bind refused: ${bound.error.code}`);
  return reduceProject(bound.state, {
    commandId: "cmd-3", expectedVersion: 2, kind: "project.activate", witness: assembled.witness,
  } satisfies ProjectCommand);
}

describe("activation receipt contracts", () => {
  it("pairs every member with exactly one stable refusal code", () => {
    expect(new Set(Object.keys(ACTIVATION_RECEIPT_CODES)))
      .toEqual(new Set(ACTIVATION_RECEIPT_MEMBERS));
    expect(new Set(Object.values(ACTIVATION_RECEIPT_CODES)).size)
      .toBe(ACTIVATION_RECEIPT_MEMBERS.length);
    for (const code of Object.values(ACTIVATION_RECEIPT_CODES)) {
      expect(code).toMatch(/^ACTIVATION_[A-Z]+_(UNMEASURED|FAILED)$/u);
    }
  });

  it("mints the signing receipt instead of measuring it", () => {
    const { signing } = receiptsFixture();
    expect(signing).toEqual({
      measured: false, member: "signing", minted: true,
      reason: "not a trust boundary in v0.1", ref: "signing/unsigned-source-checkout",
    });
    expect(SIGNING_UNSIGNED_REF.length).toBeGreaterThan(0);
    expect(ACTIVATION_RECEIPT_MEMBERS).not.toContain("signing");
  });

  it("assembles a witness core's own reducer accepts through register -> bind -> activate", () => {
    const result = driveProjectChain(receiptsFixture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.lifecycle).toBe("READY");
    expect(result.events[0]?.kind).toBe("ProjectActivated");
  });

  it("carries the minted signing ref into the witness and the measured refs verbatim", () => {
    const assembled = activationWitnessOf(receiptsFixture());
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    expect(assembled.witness).toEqual({
      artifactPathRef: "source-checkout/D:/repo",
      backupPathRef: `/p/.moe-next/backups/1.sqlite@sha256:${hex64("b")}`,
      credentialRef: "credential/claude/env:ANTHROPIC_AUTH_TOKEN",
      distributionManifestHash: hex64("d"),
      policyRevisionHash: hex64("c"),
      providerMinimumProfileRef: "probe/abc",
      signingKeyRef: SIGNING_UNSIGNED_REF,
      storeDriverRef: "store/node-sqlite/1298231107",
      truthClass: "DAEMON_VERIFIED",
    });
  });

  it("is refused by core when a hash is one hex short, so padding can never pass", () => {
    const short = hex64("d").slice(0, 63);
    const fixture = receiptsFixture([], {
      distribution: measured("distribution", "source-checkout/D:/repo", "SOURCE_CHECKOUT", short),
    });
    const assembled = activationWitnessOf(fixture);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    expect(assembled.witness.distributionManifestHash).toBe(short);
    const result = driveProjectChain(fixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ILLEGAL_TRANSITION");
  });

  it("refuses assembly with the unmeasured member's own code and layer", () => {
    const assembled = activationWitnessOf(receiptsFixture(["store"]));
    expect(assembled.ok).toBe(false);
    if (assembled.ok) return;
    expect(assembled.refusals).toHaveLength(1);
    expect(assembled.refusals[0]?.code).toBe("ACTIVATION_STORE_UNMEASURED");
    expect(assembled.refusals[0]?.layer).toBe(LAYER);
    expect(assembled.refusals[0]?.member).toBe("store");
  });

  it("reports EVERY unmeasured member, never the first one only", () => {
    const assembled = activationWitnessOf(receiptsFixture(["backup", "policy", "provider"]));
    expect(assembled.ok).toBe(false);
    if (assembled.ok) return;
    expect(assembled.refusals.map((refusal) => refusal.code).sort()).toEqual([
      "ACTIVATION_BACKUP_FAILED", "ACTIVATION_POLICY_UNMEASURED", "ACTIVATION_PROVIDER_UNMEASURED",
    ]);
    for (const refusal of assembled.refusals) expect(refusal.layer).toBe(LAYER);
  });

  it("refuses a measured member that lost its hash rather than minting one", () => {
    const assembled = activationWitnessOf(receiptsFixture([], {
      policy: measured("policy", "policy/2-slices", "2 slices"),
    }));
    expect(assembled.ok).toBe(false);
    if (assembled.ok) return;
    expect(assembled.refusals.map((refusal) => refusal.code))
      .toEqual(["ACTIVATION_POLICY_UNMEASURED"]);
  });

  it("derives a 64-hex baseRevisionHash from the 40-hex git sha", () => {
    const observation = repositoryObservationOf(receiptsFixture());
    expect(observation).not.toBeNull();
    expect(observation?.baseRevisionHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(observation?.baseRevisionHash).not.toContain(HEAD_SHA);
    expect(observation?.repositoryRef).toBe("repository/D:/repo");
    expect(observation?.scopeRef).toBe("scope/D:/repo");
    expect(observation?.truthClass).toBe("DAEMON_VERIFIED");
    expect(repositoryObservationOf(receiptsFixture(["repository"]))).toBeNull();
  });
});
