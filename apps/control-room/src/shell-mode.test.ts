import { describe, expect, it } from "vitest";

import { resolveLiveSetup } from "./live/live-config.js";
import type { LiveSetup, LiveSetupResult } from "./live/live-config.js";
import {
  FIXTURES_QUERY_PARAM,
  LIVE_CREDENTIAL_ENV_VARS,
  SHELL_MODES,
  resolveShellMode,
} from "./shell-mode.js";

/**
 * The composition root's ONE decision, isolated from React so every arm can be
 * asserted by value rather than by what happened to paint.
 *
 * Both refusal arms are produced by the production resolver rather than written
 * out here: the discriminator between "no credentials" and "the compat gate
 * refused" is `live-config.ts`'s own code, and a hand-written refusal object
 * would keep passing on the day production stopped minting that code.
 */

/** Credentials absent — the arm that must NEVER fall through to fixtures. */
const NO_CREDENTIALS: LiveSetupResult = resolveLiveSetup({}, null);

/** Credentials present, compat report absent: a DIFFERENT refusal, on purpose. */
const COMPAT_REFUSED: LiveSetupResult = resolveLiveSetup(
  { VITE_MOE_LIVE_CREDENTIAL: "cred", VITE_MOE_LIVE_CSRF: "csrf" },
  null,
);

/**
 * An admitted setup. Only `ok` is read by the resolver; the gate that produces a
 * real one needs the generated pins, which this package cannot import, so the
 * shape is minted here and the REFUSAL arms carry the production binding.
 */
const ADMITTED: LiveSetupResult = Object.freeze({ ok: true }) as unknown as LiveSetup;

describe("the live-config refusals this resolver discriminates on", () => {
  it("still names LIVE_CONFIG_MISSING for absent credentials", () => {
    expect(NO_CREDENTIALS.ok).toBe(false);
    expect(NO_CREDENTIALS.ok ? "" : NO_CREDENTIALS.code).toBe("LIVE_CONFIG_MISSING");
  });

  it("still names a DIFFERENT code when credentials exist but the gate refuses", () => {
    expect(COMPAT_REFUSED.ok).toBe(false);
    expect(COMPAT_REFUSED.ok ? "" : COMPAT_REFUSED.code).toBe("LIVE_COMPAT_REFUSED");
  });
});

describe("resolveShellMode", () => {
  it("names exactly three modes, so no arm can be added without an assertion", () => {
    expect([...SHELL_MODES]).toEqual(["CONFIG_NOTICE", "FIXTURES", "LIVE"]);
  });

  it("names both environment variables the notice must print", () => {
    expect([...LIVE_CREDENTIAL_ENV_VARS])
      .toEqual(["VITE_MOE_LIVE_CREDENTIAL", "VITE_MOE_LIVE_CSRF"]);
    expect(FIXTURES_QUERY_PARAM).toBe("fixtures");
  });

  it("defaults to LIVE when the build carries credentials", () => {
    expect(resolveShellMode("", ADMITTED)).toBe("LIVE");
    expect(resolveShellMode("?", ADMITTED)).toBe("LIVE");
    expect(resolveShellMode("?nothing=here", ADMITTED)).toBe("LIVE");
  });

  it("resolves FIXTURES only on an explicit ?fixtures=1, credentials or not", () => {
    expect(resolveShellMode("?fixtures=1", ADMITTED)).toBe("FIXTURES");
    expect(resolveShellMode("?fixtures=1", NO_CREDENTIALS)).toBe("FIXTURES");
    expect(resolveShellMode("?fixtures=1", COMPAT_REFUSED)).toBe("FIXTURES");
  });

  it("treats any other ?fixtures value as no fixture request at all", () => {
    // The flag is a switch, not a truthiness test: a stale `?fixtures=0` link must
    // not silently serve frozen fixtures over a credentialed build.
    for (const search of ["?fixtures=0", "?fixtures=", "?fixtures", "?fixtures=true"]) {
      expect(resolveShellMode(search, ADMITTED), search).toBe("LIVE");
    }
  });

  it("reads the FIRST fixtures parameter when a URL repeats it", () => {
    // Pinned rather than left to whatever URLSearchParams happens to do, because
    // "the first one wins" is the only reading under which a hand-edited URL means
    // what its author typed first. Both directions asserted, so a change to
    // `getAll`-style precedence cannot pass silently.
    expect(resolveShellMode("?fixtures=1&fixtures=0", ADMITTED)).toBe("FIXTURES");
    expect(resolveShellMode("?fixtures=0&fixtures=1", ADMITTED)).toBe("LIVE");
  });

  it("refuses closed with CONFIG_NOTICE when credentials are absent", () => {
    // The fail-closed clause: absent credentials may never resolve to FIXTURES.
    expect(resolveShellMode("", NO_CREDENTIALS)).toBe("CONFIG_NOTICE");
    expect(resolveShellMode("?nothing=here", NO_CREDENTIALS)).toBe("CONFIG_NOTICE");
  });

  it("keeps a compat refusal on the LIVE arm so its own code renders, not a credential notice", () => {
    // Credentials ARE configured here. Printing "set VITE_MOE_LIVE_CREDENTIAL"
    // would name the wrong cause; the live attachment prints LIVE_COMPAT_REFUSED.
    expect(resolveShellMode("", COMPAT_REFUSED)).toBe("LIVE");
  });

  it("keeps legacy ?live=1 links working, and refuses them closed without credentials", () => {
    expect(resolveShellMode("?live=1", ADMITTED)).toBe("LIVE");
    expect(resolveShellMode("?live=1", NO_CREDENTIALS)).toBe("CONFIG_NOTICE");
  });

  it("lets an explicit fixture request win over a legacy ?live=1 in the same URL", () => {
    // Both are explicit, so precedence is a decision, not a fallback: `?fixtures=1`
    // is the newer, narrower request and the only one that can be honoured with no
    // credentials at all, so honouring it never depends on the build's environment.
    expect(resolveShellMode("?live=1&fixtures=1", ADMITTED)).toBe("FIXTURES");
    expect(resolveShellMode("?fixtures=1&live=1", NO_CREDENTIALS)).toBe("FIXTURES");
  });
});
