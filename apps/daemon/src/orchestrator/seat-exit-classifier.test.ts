import { describe, expect, it } from "vitest";

import { SEAT_EXIT_ROSTER, classifySeatExit, resolveResetInstant } from "./seat-exit-classifier.js";

/**
 * FIXTURE PROVENANCE — every line below is provider bytes, never typed from memory.
 *
 * Two capture routes were used, and each fixture says which one it came from:
 *
 *  (A) LIVE CAPTURE — the command was run and its stdout/stderr copied. The codex fixture is one
 *      of these: the owner's codex quota is exhausted until 2026-09-08, so `codex exec` refuses
 *      today, on the spot, with exit 1.
 *
 *  (B) SHIPPED-BINARY TEMPLATE — the sentence was extracted from the installed provider CLI, so
 *      the WORDING (which is all a pattern matches on) is the provider's own bytes. The reset
 *      argument, which the provider renders per-account, is composed from the provider's own
 *      renderer. `capturedFrom` names the function and the constant it was read out of.
 *
 * The claude session-limit line is BOTH: it was captured verbatim off a real seat exit on
 * 2026-09-03 and its template was afterwards confirmed in the shipped binary.
 *
 * `\u00B7` is the MIDDLE DOT the claude CLI composes with (`" \xB7 resets "` in its own source).
 * It is written escaped so the fixture's bytes cannot be mangled by a console encoding.
 */
interface ProviderLineFixture {
  readonly capturedAt: string;
  readonly capturedFrom: string;
  readonly expectedResetAt: string | null;
  readonly line: string;
  readonly provider: "claude" | "codex";
  readonly rosterId: string;
}

/** The exit instant every classification arm is anchored at: 2026-09-03 21:04 Asia/Jerusalem. */
const EXIT_AT = "2026-09-03T18:04:00.000Z";

const CLAUDE_SESSION_LIMIT: ProviderLineFixture = {
  capturedAt: "2026-09-03T18:04:00.000Z",
  capturedFrom:
    "LIVE: seat #4 of the UnAI live drive exited 1 with this line at 2026-09-03 21:04 Asia/Jerusalem;"
    + " recorded verbatim the same evening in memory productize-loop-2026-09-03."
    + " Template confirmed 2026-09-04 in claude.exe 2.1.260:"
    + " `function H0(e,n,r,o){...return`You've hit your ${e}${n}${d}`}` with"
    + " `var IL={five_hour:\"session limit\",seven_day:\"weekly limit\",...}` and the suffix"
    + " `v=y?` \\xB7 resets ${y}`:\"\"`.",
  expectedResetAt: "2026-09-03T21:10:00.000Z",
  line: "You've hit your session limit \u00B7 resets 12:10am Asia/Jerusalem",
  provider: "claude",
  rosterId: "claude/session-limit",
};

const CLAUDE_USAGE_LIMIT: ProviderLineFixture = {
  capturedAt: "2026-09-04T17:35:00.000Z",
  capturedFrom:
    "BINARY: claude.exe 2.1.260 (C:/Users/Yaron/.local/bin/claude.exe), call site"
    + " `return H0(\"usage limit\",v,n,{progressSavedSuffix:v!==\"\"&&Uie()})`; reset rendered by"
    + " `function bu(t,e=!1,n=!0,r=!1)` which appends ` (${$Hn()})` where"
    + " `$Hn()=Intl.DateTimeFormat().resolvedOptions().timeZone`.",
  expectedResetAt: "2026-09-03T21:10:00.000Z",
  line: "You've hit your usage limit \u00B7 resets 12:10am (Asia/Jerusalem)",
  provider: "claude",
  rosterId: "claude/usage-limit",
};

const CLAUDE_WEEKLY_LIMIT: ProviderLineFixture = {
  capturedAt: "2026-09-04T17:35:00.000Z",
  capturedFrom:
    "BINARY: claude.exe 2.1.260, `IL.seven_day=\"weekly limit\"` fed to the same H0 template;"
    + " reset rendered by bu()'s >24h branch"
    + " `{month:\"short\",day:\"numeric\",hour:\"numeric\",minute:\"2-digit\",hour12:!0}`"
    + " with the AM/PM lowercased by `.replace(/[ \\u202f]([AP]M)/i,(l,x)=>x.toLowerCase())`.",
  expectedResetAt: "2026-09-08T07:46:00.000Z",
  line: "You've hit your weekly limit \u00B7 resets Sep 8, 10:46am (Asia/Jerusalem)",
  provider: "claude",
  rosterId: "claude/weekly-limit",
};

const CLAUDE_RATE_LIMIT: ProviderLineFixture = {
  capturedAt: "2026-09-04T17:35:00.000Z",
  capturedFrom:
    "BINARY: claude.exe 2.1.260,"
    + " `function SDo(w,x){switch(w){...case\"rate_limit\":return`Fast limit reached and temporarily"
    + " disabled \\xB7 resets in ${x}`}}`. This line carries a DURATION, not an instant.",
  expectedResetAt: null,
  line: "Fast limit reached and temporarily disabled \u00B7 resets in 5m",
  provider: "claude",
  rosterId: "claude/rate-limit",
};

const CLAUDE_RATE_LIMIT_429: ProviderLineFixture = {
  capturedAt: "2026-09-05T14:35:00.000Z",
  capturedFrom:
    "LIVE: UnAI drive, two seats exited 1 with this line (up.local.log 1147-1148) while the"
    + " account's five-hour window was exhausted; the wrapper charged both attempts.",
  expectedResetAt: null,
  line: "API Error: Request rejected (429) \u00B7 This request would exceed your account's rate"
    + " limit. Please try again later.",
  provider: "claude",
  rosterId: "claude/rate-limit-429",
};
const CODEX_USAGE_LIMIT: ProviderLineFixture = {
  capturedAt: "2026-09-04T17:36:55.000Z",
  capturedFrom:
    "LIVE: `codex exec --skip-git-repo-check \"say hi\"` run 2026-09-04T17:36:55Z with codex-cli"
    + " 0.152.0; exited 1 and printed this on stderr (twice). Sentence confirmed in the shipped"
    + " codex.exe: `You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to"
    + " purchase more credits` + ` or try again at <slot>.`.",
  // Codex prints the reset in the HOST's local wall clock with no zone. Reading it as UTC can only
  // move the instant LATER for a zone east of UTC, i.e. it pauses longer, never shorter.
  expectedResetAt: "2026-09-08T10:46:00.000Z",
  line:
    "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase"
    + " more credits or try again at Sep 8th, 2026 10:46 AM.",
  provider: "codex",
  rosterId: "codex/usage-limit",
};

const FIXTURES: readonly ProviderLineFixture[] = Object.freeze([
  CLAUDE_SESSION_LIMIT, CLAUDE_USAGE_LIMIT, CLAUDE_WEEKLY_LIMIT, CLAUDE_RATE_LIMIT,
  CLAUDE_RATE_LIMIT_429, CODEX_USAGE_LIMIT,
]);

/** Ordinary seat noise the classifier must NEVER read as a provider limit. */
const STACK_TRACE_TAIL = Object.freeze([
  "file:///D:/projexts/moe-next/apps/daemon/src/orchestrator/agent-wrapper.ts:88",
  "    throw new AgentProcessFailureError(\"SPAWN_FAILED\", null, null);",
  "          ^",
  "TypeError: Cannot read properties of undefined (reading 'length')",
  "    at claimNextTask (agent-wrapper.ts:88:11)",
  "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
]);

const ENOENT_TAIL = Object.freeze([
  "node:internal/errors:496",
  "Error: spawn claude ENOENT",
  "    at ChildProcess._handle.onexit (node:internal/child_process:286:19)",
  "  errno: -4058,",
  "  code: 'ENOENT',",
  "  syscall: 'spawn claude'",
]);

function noisy(line: string): readonly string[] {
  return ["[wrapper] item-7 agent starting", "", "  ...seat output...", line];
}

describe("classifySeatExit", () => {
  it.each(FIXTURES.map((fixture) => [fixture.rosterId, fixture] as const))(
    "classifies the %s fixture as PROVIDER_LIMIT with its parsed reset",
    (_id, fixture) => {
      expect(classifySeatExit({
        exitAt: EXIT_AT, exitCode: 1, provider: fixture.provider, signal: null,
        tail: noisy(fixture.line),
      })).toEqual({
        kind: "PROVIDER_LIMIT",
        lastLine: fixture.line,
        matched: fixture.rosterId,
        resetAt: fixture.expectedResetAt,
      });
    },
  );

  it("reads an ordinary stack trace, an ENOENT and an empty tail as FAILED, never as a limit", () => {
    for (const tail of [STACK_TRACE_TAIL, ENOENT_TAIL]) {
      const result = classifySeatExit({
        exitAt: EXIT_AT, exitCode: 1, provider: "claude", signal: null, tail,
      });
      expect(result.kind).toBe("FAILED");
      expect(result.matched).toBeNull();
      expect(result.resetAt).toBeNull();
      expect(result.lastLine).toBe(tail[tail.length - 1]);
    }
    expect(classifySeatExit({
      exitAt: EXIT_AT, exitCode: 1, provider: "claude", signal: null, tail: [],
    })).toEqual({ kind: "FAILED", lastLine: null, matched: null, resetAt: null });
    // A signal kill with no output is a failure, not a limit.
    expect(classifySeatExit({
      exitAt: EXIT_AT, exitCode: null, provider: "claude", signal: "SIGKILL", tail: ["", "   "],
    })).toEqual({ kind: "FAILED", lastLine: null, matched: null, resetAt: null });
  });

  it("lets exit 0 win even when the tail carries a roster line", () => {
    expect(classifySeatExit({
      exitAt: EXIT_AT, exitCode: 0, provider: "claude", signal: null,
      tail: noisy(CLAUDE_SESSION_LIMIT.line),
    })).toEqual({
      kind: "COMPLETED", lastLine: CLAUDE_SESSION_LIMIT.line, matched: null, resetAt: null,
    });
  });

  it("scans only the last 40 lines of the tail", () => {
    const buried = [CLAUDE_SESSION_LIMIT.line, ...Array.from({ length: 40 }, (_v, i) => `line ${i}`)];
    expect(classifySeatExit({
      exitAt: EXIT_AT, exitCode: 1, provider: "claude", signal: null, tail: buried,
    }).kind).toBe("FAILED");
  });

  it("does not fire on a provider sentence a seat merely QUOTED, when it is punctuated", () => {
    // A seat that prints an error payload naming the limit must not park the provider. The
    // period-anchored lookahead is what keeps codex's own sentence out of the claude entries, and
    // it does the same job for a quoted one.
    const quoted = "{\"error\":\"You've hit your usage limit. See docs.\",\"code\":\"E_LIMIT\"}";
    expect(classifySeatExit({
      exitAt: EXIT_AT, exitCode: 1, provider: "claude", signal: null, tail: [quoted],
    }).kind).toBe("FAILED");
    expect(classifySeatExit({
      exitAt: EXIT_AT, exitCode: 1, provider: "claude", signal: null,
      tail: ["  \"detail\": \"rate limit exceeded\","],
    }).kind).toBe("FAILED");
  });

  it("ACCEPTED RISK, pinned: an unpunctuated quote of the sentence does classify as a limit", () => {
    // This is the residual false positive the roster cannot distinguish without the provider
    // changing its wording — the bytes are identical to a real refusal. It is bounded downstream:
    // the pause carries the reset the line itself named, and a line naming none pauses on nothing.
    // Pinned as an ARM rather than left as prose so a future widening cannot happen unnoticed.
    const echoed = "{\"lastAssistantMessage\":\"You've hit your session limit\"}";
    expect(classifySeatExit({
      exitAt: EXIT_AT, exitCode: 1, provider: "claude", signal: null, tail: [echoed],
    })).toEqual({
      kind: "PROVIDER_LIMIT", lastLine: echoed, matched: "claude/session-limit", resetAt: null,
    });
  });

  it("never matches a roster entry belonging to the other provider", () => {
    expect(classifySeatExit({
      exitAt: EXIT_AT, exitCode: 1, provider: "codex", signal: null,
      tail: noisy(CLAUDE_SESSION_LIMIT.line),
    }).kind).toBe("FAILED");
  });
});

describe("SEAT_EXIT_ROSTER", () => {
  it("is frozen and carries a capture source and a sample on every entry", () => {
    expect(Object.isFrozen(SEAT_EXIT_ROSTER)).toBe(true);
    expect(SEAT_EXIT_ROSTER.length).toBeGreaterThan(0);
    for (const entry of SEAT_EXIT_ROSTER) {
      expect(entry.capturedFrom.length).toBeGreaterThan(20);
      expect(entry.sample.length).toBeGreaterThan(0);
      // A bare /limit/ would fire on any seat that says the word. Patterns carry a provider sentence.
      expect(entry.pattern.source.length).toBeGreaterThan(12);
    }
  });

  it("matches every entry with its own sample, and each sample with exactly one entry", () => {
    for (const entry of SEAT_EXIT_ROSTER) {
      const result = classifySeatExit({
        exitAt: EXIT_AT, exitCode: 1, provider: entry.provider, signal: null, tail: [entry.sample],
      });
      expect(result.kind).toBe("PROVIDER_LIMIT");
      expect(result.matched).toBe(entry.id);
      const hits = SEAT_EXIT_ROSTER.filter((other) => other.pattern.test(entry.sample));
      expect(hits.map((hit) => hit.id)).toEqual([entry.id]);
    }
  });

  it("is reached exactly by the fixture set — no unfixtured entry, no unrostered fixture", () => {
    const reached = new Set(FIXTURES.map((fixture) => {
      const result = classifySeatExit({
        exitAt: EXIT_AT, exitCode: 1, provider: fixture.provider, signal: null, tail: [fixture.line],
      });
      return result.matched;
    }));
    const rostered = new Set(SEAT_EXIT_ROSTER.map((entry) => entry.id));
    expect([...reached].sort()).toEqual([...rostered].sort());
    expect(reached.size).toBe(FIXTURES.length);
  });
});

describe("resolveResetInstant", () => {
  it("resolves a claude wall clock to the NEXT occurrence in its named zone", () => {
    // 2026-09-03 is IDT (UTC+3): 12:10am on the exit's local date is already past, so it rolls over.
    expect(resolveResetInstant("12:10am Asia/Jerusalem", EXIT_AT)).toBe("2026-09-03T21:10:00.000Z");
    expect(resolveResetInstant("12:10am (Asia/Jerusalem)", EXIT_AT)).toBe("2026-09-03T21:10:00.000Z");
  });

  it("rolls to the following day when the exit is already past that wall clock", () => {
    expect(resolveResetInstant("12:10am Asia/Jerusalem", "2026-09-03T21:30:00.000Z"))
      .toBe("2026-09-04T21:10:00.000Z");
  });

  it("resolves a dated claude reset without rolling it forward", () => {
    expect(resolveResetInstant("Sep 8, 10:46am (Asia/Jerusalem)", EXIT_AT))
      .toBe("2026-09-08T07:46:00.000Z");
  });

  it("resolves the codex dated form in UTC", () => {
    expect(resolveResetInstant("try again at Sep 8th, 2026 10:46 AM.", EXIT_AT))
      .toBe("2026-09-08T10:46:00.000Z");
  });

  it("resolves a date-only instant to midnight UTC", () => {
    expect(resolveResetInstant("exhausted until 2026-09-08", EXIT_AT)).toBe("2026-09-08T00:00:00.000Z");
  });

  it("returns null for an unknown zone, a duration, or garbage", () => {
    expect(resolveResetInstant("12:10am Not_A/Zone", EXIT_AT)).toBeNull();
    expect(resolveResetInstant("resets in 5m", EXIT_AT)).toBeNull();
    expect(resolveResetInstant("", EXIT_AT)).toBeNull();
    expect(resolveResetInstant("12:10am Asia/Jerusalem", "not-an-instant")).toBeNull();
  });

  it("resolves the AMBIGUOUS hour on a DST end day to its later, standard-time occurrence", () => {
    // Asia/Jerusalem leaves IDT at 02:00 on 2026-10-25, so 01:30 that morning happens TWICE:
    // once at 22:30Z (GMT+3) and again at 23:30Z (GMT+2) — both confirmed with Intl directly.
    // The two-pass conversion lands on the LATER one, which pauses longer rather than shorter.
    expect(resolveResetInstant("1:30am Asia/Jerusalem", "2026-10-24T20:00:00.000Z"))
      .toBe("2026-10-24T23:30:00.000Z");
    // And an hour that is NOT ambiguous on that same day still converts at its own offset.
    expect(resolveResetInstant("11:00pm Asia/Jerusalem", "2026-10-25T10:00:00.000Z"))
      .toBe("2026-10-25T21:00:00.000Z");
  });

  it("still validates a zone when Intl.supportedValuesOf is missing", () => {
    const intl = Intl as { supportedValuesOf?: unknown };
    const saved = intl.supportedValuesOf;
    try {
      // An engine without the method must fall back to a DateTimeFormat probe, not crash and not
      // start admitting junk zones.
      delete intl.supportedValuesOf;
      expect(resolveResetInstant("12:10am Asia/Jerusalem", EXIT_AT)).toBe("2026-09-03T21:10:00.000Z");
      expect(resolveResetInstant("12:10am Not_A/Zone", EXIT_AT)).toBeNull();
    } finally {
      intl.supportedValuesOf = saved;
    }
    expect((Intl as { supportedValuesOf?: unknown }).supportedValuesOf).toBe(saved);
  });

  it("keeps kind PROVIDER_LIMIT when the instant is unparseable", () => {
    expect(classifySeatExit({
      exitAt: EXIT_AT, exitCode: 1, provider: "claude", signal: null,
      tail: ["You've hit your session limit \u00B7 resets 12:10am Not_A/Zone"],
    })).toEqual({
      kind: "PROVIDER_LIMIT",
      lastLine: "You've hit your session limit \u00B7 resets 12:10am Not_A/Zone",
      matched: "claude/session-limit",
      resetAt: null,
    });
  });
});
