/**
 * What the verifier's disposable database looks like, decided by the OPERATOR rather than
 * hard-coded. Measured on UnAI 2026-09-17: the runner spun up a plain `postgres:17-alpine`
 * and delivered only `DATABASE_URL`, while the product's `db:migrate` needed pgvector, a
 * TLS-enabled server and its own variable names (`UNAI_MIGRATION_DATABASE_URL`,
 * `UNAI_DATABASE_CA_PATH`, connecting with `ssl: { ca, rejectUnauthorized: true }`). It
 * refused before its first migration on EVERY node, so no DB-backed node could ever verify —
 * and since the verifier is what was broken, no product seat could fix it. Hence this seam.
 *
 * Absent configuration is byte-identical to the old behaviour. The TLS shape is deliberately
 * ONE self-signed certificate that is both the server certificate and the client's CA: the
 * client pins it by identity (`rejectUnauthorized: true` against that exact cert), and its
 * `IP:127.0.0.1` SAN satisfies the hostname check on the loopback-mapped port. It is minted
 * INSIDE the container with the image's own openssl, so the host needs no toolchain, and the
 * private key never leaves the container. This is a same-UID disposable boundary, not
 * production PKI — the same trust class as the rest of verifier-database.ts.
 */

export interface VerifierDatabaseProvisioning {
  /** Container image; defaults to the plain postgres image. */
  readonly image?: string | undefined;
  /** Every variable name the generated connection URL is delivered under. */
  readonly urlVariables?: readonly string[] | undefined;
  /** Whether to enable TLS on the server and deliver a CA the client can pin. */
  readonly tls?: boolean | undefined;
  /** The variable name the host path of the CA certificate is delivered under (TLS only). */
  readonly caPathVariable?: string | undefined;
}

export interface ResolvedVerifierDatabaseProvisioning {
  readonly image: string;
  readonly urlVariables: readonly string[];
  readonly tls: boolean;
  readonly caPathVariable: string | null;
}

export const DEFAULT_VERIFIER_DATABASE_IMAGE = "postgres:17-alpine";
export const DEFAULT_VERIFIER_DATABASE_URL_VARIABLE = "DATABASE_URL";
/** The official postgres image's data directory; relative ssl_*_file paths resolve under it. */
export const VERIFIER_DATABASE_DATA_DIRECTORY = "/var/lib/postgresql/data";

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const TRUTHY = new Set(["1", "true", "on", "yes"]);

export class VerifierDatabaseConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = "VerifierDatabaseConfigurationError"; }
}

/** Defaults filled in; a TLS request without a CA variable is a configuration error, not silence. */
export function resolveVerifierDatabaseProvisioning(
  config: VerifierDatabaseProvisioning | undefined,
): ResolvedVerifierDatabaseProvisioning {
  const image = config?.image?.trim();
  if (image !== undefined && (image === "" || /\s/u.test(image))) {
    throw new VerifierDatabaseConfigurationError(`verifier database image "${image}" is not a valid image reference`);
  }
  const urlVariables = [...new Set(config?.urlVariables ?? [DEFAULT_VERIFIER_DATABASE_URL_VARIABLE])];
  if (urlVariables.length === 0) throw new VerifierDatabaseConfigurationError("verifier database url variables must name at least one variable");
  for (const name of [...urlVariables, ...(config?.caPathVariable === undefined ? [] : [config.caPathVariable])]) {
    if (!VARIABLE_NAME.test(name)) throw new VerifierDatabaseConfigurationError(`"${name}" is not a valid environment variable name`);
  }
  const tls = config?.tls === true;
  if (tls && config?.caPathVariable === undefined) {
    throw new VerifierDatabaseConfigurationError("verifier database TLS needs a CA path variable to deliver the certificate under");
  }
  return Object.freeze({
    caPathVariable: tls ? config?.caPathVariable ?? null : null,
    image: image ?? DEFAULT_VERIFIER_DATABASE_IMAGE,
    tls,
    urlVariables: Object.freeze(urlVariables),
  });
}

/**
 * The operator's spelling, from the wrapper's environment. Undefined when nothing is set, so
 * the caller can omit the option entirely and keep the old code path byte-identical.
 */
export function verifierDatabaseProvisioningFromEnvironment(
  environment: NodeJS.ProcessEnv,
): VerifierDatabaseProvisioning | undefined {
  const image = environment["MOE_VERIFIER_DB_IMAGE"]?.trim();
  const variables = environment["MOE_VERIFIER_DB_URL_VARS"]?.split(",").map((name) => name.trim()).filter((name) => name !== "");
  const tlsRaw = environment["MOE_VERIFIER_DB_TLS"]?.trim().toLowerCase();
  const caPathVariable = environment["MOE_VERIFIER_DB_CA_VAR"]?.trim();
  const provisioning: VerifierDatabaseProvisioning = {
    ...(image === undefined || image === "" ? {} : { image }),
    ...(variables === undefined || variables.length === 0 ? {} : { urlVariables: variables }),
    ...(tlsRaw === undefined || tlsRaw === "" ? {} : { tls: TRUTHY.has(tlsRaw) }),
    ...(caPathVariable === undefined || caPathVariable === "" ? {} : { caPathVariable }),
  };
  return Object.keys(provisioning).length === 0 ? undefined : provisioning;
}

/**
 * Mint the certificate inside the container, as root so the files can be handed to the
 * postgres user; the key is 0600 and stays behind. One `sh -ec` script, one exec.
 */
export function tlsCertificateCommand(container: string): readonly string[] {
  const script = [
    `cd ${VERIFIER_DATABASE_DATA_DIRECTORY}`,
    "openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=moe-verifier"
      + " -addext subjectAltName=IP:127.0.0.1,DNS:localhost"
      + " -addext basicConstraints=critical,CA:TRUE"
      + " -keyout server.key -out server.crt",
    "chown postgres:postgres server.key server.crt",
    "chmod 600 server.key",
  ].join(" && ");
  return ["exec", "--user", "root", container, "sh", "-ec", script];
}

/**
 * `ssl` is a SIGHUP parameter in PostgreSQL 10+, so ALTER SYSTEM plus a reload turns it on
 * without a restart; the initial POSTGRES_USER is a superuser, which ALTER SYSTEM requires.
 * ONE `-c` PER STATEMENT: psql runs a single `-c` string as one implicit transaction, and
 * ALTER SYSTEM refuses "inside a transaction block" (measured live 2026-09-18). Each `-c` is
 * its own transaction; ON_ERROR_STOP still halts at the first failure.
 */
export function tlsEnableCommand(container: string, user: string, database: string): readonly string[] {
  const statements = [
    "ALTER SYSTEM SET ssl = 'on'",
    "ALTER SYSTEM SET ssl_cert_file = 'server.crt'",
    "ALTER SYSTEM SET ssl_key_file = 'server.key'",
    "SELECT pg_reload_conf()",
  ];
  return ["exec", "--user", "postgres", container, "psql", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", database,
    ...statements.flatMap((statement) => ["-c", statement])];
}

/** The public certificate only; the key is never read out. */
export function tlsExtractCommand(container: string): readonly string[] {
  return ["exec", container, "cat", `${VERIFIER_DATABASE_DATA_DIRECTORY}/server.crt`];
}

/** A single PEM certificate and nothing else — the value the client will pin. */
export function isPemCertificate(text: string): boolean {
  const trimmed = text.trim();
  return /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/u.test(trimmed)
    && (trimmed.match(/-----BEGIN CERTIFICATE-----/gu) ?? []).length === 1;
}
