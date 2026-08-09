import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["adapters/**/*.test.ts", "packages/**/*.test.ts", "tests/**/*.test.ts"],
    passWithNoTests: false,
    sequence: {
      concurrent: false,
    },
  },
});
