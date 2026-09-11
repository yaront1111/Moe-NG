import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix } from "node:path";

/**
 * The pack's IMPORT-CLOSURE gate, kept apart from the tree shaping in
 * `pack-staging.ts` because it answers a different question: not "what is in the
 * artifact" but "does what is in the artifact still resolve".
 *
 * It exists because a prune can succeed and still ruin the download — delete a
 * fixture and every surviving module that imported it dies with
 * `ERR_MODULE_NOT_FOUND` on the operator's machine, long after the pack printed
 * a size and exited 0.
 */

export interface ImportFaults {
  /** `<file> -> <specifier>` for a relative import with no target in the tree. */
  readonly dangling: readonly string[];
  /** `<file> -> <package>` for a shipped source importing a dev-only package. */
  readonly devDependency: readonly string[];
}

const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;
export const PACK_SOURCE_SYNTAX_INVALID = "PACK_SOURCE_SYNTAX_INVALID" as const;
// The materialized entry loads before its frozen install. Resolve the parser
// only when the post-install inventory runs, never while importing this module.
const requireParser = createRequire(import.meta.url);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function literalSpecifier(value: unknown): string | null {
  const node = record(value);
  if (node?.["type"] === "StringLiteral" && typeof node["value"] === "string") return node["value"];
  if (node?.["type"] !== "TemplateLiteral" || !Array.isArray(node["expressions"])
    || node["expressions"].length !== 0 || !Array.isArray(node["quasis"])) return null;
  const cooked = record(record(node["quasis"][0])?.["value"])?.["cooked"];
  return typeof cooked === "string" ? cooked : null;
}

function specifiersOf(text: string, file: string): readonly string[] {
  const { parse } = requireParser("@babel/parser") as typeof import("@babel/parser");
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(text, {
      createImportExpressions: true,
      plugins: [
        ...(/\.[cm]?tsx?$/u.test(file) ? ["typescript" as const] : []),
        ...(/\.[jt]sx$/u.test(file) ? ["jsx" as const] : []),
      ],
      sourceType: /\.c[jt]s$/u.test(file) ? "commonjs" : "unambiguous",
    });
  } catch {
    // Parser diagnostics can quote source. A syntax refusal carries no source text.
    throw new Error(PACK_SOURCE_SYNTAX_INVALID);
  }
  const specifiers: string[] = [];
  const pending: unknown[] = [ast];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) { pending.push(...value); continue; }
    const node = record(value);
    if (node === null) continue;
    let target: unknown;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"]
      .includes(String(node["type"]))) target = node["source"];
    else if (node["type"] === "TSImportType") target = node["argument"];
    else if (node["type"] === "TSExternalModuleReference") target = node["expression"];
    else if (node["type"] === "CallExpression") {
      const callee = record(node["callee"]);
      if (callee?.["type"] === "Import"
        || (callee?.["type"] === "Identifier" && callee["name"] === "require")) {
        target = Array.isArray(node["arguments"]) ? node["arguments"][0] : undefined;
      }
    }
    const specifier = literalSpecifier(target);
    if (specifier !== null) specifiers.push(specifier);
    pending.push(...Object.values(node));
  }
  return specifiers;
}

/** `./x.js` in a source file is `./x.ts` on disk, and either end satisfies the import. */
function importCandidates(from: string, specifier: string): readonly string[] {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const stem = base.replace(/\.js$/u, "");
  return [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${base}/index.js`, `${base}/index.ts`];
}

function packageNameOf(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? specifier);
}

/**
 * Proves the pruned tree is still LOADABLE, which is the half of "ships no tests"
 * that a prune can silently break: delete a fixture and any surviving module that
 * imported it dies with `ERR_MODULE_NOT_FOUND` on the operator's machine, long
 * after the pack reported success. It is also what keeps the named test-support
 * list from going stale — an entry that should be there and is not shows up here
 * as a dangling edge and stops the pack.
 */
export function collectImportFaults(
  root: string, files: readonly string[], devDependencies: readonly string[],
): ImportFaults {
  const present = new Set(files);
  const dev = new Set(devDependencies);
  const dangling = new Set<string>();
  const devImports = new Set<string>();
  for (const file of files) {
    if (file.split("/").includes("node_modules") || !SOURCE_FILE.test(file)) continue;
    const text = readFileSync(join(root, file), "utf8");
    for (const specifier of specifiersOf(text, file)) {
      if (specifier.startsWith(".")) {
        if (!importCandidates(file, specifier).some((path) => present.has(path))) {
          dangling.add(`${file} -> ${specifier}`);
        }
      } else {
        const name = packageNameOf(specifier);
        if (dev.has(name)) devImports.add(`${file} -> ${name}`);
      }
    }
  }
  return Object.freeze({
    dangling: Object.freeze([...dangling].sort()),
    devDependency: Object.freeze([...devImports].sort()),
  });
}
