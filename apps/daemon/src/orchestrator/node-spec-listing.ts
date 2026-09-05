/**
 * The spec-dir half of the wrapper's node listing: every `*.json` under the directory that
 * names a `nodeRef`, read one file at a time.
 *
 * Per file, not one try around the whole listing. The wrapper used to parse every spec inside a
 * single try/catch, so ONE unparsable file dropped EVERY spec-dir node from the verifier and the
 * lander — silently, as "no nodes here". A malformed spec is skipped and NAMED to `warn`; an
 * unreadable directory contributes nothing, as before.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPILED_EXECUTION_REF_PREFIX } from "./compiled-execution-ref.js";

export interface NodeSpecListing {
  readonly nodes: readonly { readonly nodeRef: string }[];
  /** `<file>: <reason>` per spec that was skipped, so the omission is disclosed. */
  readonly skipped: readonly string[];
}

export function listNodeSpecs(dir: string): NodeSpecListing {
  const nodes: { nodeRef: string }[] = [];
  const skipped: string[] = [];
  let names: readonly string[] = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return Object.freeze({ nodes: Object.freeze(nodes), skipped: Object.freeze(skipped) });
  }
  for (const name of names) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
      const nodeRef = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as { nodeRef?: unknown }).nodeRef
        : undefined;
      if (typeof nodeRef === "string" && nodeRef.startsWith(COMPILED_EXECUTION_REF_PREFIX)) {
        skipped.push(`${name}: COMPILED_EXECUTION_REF_RESERVED`);
      } else if (typeof nodeRef === "string" && nodeRef.length > 0) nodes.push({ nodeRef });
    } catch (error) {
      skipped.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return Object.freeze({ nodes: Object.freeze(nodes), skipped: Object.freeze(skipped) });
}
