import { spawn as nodeSpawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import type { DockerRunner } from "../deployment/deploy-ports.js";
import { classifyDockerProbe } from "../repository/deployment/deployment-docker-probe.js";
import type { NodeMission } from "./agent-wrapper.js";
import type { VerifierRunCapture } from "./node-verifier.js";
import {
  isPemCertificate, resolveVerifierDatabaseProvisioning, tlsCertificateCommand, tlsEnableCommand,
  tlsExtractCommand, type ResolvedVerifierDatabaseProvisioning, type VerifierDatabaseProvisioning,
} from "./verifier-database-provisioning.js";
import {
  createVerifierProcessRunner, VerifierProcessCancelledError, VerifierProcessContainmentError,
  type VerifierProcessRunner, type VerifierProcessRunnerOptions,
} from "./verifier-process-runner.js";

export interface VerifierDatabaseOptions extends VerifierProcessRunnerOptions {
  readonly dockerTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly pollMs?: number;
  /** Image, delivered variable names and TLS — the operator's spelling; absent = the old shape. */
  readonly database?: VerifierDatabaseProvisioning | undefined;
}

class DatabaseRefusal extends Error {
  constructor(
    code: "MIGRATION_DB_UNAVAILABLE" | "MIGRATION_FAILED" | "MIGRATION_DID_NOT_START" | "MIGRATION_DID_NOT_EXIT",
    fields: Record<string, string | null>,
  ) {
    super(JSON.stringify({ code, refusedBy: "DAEMON_INGRESS", ...fields }));
  }
}

/**
 * How the operator's shell reaches its Docker daemon, forwarded BY NAME into every docker CLI
 * spawn. The recipe allowlist strips every DOCKER_* variable, and a rootless, Colima, Podman or
 * remote daemon that only DOCKER_HOST or a context names would otherwise be probed at
 * /var/run/docker.sock and refused as unavailable while `docker` works in that same shell.
 */
const DOCKER_CLIENT_VARIABLES = [
  "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_CONFIG",
] as const;
const dockerClientRoute = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(DOCKER_CLIENT_VARIABLES.map((name) => [name, source[name]]));

const unavailable = (reason: string): DatabaseRefusal => new DatabaseRefusal("MIGRATION_DB_UNAVAILABLE", { reason });
function safeCapture(output: string, exitCode: number | null): VerifierRunCapture {
  return { byteCount: Buffer.byteLength(output), exitCode, output, sha256: createHash("sha256").update(output).digest("hex") };
}

function declaresMigration(workspace: string): boolean {
  let manifest: unknown;
  try { manifest = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw unavailable("MANIFEST_UNREADABLE");
  }
  if (typeof manifest !== "object" || manifest === null) throw unavailable("MANIFEST_INVALID");
  const scripts = (manifest as { scripts?: unknown }).scripts;
  if (scripts === undefined) return false;
  if (typeof scripts !== "object" || scripts === null) throw unavailable("MANIFEST_INVALID");
  if (!Object.hasOwn(scripts, "db:migrate")) return false;
  const script = (scripts as Record<string, unknown>)["db:migrate"];
  if (typeof script !== "string" || script.trim() === "") throw unavailable("MIGRATION_SCRIPT_INVALID");
  return true;
}

/**
 * Where the migration step got to, which is NOT the same question as which file to print.
 *
 * `named` is whether the output mentions a migration at all; `file` is the safe basename to
 * report. Keeping them apart is the whole point: a null `file` used to mean two unrelated
 * things — no migration ever ran, or one ran and failed but its name could not be printed
 * safely — and the operator could not tell which. Measured on UnAI 2026-09-16, where a product
 * whose migration CLI reads its own variables threw at import, nothing ran, and the refusal
 * still said `MIGRATION_FAILED` with a null file, promising a filename it could never supply.
 */
interface MigrationFailurePoint {
  /** The migration the output names, safe or not; null when the output names none. */
  readonly named: string | null;
  /** The basename safe to report: it exists in `migrations/` and carries no secret. */
  readonly file: string | null;
}

function failedFile(
  workspace: string, output: string, secrets: readonly string[],
): MigrationFailurePoint {
  // Only emit an actual migration basename, never a raw error/SQL/URL. Missing evidence is null.
  // node-pg-migrate emits its banner AFTER running the JS builder: a thrown builder has
  // a stack frame instead, which must outrank an earlier migration's successful banner.
  const frame = /\bat [^\r\n]*[/\\]migrations[/\\]([\w.-]+):\d+:\d+/u.exec(output)?.[1];
  const last = frame ?? [...output.matchAll(/### MIGRATION (.+?) \((?:UP|DOWN)\) ###/gu)].at(-1)?.[1];
  const named = last ?? null;
  try {
    const file = readdirSync(join(workspace, "migrations")).find((name) =>
      /^[\w.-]+$/u.test(name) && !secrets.some((value) => value !== "" && name.includes(value))
      && (name === last || parse(name).name === last)) ?? null;
    return { file, named };
  } catch { return { file: null, named }; }
}

/**
 * Docker binds loopback port ZERO atomically, then `docker port` reports it: never pick a
 * free Node port first (TOCTOU under parallel staffing). Each verification owns a UUID name
 * and a different password. This is a same-UID recipe boundary, not hostile-process isolation.
 * Raw DB child output is deliberately NOT persisted: it can contain a URL, password, SQL or
 * split/truncated secret. The runner's raw byte count/digest remain the receipt binding;
 * only its operator-facing output tail is replaced with a value-free verdict.
 */
class DisposableDatabase {
  readonly name = `moe-verifier-${randomUUID()}`;
  readonly password = randomBytes(32).toString("hex");
  private runner: VerifierProcessRunner | undefined;
  private attempted = false;
  private cancelled = false;
  private disposal: Promise<void> | undefined;
  /** Host directory holding the CA certificate the client pins; removed with the container. */
  private caDirectory: string | undefined;
  private readonly brief: NodeMission;
  private readonly options: VerifierDatabaseOptions;
  private readonly provisioning: ResolvedVerifierDatabaseProvisioning;

  constructor(brief: NodeMission, options: VerifierDatabaseOptions) {
    this.brief = brief; this.options = options;
    this.provisioning = resolveVerifierDatabaseProvisioning(options.database);
  }

  cancel(): Promise<void> {
    this.cancelled = true;
    return this.runner?.close() ?? Promise.resolve();
  }

  private checkCancellation(): void {
    if (this.cancelled) throw new VerifierProcessCancelledError();
  }

  private docker: DockerRunner = async (args) => {
    const spawn = this.options.spawn ?? nodeSpawn;
    const environment = this.options.environment ?? process.env;
    const runner = createVerifierProcessRunner({
      ...this.options, delivered: undefined, timeoutMs: this.options.dockerTimeoutMs ?? 180_000,
      // Reuse the EXISTING process-group/Windows taskkill lifetime, not a second timer machine.
      // Only the recipe spawn is adapted; native taskkill helper invocations pass through.
      spawn: (file, argv, options) => options.shell === true
        ? spawn("docker", [...args], { ...options, shell: false, windowsHide: true, env: {
          ...options.env, HOME: environment.HOME, USERPROFILE: environment.USERPROFILE,
          ...dockerClientRoute(environment), POSTGRES_PASSWORD: this.password,
        } }) : spawn(file, argv, options),
    });
    try {
      const result = await runner({ ...this.brief, test: "verifier-docker-command" });
      return { code: result.exitCode, stdout: result.output, stderr: "" };
    } finally { await runner.close(); }
  };

  private async start(): Promise<string> {
    const probe = await this.docker(["version", "--format", "{{.Server.Version}}"]);
    const availability = classifyDockerProbe({ status: probe.code, stdout: probe.stdout, stderr: "", spawnError: null });
    if (probe.code !== 0 || !availability.available) throw unavailable("DOCKER_UNAVAILABLE");
    this.checkCancellation();
    // Mark BEFORE spawning: even an errored/timed-out run may have created the named container.
    this.attempted = true;
    const started = await this.docker(["run", "--detach", "--name", this.name,
      "--publish", "127.0.0.1:0:5432", "--env", "POSTGRES_PASSWORD",
      "--env", "POSTGRES_USER=app", "--env", "POSTGRES_DB=app", this.provisioning.image]);
    if (started.code !== 0) throw unavailable("IMAGE_PULL_OR_START_FAILED");
    await this.waitReady();
    if (this.provisioning.tls) await this.provisionTls();
    const port = await this.docker(["port", this.name, "5432/tcp"]);
    const binding = port.stdout.trim();
    const match = /^127\.0\.0\.1:(\d+)$/u.exec(binding);
    if (port.code !== 0 || match === null || Number(match[1]) < 1 || Number(match[1]) > 65535) {
      throw unavailable("PORT_UNAVAILABLE");
    }
    return `postgres://app:${this.password}@${binding}/app`;
  }

  /**
   * Mint the server certificate in-container, switch the server to TLS by reload, and bring
   * the PUBLIC certificate out to a host file the client pins as its CA. The key stays behind.
   * Each step is one bounded docker exec on the container this run already owns, so failure
   * cleanup is the ordinary container removal — nothing new to leak.
   */
  private async provisionTls(): Promise<void> {
    this.checkCancellation();
    const minted = await this.docker(tlsCertificateCommand(this.name));
    if (minted.code !== 0) throw unavailable("TLS_CERTIFICATE_MINT_FAILED");
    const enabled = await this.docker(tlsEnableCommand(this.name, "app", "app"));
    if (enabled.code !== 0) throw unavailable("TLS_ENABLE_FAILED");
    const extracted = await this.docker(tlsExtractCommand(this.name));
    if (extracted.code !== 0 || !isPemCertificate(extracted.stdout)) throw unavailable("TLS_CERTIFICATE_INVALID");
    this.caDirectory = mkdtempSync(join(tmpdir(), "moe-verifier-ca-"));
    writeFileSync(join(this.caDirectory, "ca.crt"), `${extracted.stdout.trim()}\n`, { mode: 0o600 });
  }

  /** The variables the recipe and migration see: the URL under every configured name, plus the CA path. */
  private deliveredVariables(url: string): Record<string, string> {
    const delivered: Record<string, string> = { ...this.options.delivered };
    for (const name of this.provisioning.urlVariables) delivered[name] = url;
    if (this.provisioning.caPathVariable !== null && this.caDirectory !== undefined) {
      delivered[this.provisioning.caPathVariable] = join(this.caDirectory, "ca.crt");
    }
    return delivered;
  }

  private async waitReady(): Promise<void> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 60_000);
    do {
      this.checkCancellation();
      const ready = await this.docker(["exec", this.name, "pg_isready", "-h", "127.0.0.1", "-U", "app", "-d", "app"]);
      if (ready.code === 0) return;
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 250));
    } while (Date.now() < deadline);
    throw unavailable("POSTGRES_NOT_READY");
  }

  async execute(): Promise<VerifierRunCapture> {
    try {
      const url = await this.start();
      this.checkCancellation();
      this.runner = createVerifierProcessRunner({ ...this.options, delivered: this.deliveredVariables(url) });
      const migration = await this.runner({ ...this.brief, test: "pnpm db:migrate" });
      if (migration.exitCode !== 0) {
        const secrets = [this.password, ...Object.values(this.options.delivered ?? {})];
        const point = failedFile(this.brief.workspace, migration.output, secrets);
        if (point.named !== null) throw new DatabaseRefusal("MIGRATION_FAILED", { file: point.file });
        // Nothing the output names means no migration ever started. A null exit is the runner's
        // deadline or a signal cutting the step, which may have read its variables, connected and
        // then hung: the exit status is the fact, and it says nothing about what the product
        // reads. Only a script that EXITED before its first migration failed on its own, and the
        // actionable fact is then which database variable this runner defined — a product that
        // reads its own is refused before its first migration and can say so no other way.
        throw migration.exitCode === null
          ? new DatabaseRefusal("MIGRATION_DID_NOT_EXIT", {})
          : new DatabaseRefusal("MIGRATION_DID_NOT_START", { delivered: this.provisioning.urlVariables.join(",") });
      }
      this.checkCancellation();
      const result = await this.runner(this.brief);
      return { ...result, output: JSON.stringify({ migrations: "PASSED", recipeExitCode: result.exitCode }) };
    } finally { await this.dispose(); }
  }

  private dispose(): Promise<void> {
    this.disposal ??= this.cleanup();
    return this.disposal;
  }

  private async cleanup(): Promise<void> {
    try { await this.runner?.close(); }
    finally {
      // The CA file is public material, but it is this run's and must not outlive it.
      if (this.caDirectory !== undefined) {
        try { rmSync(this.caDirectory, { force: true, recursive: true }); } catch { /* best effort; not a leak of authority */ }
        this.caDirectory = undefined;
      }
      if (this.attempted) {
        // A failed rm is not proof of a leak OR absence. Ask Docker, retry, then fail closed.
        let absent = false;
        for (let attempt = 0; attempt < 2 && !absent; attempt += 1) {
          await this.docker(["rm", "--force", "--volumes", this.name]);
          const remaining = await this.docker(["ps", "--all", "--quiet", "--filter", `name=^/${this.name}$`]);
          absent = remaining.code === 0 && remaining.stdout.trim() === "";
        }
        if (!absent) throw unavailable("CONTAINER_CLEANUP_FAILED");
      }
    }
  }
}

class DatabaseRunner {
  private readonly baseline: VerifierProcessRunner;
  private readonly active = new Map<Promise<VerifierRunCapture>, DisposableDatabase | null>();
  private closed = false;
  private closing: Promise<void> | undefined;
  private cleanupFailure: DatabaseRefusal | undefined;
  private readonly options: VerifierDatabaseOptions;
  constructor(options: VerifierDatabaseOptions) { this.options = options; this.baseline = createVerifierProcessRunner(options); }

  run = (brief: NodeMission): Promise<VerifierRunCapture> => {
    if (this.closed) return Promise.reject(new Error("VERIFIER_PROCESS_RUNNER_CLOSED"));
    let database: DisposableDatabase | null = null;
    let operation: Promise<VerifierRunCapture>;
    try {
      database = declaresMigration(brief.workspace) ? new DisposableDatabase(brief, this.options) : null;
      operation = database === null ? this.baseline(brief) : database.execute();
    } catch (error) { operation = Promise.reject(error); }
    const done = operation.catch((error: unknown) => {
      if (error instanceof VerifierProcessCancelledError || error instanceof VerifierProcessContainmentError) throw error;
      if (error instanceof DatabaseRefusal && error.message === unavailable("CONTAINER_CLEANUP_FAILED").message) {
        this.cleanupFailure = error;
        this.closed = true; // A known leak poisons new work, and shutdown reports it too.
      }
      return safeCapture(error instanceof DatabaseRefusal ? error.message : unavailable("PROCESS_FAILED").message, 1);
    }).finally(() => { this.active.delete(done); });
    this.active.set(done, database);
    return done;
  };

  activeCount = (): number => this.active.size;
  close = (): Promise<void> => {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    // Wait for bounded Docker startup before teardown: killing its CLI is not proof that
    // the daemon stopped creating the container. Cancel the RECIPE tree, then drain owners.
    this.closing = (async () => {
      const cancellations = [this.baseline.close(), ...[...this.active.values()].map((db) => db?.cancel())];
      const results = await Promise.allSettled(cancellations);
      await Promise.allSettled(this.active.keys());
      if (this.cleanupFailure !== undefined) throw this.cleanupFailure;
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })();
    return this.closing;
  };
}

/** No-db delegates unchanged; DB captures carry closed diagnostics into the existing failure ledger. */
export function createVerifierDatabaseRunner(options: VerifierDatabaseOptions = {}): VerifierProcessRunner {
  const owner = new DatabaseRunner(options);
  return Object.assign(owner.run, { activeCount: owner.activeCount, close: owner.close });
}
