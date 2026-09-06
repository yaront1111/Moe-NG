/**
 * Workspace-root bytes of the controlled profile.
 *
 * DETERMINISM RULE (binds this module and its packages sibling): every generated file is a
 * `readonly string[]` of lines joined with "\n" plus one trailing "\n". NEVER a multi-line template
 * literal — this repo can be checked out with CRLF endings, and a template literal would capture
 * the checkout's own line endings and change the generated tree per host. Nothing here reads a
 * clock, a random source, `process.cwd()`, `os.EOL`, or a host tool version.
 *
 * VERSION PINS are what make `pnpm install --frozen-lockfile` hold in the generated product: the
 * package manager is pinned exactly and EVERY dependency version is exact — no `^`, no `~`, no `*`.
 * Editing any of them is a profile VERSION BUMP plus a lockfile re-mint, not an edit in place.
 *
 * THE PRODUCT NAME REACHES EXACTLY TWO PATHS from this module: `package.json` (its `name`) and
 * `README.md`. docker-compose uses fixed service and database names, and `.env.example` carries
 * placeholder values only, so no emitted file carries a credential literal.
 *
 * THE ONE OTHER CALLER-SUPPLIED INPUT is `requiredVariableNames`, which reaches `.env.example`
 * ALONE and as NAMES ONLY — never a value, and never beside a placeholder. That file is committed
 * and pushed into the product's repository, so a value written there is a value published; the
 * emitter re-checks every name against the contract's own grammar rather than trusting its
 * caller, and an empty set emits the profile's bytes unchanged.
 */
import { isContractVariableName } from "../../environment/environment-required-variables.js";

const file = (lines: readonly string[]): string => `${lines.join("\n")}\n`;

const rootPackageJson = (productName: string): string =>
  file([
    "{",
    `  "name": "${productName}",`,
    '  "version": "0.1.0",',
    '  "private": true,',
    '  "type": "module",',
    '  "packageManager": "pnpm@11.0.8",',
    '  "engines": {',
    '    "node": ">=24.16.0 <25"',
    "  },",
    '  "scripts": {',
    '    "typecheck": "pnpm --recursive typecheck",',
    '    "test": "pnpm --recursive test",',
    '    "build": "pnpm --recursive build",',
    '    "e2e": "playwright test",',
    '    "db:up": "docker compose up -d",',
    '    "db:down": "docker compose down -v"',
    "  },",
    '  "devDependencies": {',
    '    "@playwright/test": "1.62.1",',
    '    "@types/node": "24.13.3",',
    '    "typescript": "7.0.2",',
    '    "vitest": "4.1.10"',
    "  }",
    "}",
  ]);

const PNPM_WORKSPACE = file([
  "packages:",
  "  - packages/*",
  "",
  "# Exact versions only: the profile ships a committed lockfile and every install is frozen.",
  "autoInstallPeers: false",
  "saveExact: true",
]);

const TSCONFIG_BASE = file([
  "{",
  '  "compilerOptions": {',
  '    "target": "ES2024",',
  '    "lib": ["ES2024"],',
  '    "module": "NodeNext",',
  '    "moduleResolution": "NodeNext",',
  '    "strict": true,',
  '    "exactOptionalPropertyTypes": true,',
  '    "noUncheckedIndexedAccess": true,',
  '    "noImplicitOverride": true,',
  '    "forceConsistentCasingInFileNames": true,',
  '    "isolatedModules": true,',
  '    "verbatimModuleSyntax": true,',
  '    "skipLibCheck": true',
  "  }",
  "}",
]);

const GITIGNORE = file([
  "node_modules/",
  "dist/",
  ".env",
  "*.log",
  "playwright-report/",
  "test-results/",
]);

/**
 * THE PROFILE'S OWN LINES. Placeholders, and they are the profile's to choose: docker-compose
 * consumes `POSTGRES_PASSWORD` and `deployment-infrastructure-generator.test.ts` reads the
 * `CHANGE_ME` token back out of these bytes from another directory to prove no emitted file
 * carries a credential literal. Editing any of them moves the golden manifest and reds that
 * cross-directory arm.
 */
const ENV_EXAMPLE_PROFILE_LINES: readonly string[] = [
  "# Copy to .env and replace every CHANGE_ME. .env is gitignored and must never be committed.",
  "# These are PLACEHOLDERS, not credentials.",
  "POSTGRES_USER=app",
  "POSTGRES_PASSWORD=CHANGE_ME",
  "POSTGRES_DB=app",
  "DATABASE_URL=postgres://app:CHANGE_ME@localhost:5432/app",
  "PORT=3000",
];

/**
 * THE NAMES THE PROFILE ITSELF ALREADY ASSIGNS, derived from the lines above rather than listed by
 * hand: those lines are editable, and a hand-kept second list would drift silently the moment
 * someone adds a variable to the profile.
 *
 * THE COLLISION RULE, AND WHY IT GOES THIS WAY. A contract may require a name the profile already
 * supplies - `DATABASE_URL` and `POSTGRES_PASSWORD` are the obvious ones. The profile's line WINS
 * and the contract's declaration is dropped, because the requirement is already SATISFIED by that
 * line: the operator has a value to edit, which is more than a bare name gives them. Appending the
 * name anyway would emit the key TWICE, and every consumer of these bytes is last-wins - README's
 * `cp .env.example .env`, docker compose's dotenv load, and the generated app's
 * `process.env.X ?? "<default>"`, which does NOT fall back on the empty string. The operator would
 * get an empty value with no error naming the cause. The other resolution - letting the contract
 * win and deleting the profile's line - would move the `/POSTGRES_PASSWORD=(\S+)/` read-back in
 * `repository/deployment/deployment-infrastructure-generator.test.ts:305-306` and strip a working
 * placeholder, so it is strictly worse.
 */
const ENV_EXAMPLE_PROFILE_ASSIGNED_NAMES: ReadonlySet<string> = new Set(
  ENV_EXAMPLE_PROFILE_LINES.flatMap((line) => {
    const separator = line.indexOf("=");
    return line.startsWith("#") || separator <= 0 ? [] : [line.slice(0, separator)];
  }),
);

/**
 * WHY THE CONTRACT'S NAMES GET THEIR OWN SECTION RATHER THAN BEING INTERLEAVED. The two halves of
 * this file are different KINDS of fact with different owners. The profile's lines are the
 * profile's, they carry chosen placeholder values, and `CHANGE_ME` is the token the README tells
 * the operator to replace. The contract's names are the PRODUCT's, they carry NO value at all,
 * and there is nothing to replace — only something to supply. Interleaving them would put a
 * `CHANGE_ME`-bearing line beside a bare name and invite the next editor to "finish" the bare one
 * with a placeholder, which is how a value gets published. The blank line and the heading make
 * the boundary visible in the emitted bytes, not just in this module.
 */
const ENV_EXAMPLE_CONTRACT_HEADING: readonly string[] = [
  "",
  "# Required by the product contract. NAMES ONLY: no value is written here, because this file is",
  "# committed and pushed. Supply each one in .env; none has a default and none has a placeholder.",
];

/**
 * `.env.example` for a product whose contract requires `requiredVariableNames`.
 *
 * CONDITIONAL BY CONSTRUCTION. An empty name set returns the profile's lines and nothing else, so
 * a product whose contract names no variables gets bytes IDENTICAL to those emitted before this
 * feature existed — the golden manifest hash for that case does not move, and no project that
 * does not use this is affected.
 *
 * THE EXCLUSION RUNS BEFORE THAT DECISION, deliberately. A contract whose names are ALL names the
 * profile already assigns leaves nothing to list, and it must then emit the profile's bytes
 * exactly - not a heading announcing a section with no lines under it. Filtering first makes the
 * empty case and the fully-colliding case the same case.
 *
 * Names are deduped, re-checked against the contract grammar and sorted by UTF-16 code unit HERE,
 * at the byte-emitting boundary, rather than trusted from the caller. The grammar predicate is
 * IMPORTED, not restated: a second copy could drift, and this is the copy whose drift would
 * publish bytes. `NAME=` with nothing after the `=` is the emitted form — a bare `NAME` is not
 * valid in a file the README tells the operator to `cp` to `.env`, and an empty right-hand side
 * is unambiguously "declared, not supplied".
 */
const envExample = (requiredVariableNames: readonly string[]): string => {
  const names = [...new Set(requiredVariableNames.filter(isContractVariableName))]
    .filter((name) => !ENV_EXAMPLE_PROFILE_ASSIGNED_NAMES.has(name))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return names.length === 0
    ? file(ENV_EXAMPLE_PROFILE_LINES)
    : file([
      ...ENV_EXAMPLE_PROFILE_LINES,
      ...ENV_EXAMPLE_CONTRACT_HEADING,
      ...names.map((name) => `${name}=`),
    ]);
};

const readme = (productName: string): string =>
  file([
    `# ${productName}`,
    "",
    "Bootstrapped from the controlled profile. The profile version is recorded by the tool that",
    "generated this tree; the shape below is identical for every product built from it.",
    "",
    "## Layout",
    "",
    "- `packages/web` — React + Vite front end.",
    "- `packages/api` — Node HTTP API.",
    "- `docker-compose.yml` — PostgreSQL for local development.",
    "- `e2e/` — Playwright end-to-end specs.",
    "",
    "## Getting started",
    "",
    "```sh",
    "cp .env.example .env   # then replace every CHANGE_ME",
    "pnpm install --frozen-lockfile",
    "pnpm db:up",
    "pnpm typecheck && pnpm test && pnpm build",
    "```",
    "",
    "## Gates",
    "",
    "CI runs `pnpm typecheck`, `pnpm test` and `pnpm build` on every push and pull request.",
  ]);

const DOCKER_COMPOSE = file([
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
  '      - "5432:5432"',
  "    volumes:",
  "      - db-data:/var/lib/postgresql/data",
  "    healthcheck:",
  '      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-app} -d ${POSTGRES_DB:-app}"]',
  "      interval: 5s",
  "      timeout: 5s",
  "      retries: 20",
  "",
  "volumes:",
  "  db-data:",
]);

const CI_WORKFLOW = file([
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
  '          node-version: "24.16.0"',
  "          cache: pnpm",
  "      - run: pnpm install --frozen-lockfile",
  "      - run: pnpm typecheck",
  "      - run: pnpm test",
  "      - run: pnpm build",
]);

const PLAYWRIGHT_CONFIG = file([
  'import { defineConfig } from "@playwright/test";',
  "",
  "// The web dev server is started by hand or by CI; the base URL matches vite's default port.",
  "export default defineConfig({",
  '  testDir: "./e2e",',
  "  fullyParallel: true,",
  "  forbidOnly: process.env.CI !== undefined,",
  "  retries: 0,",
  '  reporter: "list",',
  "  use: {",
  '    baseURL: "http://localhost:5173",',
  '    trace: "on-first-retry",',
  "  },",
  "});",
]);

const E2E_SMOKE = file([
  'import { expect, test } from "@playwright/test";',
  "",
  'test("the app shell renders its heading", async ({ page }) => {',
  '  await page.goto("/");',
  '  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();',
  "});",
]);

/**
 * Workspace-root entries of the profile, keyed by forward-slash relative path.
 *
 * `requiredVariableNames` defaults to EMPTY so every existing call site keeps emitting the exact
 * bytes it emitted before, and so the parameter can never be forgotten into a leak.
 */
export function controlledProfileRootFiles(
  productName: string,
  requiredVariableNames: readonly string[] = [],
): ReadonlyMap<string, string> {
  return new Map([
    [".env.example", envExample(requiredVariableNames)],
    [".github/workflows/ci.yml", CI_WORKFLOW],
    [".gitignore", GITIGNORE],
    ["README.md", readme(productName)],
    ["docker-compose.yml", DOCKER_COMPOSE],
    ["e2e/smoke.spec.ts", E2E_SMOKE],
    ["package.json", rootPackageJson(productName)],
    ["playwright.config.ts", PLAYWRIGHT_CONFIG],
    ["pnpm-workspace.yaml", PNPM_WORKSPACE],
    ["tsconfig.base.json", TSCONFIG_BASE],
  ]);
}
