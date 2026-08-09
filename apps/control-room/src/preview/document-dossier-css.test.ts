import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles/document-dossier.css"), "utf8");

describe("document dossier long-token layout", () => {
  it("gives every proposal identity token an explicit wrapping hook", () => {
    const tokenRule = /\.cr-dossier-token\s*\{(?<body>[^}]*)\}/u.exec(css)?.groups?.["body"];

    expect(tokenRule ?? "DOSSIER_TOKEN_RULE_MISSING").toContain("min-inline-size: 0;");
    expect(tokenRule ?? "DOSSIER_TOKEN_RULE_MISSING").toContain("overflow-wrap: anywhere;");
  });
});
