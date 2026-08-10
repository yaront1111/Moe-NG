import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  RECOVERY_KEY_PROTECTION_MECHANISMS,
  RECOVERY_KEY_PROVIDER_LAYER,
} from "./recovery-key-provider-contract.js";
import { createNodeRecoveryKeyProviderPort } from "./recovery-key-provider.node.js";

const execFileAsync = promisify(execFile);

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_ROOT = resolve(SRC_ROOT, "..");

const PROJECT_ID = "proj-key-epoch-node";
const RESTORE_COMMAND_ID = "restore-key-epoch-node";
const GENERATION_DIGEST = "5c".repeat(32);

const roots: string[] = [];

/** Never inside the repo, and cleaned even when a case fails. */
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "moe-key-epoch-node-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

/**
 * The mechanism this host is expected to name, derived from `process.platform`
 * the same way the port derives it. Written as a lookup rather than a hard-coded
 * "win32" so the assertions below stay meaningful on whichever host CI runs, and
 * `null` states plainly that the host has no mechanism and must refuse.
 */
const EXPECTED_MECHANISM: string | null =
  process.platform === "win32"
    ? "WIN32_DACL_EXPLICIT_OWNER_ONLY"
    : process.platform === "darwin" || process.platform === "linux"
      ? "POSIX_MODE_0700_OWNER_ONLY"
      : null;

/**
 * One `open` in a child process that then EXITS. Nothing survives except what
 * reached the store on disk, which is the only thing that makes this a durability
 * proof rather than a simulation: the incarnation service keeps its state in
 * process-local Maps (recovery-incarnation.ts:66-67) and the signing key is a
 * non-extractable CryptoKey, so both die here by construction.
 *
 * The child imports through the `.js` bridges under plain Node, so a missing or
 * malformed bridge fails this case too — vitest would have rewritten the
 * specifier and hidden it.
 */
const CHILD_SOURCE = `
// Passed through the environment rather than argv: with \`node -e\` the index of
// the first user argument is a Node implementation detail, and an off-by-one
// there reads as a mysterious child fault rather than as a wiring mistake.
const storePath = process.env.MOE_STORE_PATH;
const protectedDirectory = process.env.MOE_PROTECTED_DIR;
const projectId = process.env.MOE_PROJECT_ID;
const restoreCommandId = process.env.MOE_RESTORE_COMMAND_ID;
const digest = process.env.MOE_GENERATION_DIGEST;
const label = process.env.MOE_LABEL;
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  const { SqliteEventStore } = await import("@moe/store");
  const { createRecoveryKeyProvider } = await import("./src/recovery/recovery-key-provider.js");
  const { createNodeRecoveryCryptoPort } = await import("./src/recovery/recovery-incarnation.node.js");
  const { createNodeRecoveryKeyProviderPort } = await import("./src/recovery/recovery-key-provider.node.js");
  const { readSuccessionChain } = await import("./src/recovery/recovery-succession.js");

  const store = SqliteEventStore.openForProject(storePath, projectId);
  const provider = createRecoveryKeyProvider(
    createNodeRecoveryCryptoPort(),
    createNodeRecoveryKeyProviderPort(),
  );
  const epoch = await provider.open(store, {
    backupGenerationDigest: digest,
    correlationId: "correlation-" + label,
    decidedAt: "2026-08-10T00:00:00.000Z",
    principalId: "principal-" + label,
    projectId,
    protectedDirectory,
    restoreCommandId,
  });
  if (!epoch.ok) {
    report({ code: epoch.code, layer: epoch.layer, outcome: "REFUSED", truth: epoch.truth });
  } else {
    const chain = readSuccessionChain(store, projectId, epoch.incarnationRef);
    report({
      chainOrigin: chain.ok ? chain.originIncarnationRef : null,
      chainPredecessors: chain.ok ? chain.links.map((link) => link.predecessorIncarnationRef) : null,
      chainSuccessors: chain.ok ? chain.links.map((link) => link.successorIncarnationRef) : null,
      generation: epoch.generation,
      incarnationRef: epoch.incarnationRef,
      mechanism: epoch.protection.mechanism,
      opening: epoch.opening,
      originIncarnationRef: epoch.originIncarnationRef,
      outcome: "OPENED",
      publicKeySpkiHex: epoch.publicKeySpkiHex,
      serialized: JSON.stringify(epoch),
    });
  }
  store.close();
} catch (error) {
  report({ outcome: "THREW", message: String(error && error.message) });
}
process.exit(0);
`;

interface ChildReport {
  readonly outcome: string;
  readonly code?: string;
  readonly layer?: string;
  readonly truth?: string;
  readonly message?: string;
  readonly chainOrigin?: string | null;
  readonly chainPredecessors?: readonly string[] | null;
  readonly chainSuccessors?: readonly string[] | null;
  readonly generation?: number;
  readonly incarnationRef?: string;
  readonly mechanism?: string;
  readonly opening?: string;
  readonly originIncarnationRef?: string;
  readonly publicKeySpkiHex?: string;
  readonly serialized?: string;
}

async function runChild(root: string, label: string): Promise<ChildReport> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", CHILD_SOURCE],
    {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        MOE_GENERATION_DIGEST: GENERATION_DIGEST,
        MOE_LABEL: label,
        MOE_PROJECT_ID: PROJECT_ID,
        MOE_PROTECTED_DIR: root,
        MOE_RESTORE_COMMAND_ID: RESTORE_COMMAND_ID,
        MOE_STORE_PATH: join(root, "store.sqlite"),
      },
    },
  );
  return JSON.parse(stdout) as ChildReport;
}

describe("the epoch survives a real process death and reopens under a new key", () => {
  it(
    "resolves one origin across two separate processes with different keys",
    { timeout: 120_000 },
    async () => {
      const root = temporaryRoot();
      const first = await runChild(root, "first");
      const second = await runChild(root, "second");

      // Fail loudly with the child's own message rather than on a later
      // undefined, so a broken child is never mistaken for a failed assertion.
      expect([first.outcome, first.message]).toEqual(["OPENED", undefined]);
      expect([second.outcome, second.message]).toEqual(["OPENED", undefined]);
      expect(first.opening).toBe("MINTED");
      expect(second.opening).toBe("REOPENED");
      expect(second.generation).toBe(1);

      // The triple that separates a durable reopen from BOTH a simulation and a
      // resurrected key. Any one of these alone passes on a wrong build.
      expect(second.originIncarnationRef).toBe(first.originIncarnationRef);
      expect(second.incarnationRef).not.toBe(first.incarnationRef);
      expect(second.publicKeySpkiHex).not.toBe(first.publicKeySpkiHex);

      // The chain, read by the LANDED reader inside the second process, links
      // that process's successor back to the incarnation the first one left.
      expect(second.chainOrigin).toBe(first.incarnationRef);
      expect(second.chainPredecessors).toEqual([first.incarnationRef]);
      expect(second.chainSuccessors).toEqual([second.incarnationRef]);
    },
  );

  it(
    "keeps the third process on the same origin and never repeats a key",
    { timeout: 120_000 },
    async () => {
      const root = temporaryRoot();
      const first = await runChild(root, "first");
      const second = await runChild(root, "second");
      const third = await runChild(root, "third");

      expect([first.outcome, second.outcome, third.outcome]).toEqual([
        "OPENED",
        "OPENED",
        "OPENED",
      ]);
      expect(third.originIncarnationRef).toBe(first.originIncarnationRef);
      expect(third.generation).toBe(2);
      expect(third.chainPredecessors).toEqual([second.incarnationRef, first.incarnationRef]);
      const keys = [first, second, third].map((report) => report.publicKeySpkiHex);
      expect(new Set(keys).size).toBe(3);
      // No private material crossed the process boundary in the evidence either.
      for (const report of [first, second, third]) {
        expect(report.serialized).not.toContain("keyHandle");
      }
    },
  );
});

describe("the host protection mechanism is named, not assumed", () => {
  it("reports this platform's named mechanism or refuses with a typed UNKNOWN", async () => {
    const root = temporaryRoot();
    const port = createNodeRecoveryKeyProviderPort();
    expect(port.platform).toBe(
      ["win32", "darwin", "linux"].includes(process.platform) ? process.platform : "OTHER",
    );

    const result = await port.protect(root);
    if (EXPECTED_MECHANISM === null) {
      // A host with no mechanism must refuse, never pass optimistically.
      expect([result.ok, result.mechanism]).toEqual([false, "UNKNOWN"]);
      if (result.ok) throw new Error("unreachable");
      expect(result.layer).toBe(RECOVERY_KEY_PROVIDER_LAYER);
      expect(result.code).toBe("RECOVERY_KEY_PROTECTION_UNAVAILABLE");
      return;
    }
    // Asserted against the frozen vocabulary AND against the one name this
    // platform may use, so a port that renamed its mechanism cannot pass.
    expect(RECOVERY_KEY_PROTECTION_MECHANISMS as readonly string[]).toContain(EXPECTED_MECHANISM);
    expect([result.ok, result.mechanism]).toEqual([true, EXPECTED_MECHANISM]);
    expect(result.platform).toBe(process.platform);
  });

  /**
   * The read-back is the assertion, and this is the case that proves it. The
   * apply step SUCCEEDS here — `icacls <dir>\*` exits 0 after processing the
   * children — while the re-read describes a child rather than the object that
   * was asked for. A port that trusted the exit code would report protection it
   * never established; only the read-back can tell the two apart.
   */
  it("refuses with UNVERIFIABLE when the read-back does not describe the request", async () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "child"));
    const port = createNodeRecoveryKeyProviderPort();
    if (process.platform !== "win32") {
      // Stated rather than skipped: only the win32 branch has a read-back that
      // can disagree with an apply the host accepted, because POSIX `chmod`
      // cannot be pointed at a pattern in the first place.
      expect(EXPECTED_MECHANISM).not.toBe("WIN32_DACL_EXPLICIT_OWNER_ONLY");
      return;
    }
    const result = await port.protect(join(root, "*"));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("RECOVERY_KEY_PROTECTION_UNVERIFIABLE");
    expect(result.mechanism).toBe("UNKNOWN");
    expect(result.layer).toBe(RECOVERY_KEY_PROVIDER_LAYER);
    expect(result.platform).toBe("win32");
  });

  it("refuses with UNAVAILABLE when the directory does not exist", async () => {
    const port = createNodeRecoveryKeyProviderPort();
    const result = await port.protect(join(temporaryRoot(), "absent", "epoch"));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.mechanism).toBe("UNKNOWN");
    expect(result.code).toBe("RECOVERY_KEY_PROTECTION_UNAVAILABLE");
    expect(result.layer).toBe(RECOVERY_KEY_PROVIDER_LAYER);
    expect(result.truth).toBe("UNKNOWN");
  });
});
