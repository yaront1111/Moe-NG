/**
 * THE SHIPPED DAEMON, BOOTED FOR REAL, answering `/activation/read`.
 *
 * This is the only arm that could have caught the defect this file was written for. Child C
 * shipped the route and child C2 shipped the card, every unit suite was green, and the
 * PRODUCTION daemon still answered HTTP 503 `LISTENER_ACTIVATION_UNAVAILABLE` on every
 * request because nothing constructed the port. In-process arms cannot see that: they inject
 * a provider. So this one spawns `daemon-main.ts` exactly as `pnpm --filter @moe/daemon start`
 * does — real argv, real `--dependencies=./src/daemon-store-dependencies.ts`, real loopback
 * socket, real operator credential — and reads the bytes off the wire.
 *
 * It also pins that the read WRITES NOTHING: the scratch project root must still have no
 * `.moe-next/backups/` directory after repeated reads, and `backup` must report the route's
 * own deferred code rather than a ref for a file that was never taken.
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, expect, it } from "vitest";

import { ACTIVATION_RECEIPT_MEMBERS } from "./bootstrap/activation-receipts.js";
import { ACTIVATION_READ_BACKUP_DEFERRED } from "./http/activation-read.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CSRF = "activation-boot-csrf";
const CREDENTIAL = "activation-boot-operator-credential";
const PROJECT_ID = "proj-activation-boot";
/** Node's own `.moe-next` / `backups` names, from `bootstrap/activation-receipts-measure.ts`. */
const BACKUP_DIRECTORY = ".moe-next";
const BACKUP_LEAF = "backups";

interface Booted {
  readonly child: ChildProcessWithoutNullStreams;
  readonly origin: string;
  readonly port: number;
  readonly projectRoot: string;
}

let booted: Booted | null = null;
/**
 * Held SEPARATELY from `booted`, because `booted` is only assigned once the child has
 * announced its origin. A child that spawns and then never prints one would otherwise
 * outlive the run: `beforeAll` times out, `booted` is still null, nothing kills it, and the
 * leaked handle surfaces later as an EPERM on temp cleanup rather than as this test failing.
 */
let spawned: ChildProcessWithoutNullStreams | null = null;

function bootDaemon(): Promise<Booted> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "moe-activation-boot-")));
  const projectRoot = join(scratch, "project");
  // A REAL, EXISTING root. `nodeGitRunner` runs `execFile("git", ..., { cwd })`, which ENOENTs
  // on a MISSING cwd — so an absent root would leave the git-backed rows unmeasured for a
  // reason unrelated to the wiring, and would make the no-write assertion below vacuous
  // (a subdirectory of a directory that does not exist trivially does not exist either).
  mkdirSync(projectRoot, { recursive: true });
  const child = spawn(
    process.execPath,
    [
      join(PACKAGE_ROOT, "src", "daemon-main.ts"),
      "--dependencies=./src/daemon-store-dependencies.ts",
      "--port=0",
      `--csrf-token=${CSRF}`,
    ],
    {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        MOE_DAEMON_CREDENTIAL: CREDENTIAL,
        MOE_PROJECT_ID: PROJECT_ID,
        // A SCRATCH root, never the repository: the no-write assertion below would
        // otherwise be measuring a directory some other tool is allowed to create.
        MOE_PROJECT_ROOT: projectRoot,
        MOE_STORE_PATH: join(scratch, "store.db"),
      },
      shell: false,
      windowsHide: true,
    },
  ) as ChildProcessWithoutNullStreams;
  spawned = child;
  return new Promise((resolve, reject) => {
    let transcript = "";
    const fail = (why: string): void => reject(new Error(`${why}\n${transcript}`));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      transcript += chunk;
      const found = /listening on (http:\/\/127\.0\.0\.1:(\d+))/u.exec(transcript);
      if (found === null) return;
      resolve({ child, origin: found[1] as string, port: Number(found[2]), projectRoot });
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { transcript += chunk; });
    child.on("error", (error: Error) => fail(`daemon failed to spawn: ${error.message}`));
    child.on("exit", (code) => fail(`daemon exited early with code ${String(code)}`));
  });
}

async function readActivation(
  where: Booted, payload = "{}",
): Promise<{ readonly body: unknown; readonly status: number }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      // The control room's own header set, from apps/control-room/src/live/live-config.ts:94-99.
      headers: {
        "content-length": Buffer.byteLength(payload), "content-type": "application/json",
        host: `127.0.0.1:${where.port}`, origin: where.origin,
        "x-moe-csrf": CSRF, "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
        "x-moe-session-credential": CREDENTIAL,
      },
      host: "127.0.0.1", method: "POST", path: "/activation/read", port: where.port,
      setHost: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        status: response.statusCode ?? 0,
      }));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

beforeAll(async () => { booted = await bootDaemon(); }, 180_000);
afterAll(() => { spawned?.kill(); });

it("answers the activation receipts read from a real production boot", { timeout: 120_000 }, async () => {
  const where = booted;
  if (where === null) throw new Error("daemon did not boot");
  const { body, status } = await readActivation(where);
  const view = body as {
    readonly members: readonly { readonly member: string }[];
    readonly outcome: string;
    readonly signing: { readonly measured: boolean; readonly trustBoundary: boolean };
  };

  // Not 503 and not a hand-rolled shape: the OUTCOME the browser reader decodes.
  expect(status).toBe(200);
  expect(view.outcome).toBe("ACTIVATION");
  // ORDER, not membership: the card renders these rows top to bottom.
  expect(view.members.map((row) => row.member)).toStrictEqual([...ACTIVATION_RECEIPT_MEMBERS]);
  expect(view.signing).toMatchObject({
    measured: false, member: "signing", trustBoundary: false,
  });
});

it("reads repeatedly without ever writing a store backup", { timeout: 120_000 }, async () => {
  const where = booted;
  if (where === null) throw new Error("daemon did not boot");
  const backups = join(where.projectRoot, BACKUP_DIRECTORY, BACKUP_LEAF);

  // THREE reads, because one could pass by luck of ordering: `measureBackup` takes a real
  // `node:sqlite` online backup and creates the directory on the way, so a card polling this
  // path every two seconds is the shape that fills an operator's project with copies.
  const answers = await Promise.all([
    readActivation(where), readActivation(where), readActivation(where),
  ]);
  expect(answers).toHaveLength(3);

  // The POSITIVE CONTROL for the negative below: `existsSync` does answer true here, so the
  // false is a fact about the backups directory and not about a path that cannot exist.
  expect(existsSync(where.projectRoot)).toBe(true);
  expect(existsSync(join(where.projectRoot, BACKUP_DIRECTORY))).toBe(false);
  expect(existsSync(backups)).toBe(false);

  // THE EXACT CODE AND THE LAYER THAT ANSWERED, never "it did not crash": deferred is this
  // route's own answer, so the layer must be ACTIVATION_READ and not the measurer's.
  for (const answer of answers) {
    expect(answer.status).toBe(200);
    const members = (answer.body as { readonly members: readonly { readonly member: string }[] })
      .members;
    expect(members.find((row) => row.member === "backup")).toMatchObject({
      code: ACTIVATION_READ_BACKUP_DEFERRED,
      layer: "ACTIVATION_READ",
      measured: false,
      ref: null,
    });
  }
});
