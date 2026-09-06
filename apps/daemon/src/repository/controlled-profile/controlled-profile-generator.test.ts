import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  BOOTSTRAP_PRODUCT_NAME_INVALID,
  BOOTSTRAP_PROFILE_VERSION_UNKNOWN,
  CONTROLLED_PROFILE_VERSION,
  generateControlledProfile,
} from "./controlled-profile-generator.js";
import type { ControlledProfileTree } from "./controlled-profile-generator.js";

/**
 * The golden for profile version `controlled-1`.
 *
 * THE EXPECTATIONS ARE LINE ARRAYS FOR THE SAME REASON THE TEMPLATES ARE: a multi-line template
 * literal in this file would capture THIS file's checkout line endings, so the golden would pass on
 * an LF checkout and fail on a CRLF one while the generator was innocent. The newline lives in the
 * code on both sides of the comparison.
 *
 * A tree change is a profile VERSION BUMP plus a lockfile re-mint, not a re-bake of the numbers
 * below (task rail 4). If you are here to make a failing arm green, that is the question to answer
 * first.
 */

const lines = (parts: readonly string[]): string => `${parts.join("\n")}\n`;

/** Pinned independently of the manifest: a dropped file must not be able to shrink both sides. */
const GOLDEN_FILE_COUNT = 22;

const GOLDEN_MANIFEST: readonly string[] = [
  ".env.example  79bcb754cd763c0996100e4be74218a0b32b5be9f6b0c5908b33ee6db266f280",
  ".github/workflows/ci.yml  5ec9a41f863ff4a9083f17f2702202f1fc3bba15c872d7f326a4e82cff06a602",
  ".gitignore  f826c49d92c5b7d00b3552c66fa3ae22fe971202d8979aa86ee569df1f2d475b",
  "README.md  a3dcfc8a3e2983866c7837be7939f6b604f06d4804a30261c4a3437512f82844",
  "docker-compose.yml  288945fa1cb9987f9bd53988e947bbdb4b46007a59a86237f6efdb229f718a1b",
  "e2e/smoke.spec.ts  a95824a6d628fd30f3f36ce95c23cbd7a33001632871c437f71908a955fde76b",
  "package.json  d5f81c82fd8aea2c87b56231699fbf1127ef915b0ea11fa5de1579b385685273",
  "packages/api/package.json  c65c030d218fb886c4fd5818741c2ecc285525c4c18803318aaf74d6da333aa2",
  "packages/api/src/server.test.ts  7cfc1d3be1727f619954179bb72e238568e9a2cd328bda3af1c39eb41b04d4eb",
  "packages/api/src/server.ts  4626961d3835c02df9a029cb0d33b00b63c7929d0dc8480511c3ed545ec508a4",
  "packages/api/tsconfig.json  c4062e40e3d3b570b2a97baf6eb03df888d695f66ef4d1922e222a9bbab8a118",
  "packages/web/index.html  3dbcf875b7dfb41c393c51e420eeb0daa1801b8518a8aef92a38e2a11a587346",
  "packages/web/package.json  7cc439ea3ca8481e5c5b4d41fad9313fa4a1c29b70edd4d4de7cacb70686244d",
  "packages/web/src/App.test.tsx  1dd556616873d35442a81c1b6b0e5327ecf5d618877d1f625268ce244f132a97",
  "packages/web/src/App.tsx  385e6b8f5ac53692544766cd8212d2dcd3158e557d1b7ada21069d6c00d67b6c",
  "packages/web/src/main.tsx  ea2a32dc659a84cf41f3b8abd73976c6a525404f51994f0869014508d6d51ff0",
  "packages/web/tsconfig.json  5a197bd00fae5a7454418d37d81843d9e0d066c581e4a2d01e836080cf9450b9",
  "packages/web/vite.config.ts  cfda1f16ee2db7d7b934da70509324a71f00fc42075424d10b8d165ed806c2d6",
  "playwright.config.ts  ea00147846c56cde50ac6975f343838358066c842db859634bbcc7e220148484",
  "pnpm-lock.yaml  a6178fdb912e8767544df933c864ca9ac71ace4a4a83f75a3e2c45574737c045",
  "pnpm-workspace.yaml  10b63061ba3d21ebb4a606a5bfcd508ef5fb53443df768ee81c841cff1bbe97e",
  "tsconfig.base.json  d63e25fd53b460a59be94b9e4a784cb7f4cb36bab4df879893e15c8793cd1136",
];

const EXPECTED_ROOT_PACKAGE_JSON = lines([
  "{",
  "  \"name\": \"alpha-product\",",
  "  \"version\": \"0.1.0\",",
  "  \"private\": true,",
  "  \"type\": \"module\",",
  "  \"packageManager\": \"pnpm@11.0.8\",",
  "  \"engines\": {",
  "    \"node\": \">=24.16.0 <25\"",
  "  },",
  "  \"scripts\": {",
  "    \"typecheck\": \"pnpm --recursive typecheck\",",
  "    \"test\": \"pnpm --recursive test\",",
  "    \"build\": \"pnpm --recursive build\",",
  "    \"e2e\": \"playwright test\",",
  "    \"db:up\": \"docker compose up -d\",",
  "    \"db:down\": \"docker compose down -v\"",
  "  },",
  "  \"devDependencies\": {",
  "    \"@playwright/test\": \"1.62.1\",",
  "    \"@types/node\": \"24.13.3\",",
  "    \"typescript\": \"7.0.2\",",
  "    \"vitest\": \"4.1.10\"",
  "  }",
  "}",
]);

const EXPECTED_DOCKER_COMPOSE = lines([
  "# PostgreSQL for local development.",
  "#",
  "# Every credential is read from the environment — no password literal lives in this file. Copy",
  "# .env.example to .env and fill it in; `docker compose` loads .env from this directory.",
  "services:",
  "  db:",
  "    image: postgres:17-alpine",
  "    restart: unless-stopped",
  "    environment:",
  "      POSTGRES_USER: ${POSTGRES_USER:-app}",
  "      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}",
  "      POSTGRES_DB: ${POSTGRES_DB:-app}",
  "    ports:",
  "      - \"5432:5432\"",
  "    volumes:",
  "      - db-data:/var/lib/postgresql/data",
  "    healthcheck:",
  "      test: [\"CMD-SHELL\", \"pg_isready -U ${POSTGRES_USER:-app} -d ${POSTGRES_DB:-app}\"]",
  "      interval: 5s",
  "      timeout: 5s",
  "      retries: 20",
  "",
  "volumes:",
  "  db-data:",
]);

const EXPECTED_CI_WORKFLOW = lines([
  "name: ci",
  "",
  "on:",
  "  push:",
  "    branches: [main]",
  "  pull_request:",
  "",
  "jobs:",
  "  gate:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - uses: pnpm/action-setup@v4",
  "      - uses: actions/setup-node@v4",
  "        with:",
  "          node-version: \"24.16.0\"",
  "          cache: pnpm",
  "      - run: pnpm install --frozen-lockfile",
  "      - run: pnpm typecheck",
  "      - run: pnpm test",
  "      - run: pnpm build",
]);

const sha256 = (body: string): string => createHash("sha256").update(body, "utf8").digest("hex");

const manifestOf = (result: ControlledProfileTree): readonly string[] =>
  [...result.files].map(([path, body]) => `${path}  ${sha256(body)}`);

function tree(productName: string, profileVersion: string = CONTROLLED_PROFILE_VERSION): ControlledProfileTree {
  const result = generateControlledProfile({ productName, profileVersion });
  if (!result.ok) {
    throw new Error(`expected a tree for ${productName}, got refusal ${result.code}`);
  }
  return result;
}

describe("the controlled profile generator", () => {
  it("emits the pinned tree for the profile version", () => {
    const result = tree("alpha-product");

    expect(result.files.size).toBe(GOLDEN_FILE_COUNT);
    expect(manifestOf(result)).toEqual(GOLDEN_MANIFEST);
  });

  it("pins the bytes of package.json, docker-compose.yml and the CI workflow", () => {
    const files = tree("alpha-product").files;

    expect(files.get("package.json")).toEqual(EXPECTED_ROOT_PACKAGE_JSON);
    expect(files.get("docker-compose.yml")).toEqual(EXPECTED_DOCKER_COMPOSE);
    expect(files.get(".github/workflows/ci.yml")).toEqual(EXPECTED_CI_WORKFLOW);
  });

  it("is byte-identical across two generations with identical inputs", () => {
    const first = [...tree("alpha-product").files];
    const second = [...tree("alpha-product").files];

    expect(second).toEqual(first);
  });

  it("differs from another product only where the product name appears", () => {
    const alpha = tree("alpha-product").files;
    const beta = tree("beta-widget").files;

    expect([...beta.keys()]).toEqual([...alpha.keys()]);

    const differing = [...alpha]
      .filter(([path, body]) => beta.get(path) !== body)
      .map(([path]) => path)
      .sort();

    expect(differing.length).toBeGreaterThan(0);
    expect(differing).toEqual(["README.md", "package.json"]);
  });

  it("emits a committed lockfile with no carriage returns", () => {
    const lock = tree("alpha-product").files.get("pnpm-lock.yaml");

    expect(lock).toBeDefined();
    expect((lock ?? "").length).toBeGreaterThan(0);
    expect(lock).toMatch(/^lockfileVersion: /m);
    expect(lock).not.toContain("\r");
  });

  it("emits a CI workflow that actually runs both gates", () => {
    const workflow = tree("alpha-product").files.get(".github/workflows/ci.yml") ?? "";

    expect(workflow).toContain("pnpm typecheck");
    expect(workflow).toContain("pnpm test");
  });
});

/**
 * The contract-derived half of `.env.example`. These arms guard a file that is COMMITTED AND
 * PUSHED into the product's repository, so "no value" is not a style preference here: a value
 * written into these bytes is a value published, and a published file cannot be un-pushed.
 */
describe("the contract's required variable names in .env.example", () => {
  const REQUIRED = ["APP_SECRET_NAME", "DATABASE_URL_EXTRA", "SESSION_SIGNING_KEY"];

  /** Pinned like every other emitted file. Measured, never softened; the no-name pin stands too. */
  const GOLDEN_ENV_EXAMPLE_WITH_NAMES =
    "a391d228e1a3adbd5922aaf8adbce752b02365c01617f05a336338d8fdd379e1";

  const withNames = (
    requiredVariableNames: readonly string[] = REQUIRED,
  ): ControlledProfileTree => {
    const result = generateControlledProfile({
      productName: "alpha-product",
      profileVersion: CONTROLLED_PROFILE_VERSION,
      requiredVariableNames,
    });
    if (!result.ok) throw new Error(`expected a tree, got refusal ${result.code}`);
    return result;
  };

  const envExampleOf = (result: ControlledProfileTree): string =>
    result.files.get(".env.example") ?? "";

  it("names a contract requires NOTHING leaves the file byte-identical to the profile's own", () => {
    // DoD 5. The pre-existing golden hash at the top of this file is the other half of this
    // claim: if the extension were unconditional, `emits the pinned tree` would already be red.
    const untouched = envExampleOf(tree("alpha-product"));

    expect(envExampleOf(withNames([]))).toBe(untouched);
    expect(sha256(untouched)).toBe(
      GOLDEN_MANIFEST.find((row) => row.startsWith(".env.example "))?.split("  ")[1],
    );
  });

  it("carries every required name, and NO VALUE for any of them", () => {
    // DoD 3, in its strict form: each name is present AND the line it is on ENDS at the `=`.
    // A containment check alone is satisfied by `NAME=secret`, which is exactly the leak.
    const body = envExampleOf(withNames());

    for (const name of REQUIRED) {
      expect(body).toMatch(new RegExp(`^${name}=$`, "m"));
      const assignments = body.split("\n").filter((line) => line.startsWith(`${name}=`));
      expect(assignments).toEqual([`${name}=`]);
    }
  });

  it("puts no CHANGE_ME token beside a contract name", () => {
    const contractLines = envExampleOf(withNames())
      .split("\n")
      .filter((line) => REQUIRED.some((name) => line.startsWith(name)));

    expect(contractLines).toEqual(REQUIRED.map((name) => `${name}=`));
    for (const line of contractLines) expect(line).not.toContain("CHANGE_ME");
  });

  it("keeps the profile's own POSTGRES_PASSWORD placeholder readable, with and without names", () => {
    // DoD 4. `repository/deployment/deployment-infrastructure-generator.test.ts` parses this
    // exact shape back out of `.env.example` FROM ANOTHER DIRECTORY to prove no emitted file
    // carries a credential literal. Reformatting the line reds a suite that never mentions
    // this feature, so the coupling is asserted here too, where the edit happens.
    for (const body of [envExampleOf(tree("alpha-product")), envExampleOf(withNames())]) {
      expect(/POSTGRES_PASSWORD=(\S+)/.exec(body)?.[1]).toBe("CHANGE_ME");
      expect(body).toContain("POSTGRES_USER=app");
      expect(body).toContain("PORT=3000");
    }
  });

  it("moves ONLY the .env.example hash, and pins its new value", () => {
    const result = withNames();

    expect(result.files.size).toBe(GOLDEN_FILE_COUNT);
    expect(manifestOf(result)).toEqual(GOLDEN_MANIFEST.map((row) =>
      row.startsWith(".env.example ")
        ? `.env.example  ${GOLDEN_ENV_EXAMPLE_WITH_NAMES}`
        : row));
  });

  it("emits the same bytes for the same SET of names, however they arrive", () => {
    // The names feed a SHA256-pinned file, so caller order and duplicates must not reach it.
    const shuffled = [...REQUIRED].reverse();

    expect(envExampleOf(withNames(shuffled))).toBe(envExampleOf(withNames()));
    expect(envExampleOf(withNames([...REQUIRED, ...REQUIRED]))).toBe(envExampleOf(withNames()));
  });

  it("drops a name the contract grammar could not have admitted", () => {
    // Only reachable by bypassing admission - and this is the boundary that writes bytes, so it
    // re-checks rather than trusting. A newline or an `=` in a name would inject a LINE.
    const body = envExampleOf(withNames(["APP_SECRET_NAME", "OK\nSMUGGLED=secret", "lower"]));

    expect(body).toMatch(/^APP_SECRET_NAME=$/m);
    expect(body).not.toContain("SMUGGLED");
    expect(body).not.toContain("lower");
  });
});

describe("the controlled profile generator's refusals", () => {
  const INVALID_NAMES: readonly string[] = [
    "",
    "../escape",
    "Has Space",
    "UPPER",
    "-leading-hyphen",
    "trailing.dot",
    "a".repeat(65),
  ];

  it("refuses an unknown profile version at the daemon ingress layer", () => {
    const result = generateControlledProfile({ productName: "alpha-product", profileVersion: "controlled-999" });

    expect(result).toEqual({
      ok: false,
      code: BOOTSTRAP_PROFILE_VERSION_UNKNOWN,
      refusedBy: "DAEMON_INGRESS",
    });
  });

  it("refuses every invalid product name with the name code and the same layer", () => {
    expect(INVALID_NAMES).toHaveLength(7);

    for (const productName of INVALID_NAMES) {
      expect(generateControlledProfile({ productName, profileVersion: CONTROLLED_PROFILE_VERSION })).toEqual({
        ok: false,
        code: BOOTSTRAP_PRODUCT_NAME_INVALID,
        refusedBy: "DAEMON_INGRESS",
      });
    }
  });

  it("accepts the longest legal product name, so the length bound is a boundary and not a wall", () => {
    expect(tree("a".repeat(64)).files.size).toBe(GOLDEN_FILE_COUNT);
  });

  it("answers the version code when the version and the name are both invalid", () => {
    const result = generateControlledProfile({ productName: "Has Space", profileVersion: "controlled-999" });

    expect(result).toEqual({
      ok: false,
      code: BOOTSTRAP_PROFILE_VERSION_UNKNOWN,
      refusedBy: "DAEMON_INGRESS",
    });
  });
});
