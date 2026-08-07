import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * One config serves the dev server, the production build, and the test run.
 *
 * A local config replaces the repository-root Vitest config outright rather than
 * merging with it, so the app owns its own environment. The root config's include
 * list covers library packages only, which is why app tests run through the
 * package script instead of the repository-wide test gate.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    passWithNoTests: false,
    sequence: {
      concurrent: false,
    },
  },
});
