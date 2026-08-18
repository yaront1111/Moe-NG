import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The daemon mapper's INDEPENDENCE from `projectLegacyImport`, asserted structurally.
 *
 * WHY THIS TEST IS STRUCTURAL AND NOT BEHAVIOURAL, and the reasoning matters more than the
 * assertions. The tautology this guards against is: if the CURRENT side is mapped by
 * `projectLegacyImport` — the LEGACY side's mapper — then `compareShadowProjections` runs one
 * function against itself and reports perfect agreement forever, including after a future
 * change to `projectLegacyImport` that should have shown up as a disagreement.
 *
 * A behavioural drill cannot catch that. Replacing the daemon mapper's body with a call to
 * `projectLegacyImport` was run as a mutation drill and the whole suite stayed GREEN — and
 * correctly so: the two mappings MUST agree on honest data, or every entity would report
 * absent on both sides and the adapter would be useless. Behavioural equivalence on honest
 * input is the required behaviour, so no assertion over outputs can distinguish "the daemon
 * has its own mapping" from "the daemon delegates to the importer's".
 *
 * What distinguishes them is STRUCTURE, so structure is what is asserted: the mapper names
 * `projectLegacyImport` nowhere, and it has NO local import at all — which closes the
 * transitive path too, because a shared helper would have to arrive through one.
 *
 * Every scan below carries a POSITIVE CONTROL against a file that DOES contain what is being
 * searched for. Without one, a scanner pointed at the wrong path, or a regex that never
 * matches, passes while reading nothing.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));

function sourceOf(name: string): string {
  const text = readFileSync(`${HERE}${name}`, "utf8");
  if (text.length === 0) throw new Error(`${name} read as empty; the scan would be vacuous`);
  return text;
}

/** Every `from "..."` specifier the module declares, in order. */
function specifiersOf(source: string): readonly string[] {
  return [...source.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+"([^"]+)";/gu)]
    .map((match) => match[1] ?? "");
}

/** Comment lines stripped, so a header that EXPLAINS a forbidden name cannot fail the scan. */
function executableOf(source: string): string {
  return source.split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("/*"))
    .join("\n");
}

const MAPPER = sourceOf("import-shadow-mapper.ts");
const READER = sourceOf("import-shadow-reader.ts");

describe("import shadow mapper — independence from the legacy projector", () => {
  it("reads both sources nonempty, so no scan below is vacuous", () => {
    expect(MAPPER.length).toBeGreaterThan(1000);
    expect(READER.length).toBeGreaterThan(1000);
  });

  it("never names projectLegacyImport outside its own explanation of why it must not", () => {
    expect(executableOf(MAPPER)).not.toContain("projectLegacyImport");
    // POSITIVE CONTROL: the same scan over the reader DOES find it, because the reader
    // legitimately projects the LEGACY side with it inside `compareImportShadow`. A scan
    // that found nothing anywhere would be proving only that it does not work.
    expect(executableOf(READER)).toContain("projectLegacyImport");
    // And the mapper's header DOES name it, so the stripping removed comments, not code.
    expect(MAPPER).toContain("projectLegacyImport");
  });

  it("declares no local import, so no shared helper can carry the legacy mapping in", () => {
    const specifiers = specifiersOf(MAPPER);

    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers).toEqual(["node:crypto", "@moe/import", "@moe/import"]);
    expect(specifiers.filter((one) => one.startsWith("."))).toEqual([]);
    // POSITIVE CONTROL: the reader DOES declare local imports, so the specifier scanner is
    // demonstrably capable of finding one.
    expect(specifiersOf(READER).filter((one) => one.startsWith("."))).not.toEqual([]);
  });

  it("takes only the published contract from @moe/import, never the projector module", () => {
    const runtime = /import \{\s*([^}]*?)\s*\} from "@moe\/import";/u.exec(MAPPER);

    expect(runtime).not.toBeNull();
    const named = (runtime?.[1] ?? "").split(",").map((one) => one.trim()).filter(Boolean);
    expect(named.length).toBeGreaterThan(0);
    expect(named.sort()).toEqual(["SHADOW_ENTITY_FIELDS", "SHADOW_PROJECTION_VERSION"]);
  });

  it("computes its own link digest rather than borrowing one", () => {
    expect(MAPPER).toContain('from "node:crypto"');
    expect(MAPPER).toContain("createHash(\"sha256\")");
    expect(MAPPER).not.toContain("canonicalDigest");
  });

  it("reaches no board projection, byType count or claim ledger", () => {
    const executable = executableOf(MAPPER);

    for (const forbidden of ["BoardProjection", "byType", "WorkClaimLedger", "boardProjection"]) {
      expect(executable).not.toContain(forbidden);
      // POSITIVE CONTROL: the header COMMENT names each of these while explaining why the
      // mapper must not reach them, so a scan that stripped too much would find nothing at
      // all — and this pairing proves the stripping removed comments rather than the code.
      expect(MAPPER).toContain(forbidden === "boardProjection" ? "BoardProjection" : forbidden);
    }
    expect(executable).toContain("SHADOW_ENTITY_FIELDS");
  });
});
