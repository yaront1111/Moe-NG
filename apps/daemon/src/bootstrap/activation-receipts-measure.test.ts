import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { SQLITE_APPLICATION_ID } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { loginCredentialPath, providerFor } from "../orchestrator/moe-up-credentials.js";
import { ACTIVATION_RECEIPT_CODES, ACTIVATION_RECEIPT_MEMBERS } from "./activation-receipts.js";
import type {
  ActivationReceipt, ActivationReceiptMember, ActivationReceipts, MeasuredReceipt,
  UnmeasuredReceipt,
} from "./activation-receipts.js";
import { measureActivationReceipts, nodeActivationReceiptPorts } from "./activation-receipts-measure.js";
import type { ActivationReceiptInput } from "./activation-receipts-measure.js";
import type { ActivationReceiptFs, ActivationReceiptPorts } from "./activation-receipts-ports.js";
import type { GitRunResult } from "../repository/git-landing-port.js";

const LAYER = "DAEMON_ACTIVATION_RECEIPTS";
const PROJECT_ROOT = join(tmpdir(), "moe-activation-project");
const ARTIFACT_ROOT = join(tmpdir(), "moe-activation-artifact");
const STORE_PATH = join(PROJECT_ROOT, "moe.sqlite");
const FAKE_HOME = join(tmpdir(), "moe-activation-home");
const HEAD_SHA = "1111111111111111111111111111111111111111";
const ARTIFACT_SHA = "2222222222222222222222222222222222222222";
const BACKUP_SHA = "a".repeat(64);
const CLOCK = "2026-09-04T09:15:00.123Z";
const SLICE_A = "b".repeat(64);
const SLICE_B = "c".repeat(64);
const MODULE_SOURCE = fileURLToPath(new URL("activation-receipts-measure.ts", import.meta.url));

interface GitCall { readonly args: readonly string[]; readonly cwd: string }

interface FakeState {
  readonly bytes: Map<string, Uint8Array>;
  readonly existing: Set<string>;
  readonly gitCalls: GitCall[];
  mkdirError: string | null;
}

function fakeFs(state: FakeState): ActivationReceiptFs {
  const exists = (path: string): boolean => state.existing.has(path) || state.bytes.has(path);
  return {
    exists,
    mkdir: (path: string) => {
      if (state.mkdirError !== null) throw new Error(`${state.mkdirError}: ${path}`);
      state.existing.add(path);
    },
    readBytes: (path: string) => state.bytes.get(path) ?? null,
    stat: (path: string) => (exists(path) ? { size: state.bytes.get(path)?.length ?? 4096 } : null),
  };
}

const gitOk = (stdout: string): GitRunResult => ({ code: 0, stderr: "", stdout: `${stdout}\n` });
const gitFail = (code: number, stderr: string): GitRunResult => ({ code, stderr, stdout: "" });

function healthyPorts(): { readonly ports: ActivationReceiptPorts; readonly state: FakeState } {
  const state: FakeState = {
    bytes: new Map(), existing: new Set([STORE_PATH]), gitCalls: [], mkdirError: null,
  };
  const ports: ActivationReceiptPorts = {
    backup: () => Promise.resolve({ byteLength: 2048, ok: true as const, sha256: BACKUP_SHA }),
    committedProbeRef: () => Promise.resolve("probe/abc"),
    env: { ANTHROPIC_AUTH_TOKEN: "sk-CANARY-placeholder" },
    fs: fakeFs(state),
    git: (cwd, args) => {
      state.gitCalls.push({ args: [...args], cwd });
      if (cwd === PROJECT_ROOT && args[1] === "--show-toplevel") return Promise.resolve(gitOk(PROJECT_ROOT));
      if (cwd === PROJECT_ROOT && args[1] === "HEAD") return Promise.resolve(gitOk(HEAD_SHA));
      if (cwd === ARTIFACT_ROOT && args[1] === "HEAD") return Promise.resolve(gitOk(ARTIFACT_SHA));
      return Promise.resolve(gitFail(128, `fatal: unexpected ${cwd} ${args.join(" ")}`));
    },
    installedPolicySliceRefs: () => Promise.resolve([SLICE_A, SLICE_B]),
    now: () => new Date(CLOCK),
    sqliteApplicationId: () => SQLITE_APPLICATION_ID,
  };
  return { ports, state };
}

const INPUT: ActivationReceiptInput = {
  agentCommand: "claude", artifactRoot: ARTIFACT_ROOT, projectId: "project-1",
  projectRoot: PROJECT_ROOT, storePath: STORE_PATH,
};

function memberOf(receipts: ActivationReceipts, member: ActivationReceiptMember): ActivationReceipt {
  const found = receipts.members.find((receipt) => receipt.member === member);
  if (found === undefined) throw new Error(`no receipt for ${member}`);
  return found;
}

function refusalOf(receipts: ActivationReceipts, member: ActivationReceiptMember): UnmeasuredReceipt {
  const found = memberOf(receipts, member);
  if (found.measured) throw new Error(`${member} was measured: ${found.ref}`);
  return found;
}

function measuredOf(receipts: ActivationReceipts, member: ActivationReceiptMember): MeasuredReceipt {
  const found = memberOf(receipts, member);
  if (!found.measured) throw new Error(`${member} refused: ${found.code} ${found.detail}`);
  return found;
}

/** Every break is a PORT edit, so the measurement surface under test is never patched. */
const BREAKERS: Readonly<Record<ActivationReceiptMember, (ports: ActivationReceiptPorts, state: FakeState) => ActivationReceiptPorts>> = {
  backup: (ports) => ({ ...ports, backup: () => Promise.resolve({ detail: "disk full", ok: false as const }) }),
  distribution: (ports) => ({
    ...ports,
    git: (cwd, args) => (cwd === ARTIFACT_ROOT
      ? Promise.resolve(gitFail(128, "fatal: not a git repository"))
      : ports.git(cwd, args)),
  }),
  policy: (ports) => ({ ...ports, installedPolicySliceRefs: () => Promise.resolve([]) }),
  provider: (ports) => ({ ...ports, committedProbeRef: () => Promise.resolve(null) }),
  repository: (ports) => ({
    ...ports,
    git: (cwd, args) => (cwd === PROJECT_ROOT
      ? Promise.resolve(gitFail(128, "fatal: not a git repository (or any parent)"))
      : ports.git(cwd, args)),
  }),
  store: (ports, state) => {
    state.existing.delete(STORE_PATH);
    return ports;
  },
};

describe("activation receipt measurement", () => {
  const temporaries: string[] = [];
  const temporaryRoot = (): string => {
    const created = realpathSync.native(mkdtempSync(join(tmpdir(), "moe-activation-")));
    temporaries.push(created);
    return created;
  };

  afterEach(() => {
    while (temporaries.length > 0) {
      const path = temporaries.pop();
      if (path !== undefined) rmSync(path, { force: true, maxRetries: 5, recursive: true });
    }
  });

  it("measures all six members when every port answers", async () => {
    const { ports } = healthyPorts();
    const receipts = await measureActivationReceipts(INPUT, ports);
    for (const member of ACTIVATION_RECEIPT_MEMBERS) expect(measuredOf(receipts, member).ref).not.toBe("");
    expect(receipts.schemaVersion).toBe("moe-activation-receipts/1");
    expect(receipts.measuredAt).toBe(CLOCK);
    expect(receipts.repository).toEqual({ headSha: HEAD_SHA, toplevel: PROJECT_ROOT });
    expect(receipts.store).toEqual({ storePath: STORE_PATH });
    expect(receipts.distribution).toEqual({ kind: "SOURCE_CHECKOUT", root: ARTIFACT_ROOT });
    expect(receipts.signing.ref).toBe("signing/unsigned-source-checkout");
  });

  it.each(ACTIVATION_RECEIPT_MEMBERS)(
    "refuses only %s with its own code and layer when only its port breaks",
    async (member) => {
      const { ports, state } = healthyPorts();
      const receipts = await measureActivationReceipts(INPUT, BREAKERS[member](ports, state));
      const refusal = refusalOf(receipts, member);
      expect(refusal.code).toBe(ACTIVATION_RECEIPT_CODES[member]);
      expect(refusal.layer).toBe(LAYER);
      expect(refusal.detail).not.toBe("");
      for (const other of ACTIVATION_RECEIPT_MEMBERS) {
        if (other !== member) expect(measuredOf(receipts, other).measured).toBe(true);
      }
    },
  );

  it("emits every rostered code from the measurement surface, and no other", async () => {
    const emitted = new Set<string>();
    const members = new Set<string>();
    const { ports: healthy } = healthyPorts();
    for (const receipt of (await measureActivationReceipts(INPUT, healthy)).members) {
      if (!receipt.measured) emitted.add(receipt.code);
    }
    for (const member of ACTIVATION_RECEIPT_MEMBERS) {
      const { ports, state } = healthyPorts();
      for (const receipt of (await measureActivationReceipts(INPUT, BREAKERS[member](ports, state))).members) {
        if (!receipt.measured) {
          emitted.add(receipt.code);
          members.add(receipt.member);
        }
      }
    }
    expect(emitted).toEqual(new Set(Object.values(ACTIVATION_RECEIPT_CODES)));
    expect(members).toEqual(new Set(ACTIVATION_RECEIPT_MEMBERS));
  });

  it("turns a thrown git runner into a repository refusal instead of a rejection", async () => {
    const { ports } = healthyPorts();
    const receipts = await measureActivationReceipts(INPUT, {
      ...ports, git: () => { throw new Error("spawn git ENOENT"); },
    });
    const refusal = refusalOf(receipts, "repository");
    expect(refusal.code).toBe("ACTIVATION_REPOSITORY_UNMEASURED");
    expect(refusal.layer).toBe(LAYER);
    expect(refusal.detail).toBe("Error: spawn git ENOENT");
    expect(refusalOf(receipts, "distribution").detail).toBe("Error: spawn git ENOENT");
  });

  it("carries the credential NAME and never its value", async () => {
    const canary = `sk-CANARY-${randomUUID()}`;
    const { ports } = healthyPorts();
    const receipts = await measureActivationReceipts(INPUT, {
      ...ports, env: { ANTHROPIC_AUTH_TOKEN: canary },
    });
    expect(JSON.stringify(receipts)).not.toContain(canary);
    expect(measuredOf(receipts, "provider").detail).toBe("credential/claude/env:ANTHROPIC_AUTH_TOKEN");
    expect(measuredOf(receipts, "provider").ref).toBe("probe/abc");
  });

  it("reports a sign-in file as presence without naming a variable value", async () => {
    const provider = providerFor("claude");
    expect(provider).toBeDefined();
    if (provider === undefined) return;
    const env = { USERPROFILE: FAKE_HOME };
    const { ports, state } = healthyPorts();
    state.existing.add(loginCredentialPath(provider, env));
    const receipts = await measureActivationReceipts(INPUT, { ...ports, env });
    expect(measuredOf(receipts, "provider").detail).toBe("credential/claude/login-file");
  });

  it("waives an unrostered agent command and refuses a rostered one with no credential", async () => {
    const { ports } = healthyPorts();
    const ungated = await measureActivationReceipts(
      { ...INPUT, agentCommand: "my-agent" }, { ...ports, env: {} },
    );
    expect(measuredOf(ungated, "provider").detail).toBe("credential/my-agent/ungated");
    const refused = await measureActivationReceipts(INPUT, { ...ports, env: {} });
    const refusal = refusalOf(refused, "provider");
    expect(refusal.code).toBe("ACTIVATION_PROVIDER_UNMEASURED");
    expect(refusal.layer).toBe(LAYER);
    expect(refusal.detail).toBe("no credential for claude");
  });

  it("copies a real store and returns the copy's own sha256", async () => {
    const projectRoot = temporaryRoot();
    const storePath = join(projectRoot, "store.sqlite");
    const seeded = new DatabaseSync(storePath);
    seeded.exec(`PRAGMA application_id = ${SQLITE_APPLICATION_ID};`);
    seeded.exec("CREATE TABLE receipt_probe (id INTEGER PRIMARY KEY, note TEXT);");
    seeded.exec("INSERT INTO receipt_probe (id, note) VALUES (1, 'measured');");
    seeded.close();
    const { ports: fakes } = healthyPorts();
    const receipts = await measureActivationReceipts(
      { ...INPUT, projectRoot, storePath },
      nodeActivationReceiptPorts({
        committedProbeRef: fakes.committedProbeRef, git: fakes.git,
        installedPolicySliceRefs: fakes.installedPolicySliceRefs,
      }),
    );
    const backup = measuredOf(receipts, "backup");
    const [destination, digest] = backup.ref.split("@sha256:");
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(backup.hash).toBe(digest);
    expect(destination).toBeDefined();
    if (destination === undefined) return;
    expect(dirname(destination)).toBe(join(projectRoot, ".moe-next", "backups"));
    expect(basename(destination)).toMatch(/^\d{17}Z?\.sqlite$/u);
    const copied = readFileSync(destination);
    expect(createHash("sha256").update(copied).digest("hex")).toBe(digest);
    expect(backup.detail).toBe(String(copied.length));
    // The online copy is checkpointed, so no -wal/-shm sibling is left beside it.
    expect(readdirSync(dirname(destination))).toEqual([basename(destination)]);
    const reopened = new DatabaseSync(destination, { readOnly: true });
    expect(reopened.prepare("SELECT note FROM receipt_probe WHERE id = 1").get())
      .toEqual({ note: "measured" });
    reopened.close();
    expect(measuredOf(receipts, "store").ref).toBe(`store/node-sqlite/${SQLITE_APPLICATION_ID}`);
  });

  it("refuses at the receipts layer when the backup directory cannot be made", async () => {
    const projectRoot = temporaryRoot();
    const storePath = join(projectRoot, "store.sqlite");
    writeFileSync(storePath, "not-a-store");
    mkdirSync(join(projectRoot, ".moe-next"), { recursive: true });
    // A plain FILE where the directory belongs: cross-platform, no chmod needed.
    writeFileSync(join(projectRoot, ".moe-next", "backups"), "occupied");
    const { ports: fakes } = healthyPorts();
    const receipts = await measureActivationReceipts(
      { ...INPUT, projectRoot, storePath },
      nodeActivationReceiptPorts({
        committedProbeRef: fakes.committedProbeRef, git: fakes.git,
        installedPolicySliceRefs: fakes.installedPolicySliceRefs,
      }),
    );
    const refusal = refusalOf(receipts, "backup");
    expect(refusal.code).toBe("ACTIVATION_BACKUP_FAILED");
    expect(refusal.layer).toBe(LAYER);
    expect(refusal.detail).not.toBe("");
  });

  it("never overwrites a backup another activation already wrote in the same millisecond", async () => {
    const projectRoot = temporaryRoot();
    const storePath = join(projectRoot, "store.sqlite");
    writeFileSync(storePath, "not-a-store");
    const backups = join(projectRoot, ".moe-next", "backups");
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(backups, "20260904091500123.sqlite"), "already-here");
    const { ports: fakes } = healthyPorts();
    const receipts = await measureActivationReceipts(
      { ...INPUT, projectRoot, storePath },
      nodeActivationReceiptPorts({
        committedProbeRef: fakes.committedProbeRef, git: fakes.git,
        installedPolicySliceRefs: fakes.installedPolicySliceRefs, now: fakes.now,
      }),
    );
    const refusal = refusalOf(receipts, "backup");
    expect(refusal.code).toBe("ACTIVATION_BACKUP_FAILED");
    expect(refusal.layer).toBe(LAYER);
    expect(refusal.detail).toBe("backup destination already exists");
    expect(readFileSync(join(backups, "20260904091500123.sqlite"), "utf8")).toBe("already-here");
  });

  it("hashes the artifact manifest when one is present", async () => {
    const { ports, state } = healthyPorts();
    const manifestBytes = new TextEncoder().encode("closure-of-the-windows-artifact\n");
    state.bytes.set(join(ARTIFACT_ROOT, "MANIFEST-CLOSURE.txt"), manifestBytes);
    const receipts = await measureActivationReceipts(INPUT, ports);
    const distribution = measuredOf(receipts, "distribution");
    expect(receipts.distribution).toEqual({ kind: "ARTIFACT", root: ARTIFACT_ROOT });
    expect(distribution.ref).toBe(`artifact/${ARTIFACT_ROOT}`);
    expect(distribution.hash).toBe(createHash("sha256").update(manifestBytes).digest("hex"));
  });

  it("hashes a source checkout over a canonical line, not the raw sha", async () => {
    const { ports } = healthyPorts();
    const distribution = measuredOf(await measureActivationReceipts(INPUT, ports), "distribution");
    expect(distribution.ref).toBe(`source-checkout/${ARTIFACT_ROOT}@${ARTIFACT_SHA}`);
    expect(distribution.hash).toBe(
      createHash("sha256").update(`moe-distribution/source-checkout\n${ARTIFACT_SHA}\n`).digest("hex"),
    );
  });

  it("makes the policy revision independent of slice install order", async () => {
    const { ports } = healthyPorts();
    const forward = await measureActivationReceipts(INPUT, {
      ...ports, installedPolicySliceRefs: () => Promise.resolve([SLICE_A, SLICE_B]),
    });
    const reversed = await measureActivationReceipts(INPUT, {
      ...ports, installedPolicySliceRefs: () => Promise.resolve([SLICE_B, SLICE_A]),
    });
    const hash = measuredOf(forward, "policy").hash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(measuredOf(reversed, "policy").hash).toBe(hash);
    const single = await measureActivationReceipts(INPUT, {
      ...ports, installedPolicySliceRefs: () => Promise.resolve([SLICE_A]),
    });
    expect(measuredOf(single, "policy").hash).not.toBe(hash);
  });

  it("spawns git with the exact argv arrays and cwds the measurement claims", async () => {
    const { ports, state } = healthyPorts();
    await measureActivationReceipts(INPUT, ports);
    expect(state.gitCalls).toEqual([
      { args: ["rev-parse", "--show-toplevel"], cwd: PROJECT_ROOT },
      { args: ["rev-parse", "HEAD"], cwd: PROJECT_ROOT },
      { args: ["rev-parse", "HEAD"], cwd: ARTIFACT_ROOT },
    ]);
  });

  it("builds every path with node:path and reaches git only through the landing runner", async () => {
    const { ports } = healthyPorts();
    const receipts = await measureActivationReceipts(INPUT, ports);
    const backupRef = measuredOf(receipts, "backup").ref;
    expect(backupRef)
      .toBe(`${join(PROJECT_ROOT, ".moe-next", "backups", "20260904091500123.sqlite")}@sha256:${BACKUP_SHA}`);
    const source = readFileSync(MODULE_SOURCE, "utf8");
    expect(source).not.toContain("child_process");
    expect(source).not.toContain(".moe-next/");
    expect(source).not.toContain(".moe-next\\");
  });

  it("freezes what it returns and keeps every digest at 64 hex", async () => {
    const { ports } = healthyPorts();
    const receipts = await measureActivationReceipts(INPUT, ports);
    expect(Object.isFrozen(receipts)).toBe(true);
    expect(Object.isFrozen(receipts.members)).toBe(true);
    expect(Object.isFrozen(receipts.signing)).toBe(true);
    for (const receipt of receipts.members) {
      expect(Object.isFrozen(receipt)).toBe(true);
      if (receipt.measured && receipt.hash !== undefined) {
        expect(receipt.hash).toMatch(/^[0-9a-f]{64}$/u);
      }
    }
  });

  it("refuses each member on an empty root instead of joining onto nothing", async () => {
    const { ports } = healthyPorts();
    const receipts = await measureActivationReceipts(
      { ...INPUT, artifactRoot: "", projectRoot: "", storePath: "" }, ports,
    );
    expect(refusalOf(receipts, "repository").detail).toBe("no project root configured");
    expect(refusalOf(receipts, "store").detail).toBe("no store path configured");
    expect(refusalOf(receipts, "backup").detail).toBe("no project root or store path configured");
    expect(refusalOf(receipts, "distribution").detail).toBe("no artifact root configured");
    expect(receipts.repository).toBeNull();
    expect(receipts.store).toBeNull();
    expect(receipts.distribution).toBeNull();
  });

  it("refuses an empty agent command instead of minting a leafless credential ref", async () => {
    const { ports } = healthyPorts();
    const receipts = await measureActivationReceipts({ ...INPUT, agentCommand: "" }, ports);
    const refusal = refusalOf(receipts, "provider");
    expect(refusal.code).toBe("ACTIVATION_PROVIDER_UNMEASURED");
    expect(refusal.layer).toBe(LAYER);
    expect(refusal.detail).toBe("no agent command configured");
    expect(JSON.stringify(receipts)).not.toContain("credential//ungated");
  });

  it("stamps the backup with the same clock reading it reports as measuredAt", async () => {
    const readings = [new Date(CLOCK), new Date("2027-01-02T03:04:05.678Z")];
    let call = 0;
    const { ports } = healthyPorts();
    const receipts = await measureActivationReceipts(INPUT, {
      ...ports,
      now: () => readings[Math.min(call++, readings.length - 1)] ?? new Date(CLOCK),
    });
    // A drifting clock must not put one instant in the file name and another on the card.
    expect(receipts.measuredAt).toBe(CLOCK);
    expect(measuredOf(receipts, "backup").ref).toContain("20260904091500123.sqlite");
  });

  it("refuses the store when the file is not a Moe database", async () => {
    const { ports } = healthyPorts();
    const foreign = await measureActivationReceipts(INPUT, { ...ports, sqliteApplicationId: () => 0 });
    const refusal = refusalOf(foreign, "store");
    expect(refusal.code).toBe("ACTIVATION_STORE_UNMEASURED");
    expect(refusal.detail).toBe(`application_id 0 is not ${SQLITE_APPLICATION_ID}`);
    const unopenable = await measureActivationReceipts(INPUT, {
      ...ports, sqliteApplicationId: () => null,
    });
    expect(refusalOf(unopenable, "store").detail).toBe("store could not be read through node:sqlite");
  });
});
