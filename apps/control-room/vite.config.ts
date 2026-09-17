import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

import { buildDevProxy } from "./src/live/dev-proxy-paths.js";

/**
 * One config serves the dev server, the production build, and the test run.
 *
 * A local config replaces the repository-root Vitest config outright rather than
 * merging with it, so the app owns its own environment. The root config's include
 * list covers library packages only, which is why app tests run through the
 * package script instead of the repository-wide test gate.
 *
 * Live-mode support (DEVELOPMENT_ONLY):
 * - The complete project-daemon v2 handshake, command, event, document, goal,
 *   graph, and plan surface is proxied so the browser stays same-origin; the
 *   proxy restores the Origin/Host pair the daemon's listener guards expect.
 *   Target override: MOE_DAEMON_ORIGIN.
 */

const DAEMON_ORIGIN = process.env["MOE_DAEMON_ORIGIN"] ?? "http://127.0.0.1:39123";

export default defineConfig(() => ({
  plugins: [react()],
  server: {
    proxy: buildDevProxy(DAEMON_ORIGIN),
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    passWithNoTests: false,
    sequence: {
      concurrent: false,
    },
  },
}));
