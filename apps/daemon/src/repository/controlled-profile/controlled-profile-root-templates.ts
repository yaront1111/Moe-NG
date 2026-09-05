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
 */

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

const ENV_EXAMPLE = file([
  "# Copy to .env and replace every CHANGE_ME. .env is gitignored and must never be committed.",
  "# These are PLACEHOLDERS, not credentials.",
  "POSTGRES_USER=app",
  "POSTGRES_PASSWORD=CHANGE_ME",
  "POSTGRES_DB=app",
  "DATABASE_URL=postgres://app:CHANGE_ME@localhost:5432/app",
  "PORT=3000",
]);

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

/** Workspace-root entries of the profile, keyed by forward-slash relative path. */
export function controlledProfileRootFiles(productName: string): ReadonlyMap<string, string> {
  return new Map([
    [".env.example", ENV_EXAMPLE],
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
