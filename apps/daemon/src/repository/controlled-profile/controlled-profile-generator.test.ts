import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  BOOTSTRAP_PRODUCT_NAME_INVALID,
  BOOTSTRAP_PROFILE_VERSION_UNKNOWN,
  CONTROLLED_PROFILE_VERSION,
  MIGRATION_TOOL_MISSING,
  generateControlledProfile,
} from "./controlled-profile-generator.js";
import type { ControlledProfileRefusal, ControlledProfileRefusalCode, ControlledProfileTree } from "./controlled-profile-generator.js";

/**
 * The golden for profile version `controlled-4`.
 *
 * THE EXPECTATIONS ARE LINE ARRAYS FOR THE SAME REASON THE TEMPLATES ARE: a multi-line template
 * literal in this file would capture THIS file's checkout line endings, so the golden would pass on
 * an LF checkout and fail on a CRLF one while the generator was innocent. The newline lives in the
 * code on both sides of the comparison.
 *
 * A tree change is a profile VERSION BUMP, not a re-bake of the numbers below (task rail 4).
 * Re-mint the lockfile when dependencies move; controlled-4 deliberately reuses v2's lock bytes.
 * If you are here to make a failing arm green, that is the question to answer first.
 */

const lines = (parts: readonly string[]): string => `${parts.join("\n")}\n`;

/** Pinned independently of the manifest: a dropped file must not be able to shrink both sides. */
const GOLDEN_FILE_COUNT = 23;

const GOLDEN_MANIFEST: readonly string[] = [
  ".env.example  79bcb754cd763c0996100e4be74218a0b32b5be9f6b0c5908b33ee6db266f280",
  ".github/workflows/ci.yml  5ec9a41f863ff4a9083f17f2702202f1fc3bba15c872d7f326a4e82cff06a602",
  ".gitignore  f9dc6d94a2d0deef95cde70cd545145f8d5e2f3d3251dc2d4581e596bfccb2ee",
  "README.md  a3dcfc8a3e2983866c7837be7939f6b604f06d4804a30261c4a3437512f82844",
  "docker-compose.yml  261dd4ea71c6a45be1e878572b246df4a9bf1376347815feb2d66819eef81e20",
  "e2e/smoke.spec.ts  a95824a6d628fd30f3f36ce95c23cbd7a33001632871c437f71908a955fde76b",
  "migrations/1700000000000-initial.js  e3e86d8ce26dba4f1f3f8bb69572d7a37a99fc8c39eb7e8b4d7fb814c9317a5e",
  "package.json  636ff642a319817c158ed9a9094d479bf231546cec745ffc710b2004a77803b3",
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
  "pnpm-lock.yaml  0963d16c8e4227942c882ed08bdba2f8a7e74d4339b92bc6e10952357c286265",
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
  "    \"db:down\": \"docker compose down -v\",",
  "    \"db:migrate\": \"node-pg-migrate up\",",
  "    \"db:migrate:down\": \"node-pg-migrate down 1\"",
  "  },",
  "  \"dependencies\": {",
  "    \"node-pg-migrate\": \"9.0.0\",",
  "    \"pg\": \"8.23.0\"",
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
  "# Credentials come from .env; the password is mounted as a secret, not container metadata.",
  "# Copy .env.example to .env and fill it in; `docker compose` loads .env from this directory.",
  "services:",
  "  db:",
  "    image: postgres:17-alpine",
  "    restart: unless-stopped",
  "    depends_on:",
  "      db-password-guard:",
  "        condition: service_completed_successfully",
  "    environment:",
  "      POSTGRES_USER: ${POSTGRES_USER:-app}",
  "      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password",
  "      POSTGRES_DB: ${POSTGRES_DB:-app}",
  "    secrets:",
  "      - source: POSTGRES_PASSWORD",
  "        target: postgres_password",
  "    ports:",
  '      - "5432:5432"',
  "    volumes:",
  "      - db-data:/var/lib/postgresql/data",
  "    healthcheck:",
  '      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-app} -d ${POSTGRES_DB:-app}"]',
  "      interval: 5s",
  "      timeout: 5s",
  "      retries: 20",
  "",
  "  # REFUSES BEFORE THE DATABASE INITIALISES. The mounted secret carries your EXACT bytes, but",
  "  # postgres reads it through a command substitution, which strips trailing newlines - so a",
  "  # newline-bearing password initialises a credential that is NOT the one you hold, and you",
  "  # can never log in. `wc -l` reports a COUNT of newline bytes and nothing else: never cat,",
  "  # echo or interpolate this file, on any path, in any message. A missing or unreadable secret",
  "  # refuses here too, so `db` is never started by a guard that could not do its job.",
  "  db-password-guard:",
  "    image: postgres:17-alpine",
  '    entrypoint: ["/bin/sh", "-c"]',
  "    command:",
  "      - |",
  "        test -r /run/secrets/postgres_password || {",
  "          echo 'POSTGRES_PASSWORD_SECRET_UNREADABLE: /run/secrets/postgres_password is missing or unreadable.' >&2",
  "          exit 1",
  "        }",
  "        wc -l < /run/secrets/postgres_password | grep -qx 0 || {",
  "          echo 'POSTGRES_PASSWORD_NEWLINE_UNSUPPORTED: POSTGRES_PASSWORD contains a newline. The database initialises the value without it, so the credential you hold is not the credential the database has. Remove the newline from .env and re-run.' >&2",
  "          exit 1",
  "        }",
  "    secrets:",
  "      - source: POSTGRES_PASSWORD",
  "        target: postgres_password",
  "",
  "volumes:",
  "  db-data:",
  "",
  "secrets:",
  "  POSTGRES_PASSWORD:",
  "    environment: ${POSTGRES_PASSWORD:+POSTGRES_PASSWORD}",
  "    # Only the NAME is emitted. Empty/unset refuses with POSTGRES_PASSWORD in the error.",
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

function composePasswordConfig(mode: "supplied" | "unset" | "empty") {
  const root = mkdtempSync(join(tmpdir(), "moe-compose-password-"));
  const value = randomBytes(24).toString("hex");
  const env: NodeJS.ProcessEnv = { ...process.env, POSTGRES_USER: "app", POSTGRES_DB: "app" };
  delete env.POSTGRES_PASSWORD;
  try {
    writeFileSync(join(root, "compose.yaml"), tree("password-probe").files.get("docker-compose.yml") ?? "");
    writeFileSync(join(root, ".env"), mode === "unset" ? "" : `POSTGRES_PASSWORD='${mode === "empty" ? "" : value}'\n`);
    const result = spawnSync("docker", ["compose", "--project-name", "moe-password-probe", "--env-file", ".env",
      "-f", "compose.yaml", "config", "--format", "json"], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    // Never expose subprocess output or credential-shaped values in a failed assertion.
    return { exitCode: result.status, spawnFailed: result.error !== undefined,
      valueMatches: output.split(value).length - 1,
      missingPasswordRefusal: output.includes('secret "POSTGRES_PASSWORD" must declare either `file` or `environment`: invalid compose project') };
  } finally {
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error("unsafe compose fixture cleanup");
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

describe("the controlled profile generator", () => {
  it("delivers the database password only through a guarded secret source", () => {
    const body = tree("password-probe").files.get("docker-compose.yml") ?? "";
    expect(body.split("\n").filter((line) => /^ {6}POSTGRES_PASSWORD(?:_FILE)?:/.test(line)))
      .toEqual(["      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password"]);
    expect(body).toContain("      - source: POSTGRES_PASSWORD\n        target: postgres_password\n");
    expect(body).toContain("secrets:\n  POSTGRES_PASSWORD:\n    environment: ${POSTGRES_PASSWORD:+POSTGRES_PASSWORD}\n");
  });

  // Real Compose parsing is opt-in; the always-on shape arm above prevents a zero-case default.
  it.runIf(process.env.MOE_SCAFFOLD_COMPOSE === "1").each(["supplied", "unset", "empty"] as const)(
    "keeps compose password metadata value-free and refuses missing input: %s", (mode) => {
      expect(composePasswordConfig(mode)).toEqual({ exitCode: mode === "supplied" ? 0 : 1,
        spawnFailed: false, valueMatches: 0, missingPasswordRefusal: mode !== "supplied" });
    },
  );

  it("defines the missing-tool vocabulary without inventing a workspace detector", () => {
    expect(MIGRATION_TOOL_MISSING).toBe("MIGRATION_TOOL_MISSING");
    expectTypeOf<typeof MIGRATION_TOOL_MISSING>().toMatchTypeOf<ControlledProfileRefusalCode>();
    expectTypeOf<ControlledProfileRefusal["refusedBy"]>().toEqualTypeOf<"DAEMON_INGRESS">();
  });

  it("identifies the secret-capable profile with a new version", () => {
    expect(CONTROLLED_PROFILE_VERSION).toBe("controlled-4");
  });

  it("ships a migration tool with both directions and a nonempty migration", () => {
    const files = tree("alpha-product").files;
    const manifest = JSON.parse(files.get("package.json") ?? "{}") as {
      readonly scripts?: Readonly<Record<string, string>>;
      readonly dependencies?: Readonly<Record<string, string>>;
    };
    expect.soft(manifest.scripts?.["db:migrate"]).toBe("node-pg-migrate up");
    expect.soft(manifest.scripts?.["db:migrate:down"]).toBe("node-pg-migrate down 1");
    expect.soft(manifest.dependencies?.["node-pg-migrate"]).toBe("9.0.0");
    expect.soft(manifest.dependencies?.["pg"]).toBe("8.23.0");
    const migrations = [...files].filter(([path]) => path.startsWith("migrations/"));
    expect(migrations.map(([path]) => path)).toEqual(["migrations/1700000000000-initial.js"]);
    expect(migrations[0]?.[1].trim().length).toBeGreaterThan(0);
  });

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

  it("never re-declares a name the profile section already assigns", () => {
    // The collision case, and it is not exotic: `DATABASE_URL` is the canonical required name in
    // this row's own environment tests, and the profile already assigns it a real value. Appending
    // the contract's names blind emits `DATABASE_URL=` a second time, and EVERY consumer of these
    // bytes is last-wins — README:170 `cp .env.example .env`, docker-compose's dotenv load, and the
    // generated app's `process.env.DATABASE_URL ?? "<default>"`, which does NOT fall back on "".
    // So a blind append hands the operator an empty connection string and no error naming why.
    const body = envExampleOf(withNames(["DATABASE_URL", "POSTGRES_PASSWORD"]));
    const assignments = body.split("\n").filter((line) => !line.startsWith("#") && line.includes("="));
    const keys = assignments.map((line) => line.slice(0, line.indexOf("=")));

    // File-wide, not just for the two colliding names: no key may be assigned twice anywhere.
    expect(keys).toEqual([...new Set(keys)]);
    expect(assignments.filter((line) => line.startsWith("DATABASE_URL=")))
      .toEqual(["DATABASE_URL=postgres://app:CHANGE_ME@localhost:5432/app"]);
    expect(assignments.filter((line) => line.startsWith("POSTGRES_PASSWORD=")))
      .toEqual(["POSTGRES_PASSWORD=CHANGE_ME"]);
  });

  it("emits the profile's own bytes when EVERY required name is one the profile assigns", () => {
    // The exclusion has to happen BEFORE the "any names left?" decision, or a fully-colliding
    // contract still gets the contract heading followed by nothing — a section announcing names
    // it does not list. Byte-identity is the strongest available statement of that, and it is the
    // same pin DoD 5 uses for the no-names case.
    const untouched = envExampleOf(tree("alpha-product"));

    expect(envExampleOf(withNames(["POSTGRES_PASSWORD"]))).toBe(untouched);
    expect(envExampleOf(withNames(["DATABASE_URL", "POSTGRES_USER", "PORT"]))).toBe(untouched);
    expect(envExampleOf(withNames(["DATABASE_URL", "APP_SECRET_NAME"])))
      .toContain("\nAPP_SECRET_NAME=\n");
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

  it.each(["controlled-2", "controlled-3", "controlled-999"])("refuses an unknown profile version at the daemon ingress layer: %s", (profileVersion) => {
    const result = generateControlledProfile({ productName: "alpha-product", profileVersion });
    expect(result.ok).toBe(false); // Keep a wrong-version red from printing the entire generated tree.
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
