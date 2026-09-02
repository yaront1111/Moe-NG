#!/usr/bin/env node
import { lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { packWindows } from "./pack-windows.js";
import { parseWindowsPackToolchain } from "./pack-toolchain-codec.js";

const SOURCE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const INPUT_ERROR = "PACK_SOURCE_INPUT_INVALID" as const;
const MAX_TOOLCHAIN_MANIFEST_BYTES = 32 * 1024 * 1024;

interface MaterializedPackArguments {
  readonly outputRoot: string;
  readonly sourceSha: string;
  readonly toolchainDigest: string;
  readonly toolchainManifest: string;
}

function parseArguments(argv: readonly string[]): MaterializedPackArguments {
  if (argv.length !== 8 || argv[0] !== "--output-root" || argv[2] !== "--source-sha"
    || argv[4] !== "--toolchain-manifest" || argv[6] !== "--toolchain-digest"
  ) {
    throw new Error(INPUT_ERROR);
  }
  const outputRoot = argv[1];
  const sourceSha = argv[3];
  const toolchainManifest = argv[5];
  const toolchainDigest = argv[7];
  if (outputRoot === undefined || !isAbsolute(outputRoot)
    || sourceSha === undefined || !SOURCE_SHA.test(sourceSha)
    || toolchainManifest === undefined || !isAbsolute(toolchainManifest)
    || toolchainDigest === undefined || !/^[0-9a-f]{64}$/u.test(toolchainDigest)) {
    throw new Error(INPUT_ERROR);
  }
  return Object.freeze({ outputRoot, sourceSha, toolchainDigest, toolchainManifest });
}

export function runMaterializedWindowsPack(argv: readonly string[]): number {
  const arguments_ = parseArguments(argv);
  const manifestStat = lstatSync(arguments_.toolchainManifest);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()
    || manifestStat.size <= 0 || manifestStat.size > MAX_TOOLCHAIN_MANIFEST_BYTES) {
    throw new Error(INPUT_ERROR);
  }
  const manifest = readFileSync(arguments_.toolchainManifest);
  const digest = createHash("sha256").update(manifest).digest("hex");
  if (digest !== arguments_.toolchainDigest) throw new Error(INPUT_ERROR);
  const toolchain = parseWindowsPackToolchain(manifest.toString("utf8"));
  const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
  const status = packWindows({
    log: (line) => process.stdout.write(`${line}\n`),
    outputRoot: arguments_.outputRoot,
    sourceRoot,
    sourceSha: arguments_.sourceSha,
    toolchain,
  });
  return status;
}

const meta = import.meta as ImportMeta & { readonly main?: boolean };
if (meta.main === true) {
  try {
    process.exitCode = runMaterializedWindowsPack(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
