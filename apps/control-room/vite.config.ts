import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * One config serves the dev server, the production build, and the test run.
 *
 * A local config replaces the repository-root Vitest config outright rather than
 * merging with it, so the app owns its own environment. The root config's include
 * list covers library packages only, which is why app tests run through the
 * package script instead of the repository-wide test gate.
 *
 * Live-mode support (DEVELOPMENT_ONLY):
 * - Command, event read/ack, affordance, and document-dossier calls are proxied so the browser
 *   stays same-origin; the proxy restores the Origin/Host pair the daemon's
 *   listener guards expect. Target override: MOE_DAEMON_ORIGIN.
 * - `__MOE_DEV_COMPAT_REPORT__` is built at config time from the generated
 *   contract pins and still validated by the real compat gate in the browser —
 *   the gate stays the only admission authority. When the pins fail to load the
 *   define is absent and live mode refuses closed.
 */

const DAEMON_ORIGIN = process.env["MOE_DAEMON_ORIGIN"] ?? "http://127.0.0.1:39123";

async function devCompatReport(): Promise<unknown> {
  try {
    const generatedUrl = new URL(
      "../../packages/control-room-client/src/generated/generated-client.js",
      import.meta.url,
    ).href;
    const generated = await import(generatedUrl) as {
      GENERATED_CONTRACT_PINS: {
        commandEnvelopeVersion: string;
        contractDigest: string;
        errorRegistryVersion: string;
        queryEnvelopeVersion: string;
      };
    };
    const pins = generated.GENERATED_CONTRACT_PINS;
    return {
      apiCompatibilityRange: {
        commandEnvelopeVersion: pins.commandEnvelopeVersion,
        errorRegistryVersion: pins.errorRegistryVersion,
        queryEnvelopeVersion: pins.queryEnvelopeVersion,
      },
      buildToolVersions: { vite: "dev" },
      contractSchemaHash: pins.contractDigest,
    };
  } catch {
    return undefined;
  }
}

export default defineConfig(async () => ({
  define: {
    __MOE_DEV_COMPAT_REPORT__: JSON.stringify(await devCompatReport()),
  },
  plugins: [react()],
  server: {
    proxy: Object.fromEntries(
      [
        "/command", "/events/read", "/events/ack", "/affordances/read", "/documents/dossier/read",
      ].map((path) => [path, {
        changeOrigin: true,
        headers: { origin: DAEMON_ORIGIN },
        target: DAEMON_ORIGIN,
      }]),
    ),
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
