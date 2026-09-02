import { resolve } from "node:path";

import { collectV2ReadinessEvidence, createSystemEvidencePorts }
  from "./v2-readiness-evidence-collector.js";

/**
 * Release tooling: `node apps/daemon/src/cutover/v2-readiness-evidence-collector-main.ts
 *   --evidence-root=<dir> --source-commit=<40-hex> --source-root=<clean git checkout at that commit>
 *   --project-id=<id> --store-path=<quiesced store.sqlite> --store-root=<dir with live-quiesce-evidence.json>
 *   --windows-release-evidence=<dist/release/<sha>/<digest>/evidence.json>
 *   [--windows-observation=<moe-windows.zip.provenance.json>]
 *   --security-out=<MOE_SECURITY_EVIDENCE_OUT dir of the security lane run>`
 *
 * Run BEFORE `v2-readiness-manifest-writer-main.ts`, which reads the files this writes under
 * `--evidence-root`. Prints one JSON receipt naming each kind's sha256 or refusal; exits 0
 * only when every kind was produced. The acceptance lanes are RUN by this tool at the named
 * commit, so expect it to take as long as `pnpm test:e2e` and `pnpm test:e2e:browser`.
 */

function flag(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const found = argv.find((entry) => entry.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

function print(value: unknown, exitCode: number): never {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  process.exit(exitCode);
}

const argv = process.argv.slice(2);
const required = [
  "evidence-root", "source-commit", "source-root", "project-id", "store-path", "store-root",
  "windows-release-evidence", "security-out",
] as const;
const values: Partial<Record<(typeof required)[number], string>> = {};
for (const name of required) {
  const value = flag(argv, name);
  if (value === null || value === "") {
    print({
      code: "V2_READINESS_EVIDENCE_USAGE", missing: name, ok: false,
      usage: `${required.map((entry) => `--${entry}=`).join(" ")} [--windows-observation=]`,
    }, 2);
  }
  values[name] = value;
}
const observation = flag(argv, "windows-observation");

try {
  const receipt = collectV2ReadinessEvidence(createSystemEvidencePorts(), {
    evidenceRoot: resolve(values["evidence-root"] as string),
    projectId: values["project-id"] as string,
    security: {
      securityOut: resolve(values["security-out"] as string),
      sourceRoot: resolve(values["source-root"] as string),
    },
    sourceCommit: values["source-commit"] as string,
    sourceRoot: resolve(values["source-root"] as string),
    storePath: resolve(values["store-path"] as string),
    storeRoot: resolve(values["store-root"] as string),
    windows: {
      releaseEvidencePath: resolve(values["windows-release-evidence"] as string),
      ...(observation === null || observation === "" ? {} : { observationPath: resolve(observation) }),
    },
  });
  print(receipt, receipt.ok ? 0 : 1);
} catch (error) {
  print({
    code: "V2_READINESS_EVIDENCE_FAILED",
    detail: error instanceof Error ? error.message : String(error),
    ok: false,
  }, 1);
}
