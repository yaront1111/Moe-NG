import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TestProject } from "vitest/node";

/**
 * The receipts directory is run-scoped and REMOVED at teardown: a receipt that survived
 * one run could be credited to the next. `MOE_SECURITY_EVIDENCE_OUT` is the one exception,
 * for the release collector: when set, teardown first COPIES the receipts to
 * `<out>/receipts/` and writes `<out>/security-run.json` naming this run's id, so the
 * collector can bind the receipts to exactly this run. The lane itself still credits
 * nothing from that copy — it reads only the live directory it injected.
 */
export const SECURITY_EVIDENCE_OUT_ENV = "MOE_SECURITY_EVIDENCE_OUT";

export default function setupSecurityReceipts({ provide }: TestProject): () => void {
  const runId = randomUUID();
  const receiptsDirectory = join(tmpdir(), `moe-security-receipts-${runId}`);
  mkdirSync(receiptsDirectory);
  provide("securityRunId", runId);
  provide("securityReceiptsDir", receiptsDirectory);
  return () => {
    const out = process.env[SECURITY_EVIDENCE_OUT_ENV];
    if (out !== undefined && out !== "") {
      mkdirSync(out, { recursive: true });
      cpSync(receiptsDirectory, join(out, "receipts"), { recursive: true });
      writeFileSync(join(out, "security-run.json"), `${JSON.stringify({ runId })}\n`, {
        encoding: "utf8", flag: "wx",
      });
    }
    rmSync(receiptsDirectory, { force: true, recursive: true });
  };
}
