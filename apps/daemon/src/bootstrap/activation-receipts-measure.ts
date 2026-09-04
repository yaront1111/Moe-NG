/**
 * Measures the six activation receipts of a REAL project through injected ports.
 * Every member is measured independently and nothing short-circuits: the Activate
 * card must show every gap at once, so one member's refusal never hides another's
 * measurement. Git runs through the existing `nodeGitRunner` behind the `git` port;
 * this module must never spawn a process itself, which a source-text arm in
 * `activation-receipts-measure.test.ts` pins by scanning this file.
 */

import { createHash } from "node:crypto";
import { basename, extname, join } from "node:path";

import { SQLITE_APPLICATION_ID } from "@moe/store";

import { providerCredentials, providerFor } from "../orchestrator/moe-up-credentials.js";
import {
  ACTIVATION_RECEIPT_MEMBERS, measuredReceipt, sha256Hex, signingReceipt, unmeasuredReceipt,
} from "./activation-receipts.js";
import type {
  ActivationReceipt, ActivationReceiptMember, ActivationReceipts, DistributionKind,
} from "./activation-receipts.js";
import { receiptDetail } from "./activation-receipts-ports.js";
import type { ActivationBackupOutcome, ActivationReceiptPorts } from "./activation-receipts-ports.js";
import type { GitRunResult } from "../repository/git-landing-port.js";

export { nodeActivationReceiptPorts, receiptDetail } from "./activation-receipts-ports.js";
export type {
  ActivationBackupOutcome, ActivationReceiptFs, ActivationReceiptPorts,
} from "./activation-receipts-ports.js";

const MANIFEST_FILE = "MANIFEST-CLOSURE.txt";
const BACKUP_DIRECTORY = ".moe-next";
const BACKUP_LEAF = "backups";

export interface ActivationReceiptInput {
  readonly agentCommand: string;
  readonly artifactRoot: string;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly storePath: string;
}

/** A thrown runner is a measurement failure, never a rejected promise. */
async function runGit(
  ports: ActivationReceiptPorts, cwd: string, args: readonly string[],
): Promise<GitRunResult> {
  try {
    return await ports.git(cwd, args);
  } catch (error) {
    return { code: null, stderr: String(error), stdout: "" };
  }
}

async function gitLine(
  ports: ActivationReceiptPorts, cwd: string, args: readonly string[],
): Promise<{ readonly detail: string; readonly value: string | null }> {
  const result = await runGit(ports, cwd, args);
  const value = result.stdout.trim();
  if (result.code === 0 && value !== "") return { detail: "", value };
  const stderr = result.stderr.trim();
  const detail = stderr === "" ? `git exited ${String(result.code)}` : stderr;
  return { detail: receiptDetail(detail), value: null };
}

type RepositoryMeasurement =
  { readonly receipt: ActivationReceipt; readonly repository: ActivationReceipts["repository"] };

async function measureRepository(
  input: ActivationReceiptInput, ports: ActivationReceiptPorts,
): Promise<RepositoryMeasurement> {
  const refuse = (d: string) => ({ receipt: unmeasuredReceipt("repository", d), repository: null });
  if (input.projectRoot === "") return refuse("no project root configured");
  const top = await gitLine(ports, input.projectRoot, ["rev-parse", "--show-toplevel"]);
  if (top.value === null) return refuse(top.detail);
  const head = await gitLine(ports, top.value, ["rev-parse", "HEAD"]);
  if (head.value === null) return refuse(head.detail);
  return {
    receipt: measuredReceipt("repository", `repository/${top.value}@${head.value}`, head.value),
    repository: Object.freeze({ headSha: head.value, toplevel: top.value }),
  };
}

/** The command's leaf as `providerFor` reads it, for the ungated display ref. */
function commandLeaf(command: string): string {
  const leaf = basename(command.replaceAll("\\", "/"));
  return leaf.slice(0, leaf.length - extname(leaf).length).toLowerCase();
}

/** PRESENCE only: the credential NAME reaches the ref, the value never does. */
function credentialRef(
  input: ActivationReceiptInput, ports: ActivationReceiptPorts,
): { readonly detail: string; readonly ref: string | null } {
  if (input.agentCommand === "") return { detail: "no agent command configured", ref: null };
  const provider = providerFor(input.agentCommand);
  if (provider === undefined) {
    return { detail: "", ref: `credential/${commandLeaf(input.agentCommand)}/ungated` };
  }
  const entries = providerCredentials(provider, ports.env, (path) => ports.fs.exists(path));
  const first = entries?.[0];
  if (first === undefined) return { detail: `no credential for ${provider.leaf}`, ref: null };
  return {
    detail: "",
    ref: `credential/${provider.leaf}/${first.secret ? `env:${first.name}` : "login-file"}`,
  };
}

async function measureProvider(
  input: ActivationReceiptInput, ports: ActivationReceiptPorts,
): Promise<ActivationReceipt> {
  const credential = credentialRef(input, ports);
  let probeRef: string | null;
  try {
    probeRef = await ports.committedProbeRef();
  } catch (error) {
    return unmeasuredReceipt("provider", receiptDetail(String(error)));
  }
  if (probeRef === null || probeRef === "") {
    return unmeasuredReceipt("provider", "no committed provider.probe");
  }
  if (credential.ref === null) return unmeasuredReceipt("provider", credential.detail);
  return measuredReceipt("provider", probeRef, credential.ref);
}

function measureStore(
  input: ActivationReceiptInput, ports: ActivationReceiptPorts,
): { readonly receipt: ActivationReceipt; readonly store: ActivationReceipts["store"] } {
  const refuse = (detail: string) => ({ receipt: unmeasuredReceipt("store", detail), store: null });
  if (input.storePath === "") return refuse("no store path configured");
  if (!ports.fs.exists(input.storePath)) return refuse(`no store file at ${input.storePath}`);
  let applicationId: number | null;
  try {
    applicationId = ports.sqliteApplicationId(input.storePath);
  } catch (error) {
    return refuse(receiptDetail(String(error)));
  }
  if (applicationId === null) return refuse("store could not be read through node:sqlite");
  if (applicationId !== SQLITE_APPLICATION_ID) {
    return refuse(`application_id ${applicationId} is not ${SQLITE_APPLICATION_ID}`);
  }
  const detail = `read-only, ${ports.fs.stat(input.storePath)?.size ?? 0} bytes`;
  const receipt = measuredReceipt("store", `store/node-sqlite/${SQLITE_APPLICATION_ID}`, detail);
  return { receipt, store: Object.freeze({ storePath: input.storePath }) };
}

/** `2026-09-04T09:15:00.123Z` -> `20260904091500123`: millisecond precision, no separators. */
const backupStamp = (clock: Date): string => clock.toISOString().replaceAll(/\D/gu, "");

async function measureBackup(
  input: ActivationReceiptInput, ports: ActivationReceiptPorts, clock: Date,
): Promise<ActivationReceipt> {
  if (input.projectRoot === "" || input.storePath === "") {
    return unmeasuredReceipt("backup", "no project root or store path configured");
  }
  const directory = join(input.projectRoot, BACKUP_DIRECTORY, BACKUP_LEAF);
  const destination = join(directory, `${backupStamp(clock)}.sqlite`);
  try {
    ports.fs.mkdir(directory);
  } catch (error) {
    return unmeasuredReceipt("backup", receiptDetail(String(error)));
  }
  // Refuses a same-millisecond RETRY and any leftover at this name rather than
  // overwriting it. This is a check-then-act guard, NOT mutual exclusion: serialising
  // concurrent activations is the caller's gate.
  if (ports.fs.exists(destination)) {
    return unmeasuredReceipt("backup", "backup destination already exists");
  }
  let outcome: ActivationBackupOutcome;
  try {
    outcome = await ports.backup(input.storePath, destination);
  } catch (error) {
    return unmeasuredReceipt("backup", receiptDetail(String(error)));
  }
  if (!outcome.ok) return unmeasuredReceipt("backup", receiptDetail(outcome.detail));
  const ref = `${destination}@sha256:${outcome.sha256}`;
  return measuredReceipt("backup", ref, String(outcome.byteLength), outcome.sha256);
}

const sha256Bytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

type DistributionMeasurement =
  { readonly distribution: ActivationReceipts["distribution"]; readonly receipt: ActivationReceipt };

async function measureDistribution(
  input: ActivationReceiptInput, ports: ActivationReceiptPorts,
): Promise<DistributionMeasurement> {
  const refuse = (d: string) => ({ distribution: null, receipt: unmeasuredReceipt("distribution", d) });
  const seen = (kind: DistributionKind, ref: string, detail: string, hash: string) => ({
    distribution: Object.freeze({ kind, root: input.artifactRoot }),
    receipt: measuredReceipt("distribution", ref, detail, hash),
  });
  if (input.artifactRoot === "") return refuse("no artifact root configured");
  const manifest = join(input.artifactRoot, MANIFEST_FILE);
  if (ports.fs.exists(manifest)) {
    const bytes = ports.fs.readBytes(manifest);
    if (bytes === null) return refuse(`${MANIFEST_FILE} could not be read`);
    return seen("ARTIFACT", `artifact/${input.artifactRoot}`, MANIFEST_FILE, sha256Bytes(bytes));
  }
  const head = await gitLine(ports, input.artifactRoot, ["rev-parse", "HEAD"]);
  if (head.value === null) return refuse(head.detail);
  return seen(
    "SOURCE_CHECKOUT", `source-checkout/${input.artifactRoot}@${head.value}`, head.value,
    sha256Hex(`moe-distribution/source-checkout\n${head.value}\n`),
  );
}

async function measurePolicy(ports: ActivationReceiptPorts): Promise<ActivationReceipt> {
  let refs: readonly string[];
  try {
    refs = await ports.installedPolicySliceRefs();
  } catch (error) {
    return unmeasuredReceipt("policy", receiptDetail(String(error)));
  }
  if (refs.length === 0) return unmeasuredReceipt("policy", "no policy slices installed");
  // A slice's public address IS its content digest, so the revision is the digest of
  // the SORTED set: install order is not a policy fact.
  const canonical = [...refs].sort().join("\n");
  return measuredReceipt(
    "policy", `policy/${refs.length}-slices`, receiptDetail(canonical.replaceAll("\n", ", ")),
    sha256Hex(`moe-policy-revision\n${canonical}\n`),
  );
}

/** Frozen and JSON-serialisable: the Activate card renders the result verbatim. */
export async function measureActivationReceipts(
  input: ActivationReceiptInput, ports: ActivationReceiptPorts,
): Promise<ActivationReceipts> {
  // ONE clock reading: `measuredAt` and the backup file name must not drift apart
  // while a multi-gigabyte copy runs.
  const measuredAt = ports.now();
  const repository = await measureRepository(input, ports);
  const provider = await measureProvider(input, ports);
  const store = measureStore(input, ports);
  const backup = await measureBackup(input, ports, measuredAt);
  const distribution = await measureDistribution(input, ports);
  const policy = await measurePolicy(ports);
  const byMember: Readonly<Record<ActivationReceiptMember, ActivationReceipt>> = {
    backup, distribution: distribution.receipt, policy, provider,
    repository: repository.receipt, store: store.receipt,
  };
  return Object.freeze({
    distribution: distribution.distribution,
    measuredAt: measuredAt.toISOString(),
    members: Object.freeze(ACTIVATION_RECEIPT_MEMBERS.map((member) => byMember[member])),
    repository: repository.repository,
    schemaVersion: "moe-activation-receipts/1" as const,
    signing: signingReceipt(),
    store: store.store,
  });
}
