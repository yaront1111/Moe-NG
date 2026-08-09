import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const styles = resolve(process.cwd(), "src/styles");
const css = readFileSync(resolve(styles, "document-dossier.css"), "utf8");
const presentationCss = readFileSync(
  resolve(styles, "document-dossier-presentation.css"), "utf8",
);

describe("document dossier long-token layout", () => {
  it("loads the focused proposal-evidence stylesheet through the dossier entrypoint", () => {
    expect(css).toContain('@import "./document-dossier-presentation.css";');
  });

  it("gives every proposal identity token an explicit wrapping hook", () => {
    const tokenRule = /\.cr-dossier-token\s*\{(?<body>[^}]*)\}/u
      .exec(presentationCss)?.groups?.["body"];

    expect(tokenRule ?? "DOSSIER_TOKEN_RULE_MISSING").toContain("min-inline-size: 0;");
    expect(tokenRule ?? "DOSSIER_TOKEN_RULE_MISSING").toContain("overflow-wrap: anywhere;");
  });
});
