import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TestProject } from "vitest/node";

export default function setupSecurityReceipts({ provide }: TestProject): () => void {
  const runId = randomUUID();
  const receiptsDirectory = join(tmpdir(), `moe-security-receipts-${runId}`);
  mkdirSync(receiptsDirectory);
  provide("securityRunId", runId);
  provide("securityReceiptsDir", receiptsDirectory);
  return () => rmSync(receiptsDirectory, { force: true, recursive: true });
}
