/**
 * Workspace-package bytes of the controlled profile: `packages/web` (React + Vite) and
 * `packages/api` (Node HTTP).
 *
 * Same DETERMINISM RULE as the root sibling: line arrays joined with "\n" plus a trailing "\n",
 * never a multi-line template literal, and every dependency version exact.
 * THE PRODUCT NAME APPEARS IN NONE OF THESE FILES. The package names are fixed (`web`, `api`) so a
 * diff of two scaffolds differs only where the root sibling interpolates the name.
 *
 * EACH PACKAGE SHIPS AT LEAST ONE REAL ASSERTION. `pnpm test` prints "No test files found" and
 * EXITS 0 when a package has no tests, which would make the generated app's own gate vacuous: the
 * evidence that matters downstream is a `Test Files N passed` line with N >= 1, never an exit code.
 *
 * NO CREDENTIAL LITERAL: the API's default connection string carries a user and a database but no
 * password — the password reaches it only through the environment.
 */

const file = (lines: readonly string[]): string => `${lines.join("\n")}\n`;

const WEB_PACKAGE_JSON = file([
  "{",
  '  "name": "web",',
  '  "version": "0.1.0",',
  '  "private": true,',
  '  "type": "module",',
  '  "scripts": {',
  '    "dev": "vite",',
  '    "build": "vite build",',
  '    "typecheck": "tsc --noEmit --project tsconfig.json",',
  '    "test": "vitest run"',
  "  },",
  '  "dependencies": {',
  '    "react": "19.2.8",',
  '    "react-dom": "19.2.8"',
  "  },",
  '  "devDependencies": {',
  '    "@types/node": "24.13.3",',
  '    "@types/react": "19.2.18",',
  '    "@types/react-dom": "19.2.7",',
  '    "@vitejs/plugin-react": "6.1.1",',
  '    "typescript": "7.0.2",',
  '    "vite": "8.2.2",',
  '    "vitest": "4.1.10"',
  "  }",
  "}",
]);

const WEB_VITE_CONFIG = file([
  'import react from "@vitejs/plugin-react";',
  'import { defineConfig } from "vite";',
  "",
  "// vitest reads this config too, so the React transform applies to the component test as well.",
  "export default defineConfig({",
  "  plugins: [react()],",
  "  build: {",
  '    outDir: "dist",',
  "    emptyOutDir: true,",
  "  },",
  "});",
]);

const WEB_TSCONFIG = file([
  "{",
  '  "extends": "../../tsconfig.base.json",',
  '  "compilerOptions": {',
  '    "lib": ["ES2024", "DOM", "DOM.Iterable"],',
  '    "module": "Preserve",',
  '    "moduleResolution": "Bundler",',
  '    "jsx": "react-jsx",',
  '    "noEmit": true',
  "  },",
  '  "include": ["src", "vite.config.ts"]',
  "}",
]);

const WEB_INDEX_HTML = file([
  "<!doctype html>",
  '<html lang="en">',
  "  <head>",
  '    <meta charset="UTF-8" />',
  '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
  "    <title>App</title>",
  "  </head>",
  "  <body>",
  '    <div id="root"></div>',
  '    <script type="module" src="/src/main.tsx"></script>',
  "  </body>",
  "</html>",
]);

const WEB_MAIN_TSX = file([
  'import { StrictMode } from "react";',
  'import { createRoot } from "react-dom/client";',
  "",
  'import { App } from "./App";',
  "",
  'const container = document.getElementById("root");',
  "if (container === null) {",
  '  throw new Error("index.html is missing its #root mount point");',
  "}",
  "",
  "createRoot(container).render(",
  "  <StrictMode>",
  "    <App />",
  "  </StrictMode>,",
  ");",
]);

const WEB_APP_TSX = file([
  'import type { ReactElement } from "react";',
  "",
  'export const APP_HEADING = "It works";',
  "",
  "export function App(): ReactElement {",
  "  return (",
  "    <main>",
  "      <h1>{APP_HEADING}</h1>",
  "      <p>This product was bootstrapped from the controlled profile.</p>",
  "    </main>",
  "  );",
  "}",
]);

const WEB_APP_TEST_TSX = file([
  'import { renderToStaticMarkup } from "react-dom/server";',
  'import { expect, test } from "vitest";',
  "",
  'import { APP_HEADING, App } from "./App";',
  "",
  'test("the app renders its heading text", () => {',
  "  const html = renderToStaticMarkup(<App />);",
  "",
  "  expect(html).toContain(`<h1>${APP_HEADING}</h1>`);",
  '  expect(html).toContain("bootstrapped from the controlled profile");',
  "});",
]);

const API_PACKAGE_JSON = file([
  "{",
  '  "name": "api",',
  '  "version": "0.1.0",',
  '  "private": true,',
  '  "type": "module",',
  '  "scripts": {',
  '    "start": "node dist/server.js",',
  '    "build": "tsc --project tsconfig.json",',
  '    "typecheck": "tsc --noEmit --project tsconfig.json",',
  '    "test": "vitest run"',
  "  },",
  '  "devDependencies": {',
  '    "@types/node": "24.13.3",',
  '    "typescript": "7.0.2",',
  '    "vitest": "4.1.10"',
  "  }",
  "}",
]);

const API_TSCONFIG = file([
  "{",
  '  "extends": "../../tsconfig.base.json",',
  '  "compilerOptions": {',
  '    "rootDir": "src",',
  '    "outDir": "dist",',
  '    "types": ["node"]',
  "  },",
  '  "include": ["src"]',
  "}",
]);

const API_SERVER_TS = file([
  'import { createServer } from "node:http";',
  'import type { IncomingMessage, Server, ServerResponse } from "node:http";',
  'import { pathToFileURL } from "node:url";',
  "",
  "/**",
  " * The Postgres connection string. The default mirrors docker-compose.yml and .env.example and",
  " * carries NO password: the password reaches this process through the environment only.",
  " */",
  'export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://app@localhost:5432/app";',
  "",
  'export const PORT = Number(process.env.PORT ?? "3000");',
  "",
  "export interface ApiResponse {",
  "  readonly status: number;",
  "  readonly body: string;",
  "}",
  "",
  "/** Routing as a pure function, so the whole surface is testable without binding a port. */",
  "export function handle(method: string, url: string): ApiResponse {",
  '  if (method !== "GET") {',
  '    return { status: 405, body: JSON.stringify({ error: "method not allowed" }) };',
  "  }",
  '  if (url === "/health") {',
  '    return { status: 200, body: JSON.stringify({ status: "ok" }) };',
  "  }",
  '  return { status: 404, body: JSON.stringify({ error: "not found" }) };',
  "}",
  "",
  "export function createApiServer(): Server {",
  "  return createServer((request: IncomingMessage, response: ServerResponse): void => {",
  '    const handled = handle(request.method ?? "GET", request.url ?? "/");',
  '    response.writeHead(handled.status, { "content-type": "application/json" });',
  "    response.end(handled.body);",
  "  });",
  "}",
  "",
  "// Bind a port only when this module is the process entry point, never when a test imports it.",
  "const entry = process.argv[1];",
  "if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {",
  "  createApiServer().listen(PORT);",
  "}",
]);

const API_SERVER_TEST_TS = file([
  'import { expect, test } from "vitest";',
  "",
  'import { handle } from "./server.js";',
  "",
  'test("GET /health answers 200 with an ok body", () => {',
  '  const response = handle("GET", "/health");',
  "",
  "  expect(response.status).toBe(200);",
  '  expect(JSON.parse(response.body)).toEqual({ status: "ok" });',
  "});",
  "",
  'test("an unknown path answers 404", () => {',
  '  expect(handle("GET", "/nope").status).toBe(404);',
  "});",
  "",
  'test("a non-GET method answers 405", () => {',
  '  expect(handle("POST", "/health").status).toBe(405);',
  "});",
]);

// Fixed filename and bytes: the scaffold never invokes the CLI's timestamped `create` command.
const INITIAL_MIGRATION = file([
  '/** @param {import("node-pg-migrate").MigrationBuilder} pgm */',
  "export function up(pgm) {",
  '  pgm.createTable("app_metadata", {',
  '    key: { type: "text", primaryKey: true },',
  '    value: { type: "text", notNull: true },',
  "  });",
  "}",
  "",
  '/** @param {import("node-pg-migrate").MigrationBuilder} pgm */',
  "export function down(pgm) {",
  '  pgm.dropTable("app_metadata");',
  "}",
]);

/** Package entries and the initial schema, keyed by forward-slash relative path. */
export function controlledProfilePackageFiles(): ReadonlyMap<string, string> {
  return new Map([
    ["migrations/1700000000000-initial.js", INITIAL_MIGRATION],
    ["packages/api/package.json", API_PACKAGE_JSON],
    ["packages/api/src/server.test.ts", API_SERVER_TEST_TS],
    ["packages/api/src/server.ts", API_SERVER_TS],
    ["packages/api/tsconfig.json", API_TSCONFIG],
    ["packages/web/index.html", WEB_INDEX_HTML],
    ["packages/web/package.json", WEB_PACKAGE_JSON],
    ["packages/web/src/App.test.tsx", WEB_APP_TEST_TSX],
    ["packages/web/src/App.tsx", WEB_APP_TSX],
    ["packages/web/src/main.tsx", WEB_MAIN_TSX],
    ["packages/web/tsconfig.json", WEB_TSCONFIG],
    ["packages/web/vite.config.ts", WEB_VITE_CONFIG],
  ]);
}
