import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { agentEnvironment } from "../orchestrator/agent-spawn-environment.js";
import { createVerifierProcessRunner } from "../orchestrator/verifier-process-runner.js";
import { startPreviewProcess } from "../preview/preview-process.js";
import { deliverEnvironment, readEnvironmentDelivery } from "./environment-delivery.js";
import type { EnvironmentDeliveryResult } from "./environment-delivery.js";
import { setEnvironmentVariable, unsetEnvironmentVariable } from "./environment-store.js";
import type { EnvironmentStoreConfig } from "./environment-store.js";
import { CREDENTIAL, cleanUp, configFor, openMemoryStore } from "./environment-test-fixtures.js";

/**
 * THE DELIVERY PATH: values reach the child, and reach nothing else.
 *
 * THE CANARY IS ONE TEST WITH TWO ARMS because the arms pull against each other. "The child saw
 * it" alone is satisfied by a delivery that also prints the secret; "it is nowhere in the log"
 * alone is satisfied by a delivery that never happened. Split into two tests, either half can rot
 * green while the other fails. Together they are the property.
 *
 * THE CHILD REPORTS A DIGEST, NOT THE VALUE. Only a child that received the exact bytes can print
 * `sha256(value)`, so it is still read from THE CHILD'S OWN OUTPUT and still proves receipt - but
 * the raw secret is then absent from EVERY captured byte, which lets the leak arm assert the
 * strictly stronger claim (nowhere in the log AND nowhere in the run capture) instead of having to
 * carve out the child's own echo. Printing the secret to prove it arrived would also put it on a
 * screen and in a CI transcript, which is the thing this epic's third rail forbids.
 */

const PROD = "production";
const SRC = dirname(fileURLToPath(import.meta.url));

/**
 * WHY `DEPLOY_CANARY_TOKEN` AND NOT `MOE_CANARY_*`. `agent-spawn-environment.ts:54` drops every
 * key whose name starts with `MOE_`, so a `MOE_CANARY_*` name would be scrubbed by the very
 * construction under test: the "child saw it" arm would fail and the "not in the log" arm would
 * pass for the wrong reason - the value never left the parent. This name is in NO roster and
 * matches NO provider prefix either, so it can ONLY arrive by the delivery overlay and never by
 * the filter, which is what keeps the arm from passing on an accident. It also satisfies the
 * store's own `ENVIRONMENT_VARIABLE_NAME_PATTERN` (`/^[A-Z][A-Z0-9_]*$/u`).
 */
const CANARY_NAME = "DEPLOY_CANARY_TOKEN";

/** A host variable in NO allowlist. The exclusion arm's subject: it must never reach a child. */
const HOST_ONLY = "HOST_ONLY_SECRET";

const temporaryDirectories: string[] = [];

afterEach(() => {
  cleanUp();
  vi.restoreAllMocks();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory === undefined) continue;
    try {
      rmSync(directory, { force: true, recursive: true });
    } catch { /* a held handle on Windows must not mask a test failure */ }
  }
});

function temporaryWorkspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "moe-delivery-"));
  temporaryDirectories.push(directory);
  return directory;
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

function seed(config: EnvironmentStoreConfig, name: string, value: string): void {
  const written = setEnvironmentVariable(config, { environment: PROD, name, value });
  // A silently refused seed would make every later assertion vacuous.
  expect(written).toMatchObject({ ok: true });
}

function deliveredBy(result: EnvironmentDeliveryResult): Readonly<Record<string, string>> {
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error("unreachable: asserted ok above");
  return result.variables;
}

describe("readEnvironmentDelivery", () => {
  it("returns the plaintext of every CURRENT variable and nothing that was unset", () => {
    const config = configFor(openMemoryStore());
    seed(config, "DATABASE_URL", "postgres://app:s3cr3t@localhost:5432/app");
    seed(config, "STRIPE_KEY", "sk_live_example");
    seed(config, "RETIRED_TOKEN", "no-longer-wanted");
    expect(unsetEnvironmentVariable(config, { environment: PROD, name: "RETIRED_TOKEN" }))
      .toMatchObject({ ok: true });

    expect(deliveredBy(readEnvironmentDelivery(config, PROD))).toEqual({
      DATABASE_URL: "postgres://app:s3cr3t@localhost:5432/app",
      STRIPE_KEY: "sk_live_example",
    });
  });

  it("round-trips a value carrying a newline, a quote and multi-byte code points", () => {
    const config = configFor(openMemoryStore());
    const awkward = "line-one\nline\"two\té\u{1f512}  trailing  ";
    seed(config, "AWKWARD_VALUE", awkward);
    expect(deliveredBy(readEnvironmentDelivery(config, PROD))["AWKWARD_VALUE"]).toBe(awkward);
  });

  it("delivers nothing, and refuses nothing, for an environment with no variables set", () => {
    const result = readEnvironmentDelivery(configFor(openMemoryStore()), PROD);
    expect(deliveredBy(result)).toEqual({});
  });

  it("refuses an unknown environment at the SCOPE layer before touching the key", () => {
    const config = configFor(openMemoryStore(), null);
    // The credential is ALSO unavailable here. Asserting the code AND the layer is what proves
    // SCOPE answered first, rather than the arm passing on whichever refusal happened to win.
    expect(readEnvironmentDelivery(config, "staging")).toMatchObject({
      code: "ENV_ENVIRONMENT_UNKNOWN", layer: "SCOPE", ok: false,
    });
  });

  it("refuses at the KEY layer when the daemon credential is unavailable", () => {
    const config = configFor(openMemoryStore());
    seed(config, "DATABASE_URL", "postgres://app:s3cr3t@localhost:5432/app");
    expect(readEnvironmentDelivery(configFor(config.store, null), PROD)).toMatchObject({
      code: "ENV_STORE_KEY_UNAVAILABLE", layer: "KEY", ok: false,
    });
  });

  it("refuses the WHOLE delivery, releasing no variable at all, when one seal will not open", () => {
    const config = configFor(openMemoryStore());
    seed(config, "FIRST_VALUE", "first-plaintext");
    seed(config, "SECOND_VALUE", "second-plaintext");

    // The tamper lands AFTER `admitEnvironment` has proved the state openable, so the refusal
    // under test is this module's own in-loop branch and not the preamble answering first. That
    // distinction is the point: with the corruption present from the start, `admitEnvironment`
    // refuses and this branch is never reached, so the arm would assert a different layer's work.
    let reads = 0;
    const corruptAfterAdmission: EnvironmentStoreConfig = {
      ...config,
      store: {
        ...config.store,
        readEvents: (aggregateId: string): readonly StoredEvent[] => {
          const events = config.store.readEvents(aggregateId);
          reads += 1;
          if (reads < 2) return events;
          return events.map((event, index) => (index === 0
            ? { ...event, payload: corruptSealOf(event.payload) }
            : event));
        },
      } as unknown as SqliteEventStore,
    };

    const refused = readEnvironmentDelivery(corruptAfterAdmission, PROD);
    expect(reads).toBeGreaterThanOrEqual(2); // the corruption was actually served
    expect(refused).toMatchObject({ code: "ENV_STORE_KEY_UNAVAILABLE", layer: "KEY", ok: false });
    // The load-bearing half: NO partial map escaped alongside the refusal.
    expect("variables" in refused).toBe(false);
    expect(JSON.stringify(refused)).not.toContain("second-plaintext");
  });

  it("refuses when the seal is corrupt from the start, at the same code and layer", () => {
    const config = configFor(openMemoryStore());
    seed(config, "FIRST_VALUE", "first-plaintext");
    const corrupted: EnvironmentStoreConfig = {
      ...config,
      store: {
        ...config.store,
        readEvents: (aggregateId: string): readonly StoredEvent[] =>
          config.store.readEvents(aggregateId)
            .map((event) => ({ ...event, payload: corruptSealOf(event.payload) })),
      } as unknown as SqliteEventStore,
    };
    // `admitEnvironment` answers this one; recorded so a reader knows the two arms above and here
    // exercise DIFFERENT surfaces that agree on the answer.
    expect(readEnvironmentDelivery(corrupted, PROD)).toMatchObject({
      code: "ENV_STORE_KEY_UNAVAILABLE", layer: "KEY", ok: false,
    });
  });

  it("refuses at the NAME layer for a stored name the write grammar would never have admitted", () => {
    const config = configFor(openMemoryStore());
    seed(config, "GOOD_VALUE", "good-plaintext");
    // `environment-fold.ts` reads `name` straight off the payload and does NOT re-check it, so a
    // forged record can carry any string. `__proto__` is the one that matters: assigning it on a
    // plain object sets the PROTOTYPE rather than creating a key, so without this guard the
    // variable would vanish from `Object.keys` and the child would silently not receive it.
    const forged: EnvironmentStoreConfig = {
      ...config,
      store: {
        ...config.store,
        readEvents: (aggregateId: string): readonly StoredEvent[] =>
          config.store.readEvents(aggregateId).map((event) => ({
            ...event, payload: renamedTo(event.payload, "__proto__"),
          })),
      } as unknown as SqliteEventStore,
    };
    const refused = readEnvironmentDelivery(forged, PROD);
    // Code AND layer: NAME, not the KEY-layer answer a merely-unopenable record would give.
    expect(refused).toMatchObject({ code: "ENV_NAME_INVALID", layer: "NAME", ok: false });
    expect("variables" in refused).toBe(false);
  });

  it("cannot be opened by a DIFFERENT daemon credential", () => {
    const config = configFor(openMemoryStore());
    seed(config, "DATABASE_URL", "postgres://app:s3cr3t@localhost:5432/app");
    const stolen = readEnvironmentDelivery(configFor(config.store, `${CREDENTIAL}-wrong`), PROD);
    expect(stolen).toMatchObject({ code: "ENV_STORE_KEY_UNAVAILABLE", layer: "KEY", ok: false });
    expect(JSON.stringify(stolen)).not.toContain("s3cr3t");
  });
});

/** Rewrites an event payload's `name`, so a record the write grammar forbids can be served. */
function renamedTo(payload: Uint8Array, name: string): Uint8Array {
  const record = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
  return new TextEncoder().encode(JSON.stringify({ ...record, name }));
}

/** Flips one ciphertext byte of an event payload's sealed blob, leaving the framing intact. */
function corruptSealOf(payload: Uint8Array): Uint8Array {
  const record = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
  const sealed = Buffer.from(String(record["sealed"]), "base64");
  const last = sealed.byteLength - 1;
  expect(sealed.byteLength).toBeGreaterThan(45); // header is 45 bytes; there IS ciphertext to flip
  sealed[last] = (sealed[last] ?? 0) ^ 0xff;
  return new TextEncoder().encode(JSON.stringify({
    ...record, sealed: sealed.toString("base64"),
  }));
}

describe("deliverEnvironment", () => {
  it("returns the allowlisted object ITSELF when there is nothing to deliver", () => {
    const allowlisted: NodeJS.ProcessEnv = { LANG: "C.UTF-8", PATH: "/safe/bin" };
    // Byte-identity by construction: same reference, so there is no copy that could reorder keys
    // or add an undefined-valued slot. Asserted for BOTH shapes a caller can produce.
    expect(deliverEnvironment(allowlisted, undefined).environment).toBe(allowlisted);
    expect(deliverEnvironment(allowlisted, {}).environment).toBe(allowlisted);
    expect(deliverEnvironment(allowlisted, {}).collisions).toEqual([]);
  });

  it("overlays onto the filter's RESULT, so an arbitrary operator name arrives", () => {
    const merged = deliverEnvironment({ PATH: "/safe/bin" }, { DATABASE_URL: "postgres://x" });
    expect(merged.environment).toEqual({ DATABASE_URL: "postgres://x", PATH: "/safe/bin" });
    expect(merged.collisions).toEqual([]);
  });

  it("keeps the allowlisted runtime value on a collision and names the variable it dropped", () => {
    const allowlisted: NodeJS.ProcessEnv = { PATH: "/safe/bin", TMPDIR: "" };
    const merged = deliverEnvironment(allowlisted, {
      // A delivered PATH would choose which `node` and which shell the daemon's own verifier
      // spawns. TMPDIR is present but EMPTY: the `in` check, not truthiness, is what stops an
      // operator value displacing it by the quieter route.
      DATABASE_URL: "postgres://x", PATH: "/attacker/bin", TMPDIR: "/attacker/tmp",
    });
    expect(merged.environment["PATH"]).toBe("/safe/bin");
    expect(merged.environment["TMPDIR"]).toBe("");
    expect(merged.environment["DATABASE_URL"]).toBe("postgres://x");
    expect([...merged.collisions].sort()).toEqual(["PATH", "TMPDIR"]);
    expect(allowlisted).toEqual({ PATH: "/safe/bin", TMPDIR: "" }); // input never mutated
  });
});

describe("agentEnvironment delivery", () => {
  const host: NodeJS.ProcessEnv = {
    [HOST_ONLY]: "host-secret-never-delivered",
    LANG: "C.UTF-8",
    MOE_DAEMON_CREDENTIAL: "operator-secret",
    PATH: "/safe/bin",
  };

  it("delivers the operator variable AND still excludes a host variable outside the allowlist", () => {
    const environment = agentEnvironment(host, { DATABASE_URL: "postgres://x" });
    // The pair, on the SAME constructed object. The exclusion half is the load-bearing one:
    // without it, a passing test is equally compatible with having handed the child `process.env`
    // plus extras, which is exactly the widened surface the closed roster exists to prevent.
    expect(environment["DATABASE_URL"]).toBe("postgres://x");
    expect(environment[HOST_ONLY]).toBeUndefined();
    expect(environment["MOE_DAEMON_CREDENTIAL"]).toBeUndefined();
    expect(Object.keys(environment)).not.toContain(HOST_ONLY);
  });

  it("delivers a MOE_-prefixed operator variable that the SOURCE scrub would have dropped", () => {
    // Proof the overlay lands after the filter rather than inside it: the scrub at :54 removes
    // MOE_ keys from the SOURCE, and a delivered name is not a source key at all.
    expect(agentEnvironment(host, { MOE_OPERATOR_SET: "delivered" })["MOE_OPERATOR_SET"])
      .toBe("delivered");
    expect(agentEnvironment(host)["MOE_DAEMON_CREDENTIAL"]).toBeUndefined();
  });

  it("builds a byte-identical environment when nothing is delivered", () => {
    // The ABSOLUTE roster this construction produced before delivery existed, in order. Compared
    // against a literal rather than against `agentEnvironment(host)` because a self-comparison is
    // satisfied by any overlay that is merely consistent - and asserted as KEYS as well as by
    // `toStrictEqual`, because `toEqual`/`JSON.stringify` both ignore undefined-valued properties,
    // so an overlay adding `SOMETHING: undefined` slips past either one alone.
    const expected = [
      "LANG", "PATH", "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "CLAUDE_CODE_SKIP_PROMPT_HISTORY",
      "MAX_MCP_OUTPUT_TOKENS", "NO_PROXY", "no_proxy",
    ];
    for (const delivered of [undefined, {}]) {
      const after = agentEnvironment(host, delivered);
      expect(Object.keys(after)).toEqual(expected);
      expect(after).toStrictEqual(agentEnvironment(host));
    }
  });
});

describe("a hostile delivered value", () => {
  it("passes shell metacharacters to the child INERT, because shell:true interpolates the command", async () => {
    const workspace = temporaryWorkspace();
    writeFileSync(join(workspace, "probe.mjs"),
      'process.stdout.write(`X=${JSON.stringify(process.env["INJECTED_VALUE"])}\\n`);'
      + '\nprocess.stdout.write(`EXTRA=${process.env["MOE_EXTRA"] ?? "ABSENT"}\\n`);', "utf8");
    // A value carrying a command separator, a variable reference and a CRLF pair. `shell: true`
    // interpolates the COMMAND STRING, never the environment block, so none of this is evaluated
    // and no second variable is injected by the embedded newline.
    const hostile = "; echo PWNED & whoami\r\nMOE_EXTRA=injected";
    const runner = createVerifierProcessRunner({
      delivered: { INJECTED_VALUE: hostile },
      environment: {
        COMSPEC: process.env["COMSPEC"] ?? "", PATH: process.env["PATH"] ?? "",
        PATHEXT: process.env["PATHEXT"] ?? "", SYSTEMROOT: process.env["SYSTEMROOT"] ?? "",
      },
      timeoutMs: 60_000,
    });
    try {
      const run = await runner({
        instructions: "read it", test: "node probe.mjs", title: "hostile value", workspace,
      });
      expect(run.exitCode).toBe(0);
      expect(run.output).toContain(`X=${JSON.stringify(hostile)}`); // byte-for-byte, unevaluated
      expect(run.output).toContain("EXTRA=ABSENT"); // the newline injected no second variable
      // Had the shell evaluated it, `echo PWNED` would have written PWNED on a line of its own.
      // Testing for the bare substring would be vacuous: the child ECHOES the value, which
      // contains that word - the discriminator is a standalone line, not a match anywhere.
      expect(run.output.split(/\r?\n/u).map((line) => line.trim())).not.toContain("PWNED");
    } finally {
      await runner.close();
    }
  }, 90_000);

  it("fails the spawn CLOSED, with the value in no output, when it carries a NUL byte", async () => {
    // `isEnvironmentValueWithinBound` bounds a value's SIZE and not its bytes, so a NUL is
    // storable - and node's `spawn` rejects it with ERR_INVALID_ARG_VALUE. Both spawn sites
    // already wrap `spawn` in try/catch, so it lands as a failed capture rather than a crash.
    // Recorded as a finding for the store's value grammar; asserted here as fail-closed.
    const secret = `nul-canary-${randomBytes(12).toString("hex")}`;
    const runner = createVerifierProcessRunner({
      delivered: { NUL_BEARING_VALUE: `${secret}${String.fromCharCode(0)}tail` },
      environment: { PATH: process.env["PATH"] ?? "" },
      timeoutMs: 60_000,
    });
    try {
      const run = await runner({
        instructions: "never starts", test: "node --version", title: "nul value",
        workspace: temporaryWorkspace(),
      });
      expect(run).toMatchObject({ byteCount: 0, exitCode: null, output: "" });
      expect(run.output).not.toContain(secret); // the value reached no failure-path output
    } finally {
      await runner.close();
    }
  }, 90_000);
});

describe("preview spawn delivery", () => {
  /**
   * The preview process is the THIRD allowlist construction in this repo - `preview-process.ts:87`
   * holds a private `runtimeEnvironment` that is a verbatim copy of the verifier runner's. DoD-1
   * names the preview spawn, so it is wired and asserted here rather than assumed covered by the
   * verifier's arm; the two functions are separate code and have drifted apart before.
   */
  const previewEnvironment = async (
    delivered: Readonly<Record<string, string>> | undefined,
  ): Promise<NodeJS.ProcessEnv | undefined> => {
    let seen: NodeJS.ProcessEnv | undefined;
    const child = Object.assign(new EventEmitter(), {
      kill: () => true, pid: 4321, stderr: new PassThrough(), stdin: null,
      stdout: new PassThrough(), unref: () => undefined,
    }) as unknown as ChildProcess;
    const result = await startPreviewProcess(
      { command: "npm run dev", port: null, workspace: temporaryWorkspace() },
      {
        delivered,
        environment: {
          [HOST_ONLY]: "host-secret-never-delivered", LANG: "C.UTF-8", TMPDIR: "/safe/tmp",
        },
        // Never reaches a real process: the fake child has no OS row, so `stop()` signals nothing.
        killGraceMs: 1, killProcessGroup: () => undefined, platform: "linux",
        spawn: (_file, _args, options) => { seen = options.env; return child; },
        startTimeoutMs: 0,
      },
    );
    // It refuses (nothing ever listens), which is the cheapest way to reach the spawn and stop
    // again without leaving a server holding a port - this epic stops what it starts.
    expect(result).toMatchObject({ code: "PREVIEW_START_TIMEOUT", ok: false });
    return seen;
  };

  it("delivers the operator variable AND still excludes a host variable outside the allowlist", async () => {
    expect(await previewEnvironment({ DATABASE_URL: "postgres://delivered" })).toEqual({
      DATABASE_URL: "postgres://delivered", LANG: "C.UTF-8", TMPDIR: "/safe/tmp",
    });
  });

  it("builds a byte-identical environment when the project has no variables set", async () => {
    // An ABSOLUTE literal and an explicit key roster, for the reason recorded on the verifier's
    // twin of this arm: `toEqual` and `JSON.stringify` both ignore undefined-valued properties.
    for (const delivered of [undefined, {}]) {
      const environment = await previewEnvironment(delivered);
      expect(environment).toStrictEqual({ LANG: "C.UTF-8", TMPDIR: "/safe/tmp" });
      expect(Object.keys(environment ?? {})).toEqual(["LANG", "TMPDIR"]);
    }
  });
});

describe("the environment store still returns no plaintext", () => {
  it("exports no value-returning function and never opens a seal", () => {
    const source = readFileSync(join(SRC, "environment-store.ts"), "utf8");
    // The header sentence another suite and this row both rely on, pinned verbatim.
    expect(source).toContain(
      "NO PLAINTEXT-RETURNING FUNCTION IS EXPORTED FROM THIS MODULE.",
    );
    // It cannot return plaintext because it never obtains any: the only way to recover a value is
    // `openEnvironmentValue`, and the store neither imports nor calls it.
    expect(source).not.toContain("openEnvironmentValue");
    expect(source).not.toContain("readEnvironmentDelivery");
    // An EXACT export roster, so a fourth value-shaped function cannot be added quietly.
    expect([...source.matchAll(/^export function (\w+)/gmu)].map((match) => match[1]))
      .toEqual(["setEnvironmentVariable", "unsetEnvironmentVariable", "readEnvironmentVariables"]);
    // And the read that DOES return plaintext lives in this row's own module instead.
    expect(readFileSync(join(SRC, "environment-delivery.ts"), "utf8"))
      .toContain("export function readEnvironmentDelivery");
  });
});

describe("the delivery canary", () => {
  it("reaches the spawned child and appears in no log or capture byte", async () => {
    const secret = `canary-${randomBytes(24).toString("hex")}`;
    const workspace = temporaryWorkspace();
    writeFileSync(join(workspace, "probe.mjs"), [
      'import { createHash } from "node:crypto";',
      `const seen = process.env[${JSON.stringify(CANARY_NAME)}];`,
      'const digest = seen === undefined',
      '  ? "ABSENT"',
      '  : createHash("sha256").update(seen, "utf8").digest("hex");',
      `const host = process.env[${JSON.stringify(HOST_ONLY)}] ?? "ABSENT";`,
      'process.stdout.write(`CANARY_DIGEST=${digest}\\nHOST_SEEN=${host}\\n`);',
    ].join("\n"), "utf8");

    // Every byte the wrapper log would emit. `agent-wrapper-main.ts` wires its `log` sinks to
    // `process.stdout.write` / `process.stderr.write` (:136, :162, :235, :289), so spying on the
    // two streams IS reading the wrapper log's bytes rather than a stand-in for them.
    const logged: string[] = [];
    const capture = (chunk: unknown): boolean => {
      logged.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(capture as never);
    vi.spyOn(process.stderr, "write").mockImplementation(capture as never);

    const runner = createVerifierProcessRunner({
      delivered: { [CANARY_NAME]: secret },
      environment: {
        [HOST_ONLY]: "host-secret-never-delivered",
        COMSPEC: process.env["COMSPEC"] ?? "",
        PATH: process.env["PATH"] ?? "",
        PATHEXT: process.env["PATHEXT"] ?? "",
        SYSTEMROOT: process.env["SYSTEMROOT"] ?? "",
      },
      timeoutMs: 60_000,
    });
    let capturedOutput: string;
    let exitCode: number | null;
    try {
      const run = await runner({
        instructions: "read the delivered canary", test: "node probe.mjs",
        title: "delivery canary", workspace,
      });
      capturedOutput = run.output;
      exitCode = run.exitCode;
    } finally {
      // This epic stops what it starts, on the failure path too.
      await runner.close();
    }
    vi.restoreAllMocks();

    expect(exitCode).toBe(0);
    // (a) THE CHILD SAW IT, read from the child's OWN output. Only a process holding the exact
    // bytes can print this digest, and the negative control below keeps a missing delivery from
    // reading as a pass.
    expect(capturedOutput).toContain(`CANARY_DIGEST=${sha256(secret)}`);
    expect(capturedOutput).not.toContain("CANARY_DIGEST=ABSENT");
    // The same child proves the merge did not widen the surface: a host variable outside the
    // allowlist did NOT arrive, measured in the child rather than in the parent's intent.
    expect(capturedOutput).toContain("HOST_SEEN=ABSENT");

    // (b) AND IT LEAKED NOWHERE. The log bytes DoD-2 names, plus the run capture, plus the
    // workspace the child ran in - a delivery that writes what it delivers fails here.
    expect(logged.join("")).not.toContain(secret);
    expect(capturedOutput).not.toContain(secret);
    expect(readFileSync(join(workspace, "probe.mjs"), "utf8")).not.toContain(secret);
  }, 90_000);
});
