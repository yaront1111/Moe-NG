import { execFileSync, spawnSync } from "node:child_process";

/** Captured gate output bound: a full e2e run is several MiB, far past spawnSync's 1 MiB default. */
export const GATE_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GENERATED_CONTRACT_DIGEST } from "@moe/control-room-client/contract-pins";
import { SqliteEventStore } from "@moe/store";

import { COMMIT_HEX } from "./v2-readiness-evidence-contract.js";
import type { V2EvidenceOutcome, V2EvidenceRefused } from "./v2-readiness-evidence-contract.js";
import {
  produceAcceptanceEvidence, produceContractSchema, produceSecurityEvidence,
  produceWindowsPackagingEvidence, refuseAbsentProducers,
} from "./v2-readiness-evidence-producers.js";
import type { SecurityEvidenceInput, V2EvidenceFilePorts, WindowsPackagingInput }
  from "./v2-readiness-evidence-producers.js";
import { produceBackupEvidence, produceStoreMigrationEvidence }
  from "./v2-readiness-evidence-store-producers.js";
import type { V2EvidenceStorePorts } from "./v2-readiness-evidence-store-producers.js";
import { V2_READINESS_EVIDENCE_FILENAMES, V2_READINESS_EVIDENCE_KINDS }
  from "./v2-readiness-manifest-writer.js";
import type { V2ReadinessEvidenceKind } from "./v2-readiness-manifest-writer.js";
import { V2_READINESS_MANIFEST_LAYER } from "./v2-readiness-manifest.js";

/**
 * Produces the eight evidence files `v2-readiness-manifest-writer-main.ts` reads under
 * `--evidence-root`, from the sources that actually exist at this commit, and REFUSES BY
 * KIND where none does. Every produced file is written once (`wx`), under the name the
 * writer pins, and the receipt names each kind's sha256 or its refusal. `ok` is true only
 * when all eight were produced; at this commit two kinds have no producer, so the receipt
 * is expected to say so rather than the tool inventing a record to make the writer accept.
 */

export interface V2ReadinessEvidencePorts extends V2EvidenceFilePorts, V2EvidenceStorePorts {
  /** The generated client's contract digest; the produced surface must hash to it. */
  readonly contractDigestPin: string;
  /** Exclusive create: throws when the path exists. */
  readonly writeFile: (path: string, bytes: Uint8Array) => void;
}

export interface V2ReadinessEvidenceCollectInput {
  readonly evidenceRoot: string;
  readonly projectId: string;
  readonly security: SecurityEvidenceInput;
  readonly sourceCommit: string;
  /** The checkout the acceptance lanes run in; HEAD must be `sourceCommit`. */
  readonly sourceRoot: string;
  readonly storePath: string;
  /** Where `live-quiesce-evidence.json` lives: the generation snapshot's root. */
  readonly storeRoot: string;
  readonly windows: WindowsPackagingInput;
}

export interface V2ReadinessEvidenceReceipt {
  readonly evidenceRoot: string;
  readonly ok: boolean;
  readonly produced: Readonly<Partial<Record<V2ReadinessEvidenceKind, Readonly<{ file: string; sha256: string }>>>>;
  readonly refused: Readonly<Partial<Record<V2ReadinessEvidenceKind, Omit<V2EvidenceRefused, "kind" | "ok">>>>;
  readonly sourceCommit: string;
}

export function createSystemEvidencePorts(): V2ReadinessEvidencePorts {
  const ports: V2ReadinessEvidencePorts = {
    contractDigestPin: GENERATED_CONTRACT_DIGEST,
    git: (args, cwd) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim(),
    readDirectory: (path) => readdirSync(path),
    readFile: (path) => new Uint8Array(readFileSync(path)),
    removeDirectory: (path) => { rmSync(path, { force: true, recursive: true }); },
    runGate: (script, cwd) => {
      // A full e2e run prints well past spawnSync's 1 MiB default; at that bound the child was
      // SIGTERMed with ENOBUFS, the count line was cut off, and a GREEN gate graded RED.
      const run = spawnSync("pnpm", ["run", script], {
        cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, maxBuffer: GATE_OUTPUT_MAX_BYTES,
        shell: process.platform === "win32",
      });
      const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      // No exit status is an UNOBSERVED outcome, not exit 1: name the reason and let the
      // producer refuse the evidence as unreadable instead of reporting a failing gate.
      if (run.error !== undefined || run.status === null) {
        const code = (run.error as NodeJS.ErrnoException | undefined)?.code;
        return { exitCode: null, failure: code ?? run.signal ?? "no exit status", output };
      }
      return { exitCode: run.status, output };
    },
    temporaryDirectory: (prefix) => mkdtempSync(join(tmpdir(), prefix)),
    writeFile: (path, bytes) => { writeFileSync(path, bytes, { flag: "wx" }); },
  };
  return Object.freeze(ports);
}

function refusedAll(
  input: V2ReadinessEvidenceCollectInput, code: V2EvidenceRefused["code"], detail: string,
): V2ReadinessEvidenceReceipt {
  const refused: Partial<Record<V2ReadinessEvidenceKind, Omit<V2EvidenceRefused, "kind" | "ok">>> = {};
  for (const kind of V2_READINESS_EVIDENCE_KINDS) {
    refused[kind] = { code, detail, layer: V2_READINESS_MANIFEST_LAYER, upstream: null };
  }
  return Object.freeze({
    evidenceRoot: input.evidenceRoot, ok: false, produced: {}, refused, sourceCommit: input.sourceCommit,
  });
}

export function collectV2ReadinessEvidence(
  ports: V2ReadinessEvidencePorts, input: V2ReadinessEvidenceCollectInput,
): V2ReadinessEvidenceReceipt {
  if (!COMMIT_HEX.test(input.sourceCommit)) {
    return refusedAll(input, "V2_EVIDENCE_SOURCE_COMMIT_INVALID", input.sourceCommit.slice(0, 64));
  }
  const outcomes: V2EvidenceOutcome[] = [];
  outcomes.push(produceContractSchema({ contractDigest: ports.contractDigestPin }));
  outcomes.push(produceWindowsPackagingEvidence(ports, input.windows, input.sourceCommit));
  outcomes.push(produceStoreMigrationEvidence(ports, input, input.sourceCommit));

  // The store is opened AFTER the migration producer snapshotted it read-only, and closed
  // before this tool exits; the readiness writer opens its own handle later.
  const store = SqliteEventStore.openForProject(input.storePath, input.projectId);
  try {
    outcomes.push(produceBackupEvidence({
      generation: {
        config: { storeRoot: input.storeRoot },
        readFileText: (path: string) => new TextDecoder().decode(ports.readFile(path)),
        store,
      },
      projectId: input.projectId,
      store,
    }, input.sourceCommit));
  } finally {
    store.close();
  }
  outcomes.push(produceSecurityEvidence(ports, input.security, input.sourceCommit));
  outcomes.push(produceAcceptanceEvidence(ports, { sourceRoot: input.sourceRoot }, input.sourceCommit));
  outcomes.push(...refuseAbsentProducers());

  const produced: Partial<Record<V2ReadinessEvidenceKind, Readonly<{ file: string; sha256: string }>>> = {};
  const refused: Partial<Record<V2ReadinessEvidenceKind, Omit<V2EvidenceRefused, "kind" | "ok">>> = {};
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      const { kind: _kind, ok: _ok, ...rest } = outcome;
      refused[outcome.kind] = rest;
      continue;
    }
    const file = join(input.evidenceRoot, V2_READINESS_EVIDENCE_FILENAMES[outcome.kind]);
    try {
      ports.writeFile(file, outcome.bytes);
    } catch (error) {
      refused[outcome.kind] = {
        code: "V2_EVIDENCE_OUTPUT_CONFLICT",
        detail: `${file}: ${error instanceof Error ? error.message : String(error)}`,
        layer: V2_READINESS_MANIFEST_LAYER,
        upstream: null,
      };
      continue;
    }
    produced[outcome.kind] = { file, sha256: outcome.sha256 };
  }
  const covered = new Set([...Object.keys(produced), ...Object.keys(refused)]);
  if (covered.size !== V2_READINESS_EVIDENCE_KINDS.length) throw new Error("unreachable: a kind went unanswered");
  return Object.freeze({
    evidenceRoot: input.evidenceRoot,
    ok: Object.keys(refused).length === 0,
    produced,
    refused,
    sourceCommit: input.sourceCommit,
  });
}
