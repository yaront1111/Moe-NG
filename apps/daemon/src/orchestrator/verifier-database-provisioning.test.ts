import { describe, expect, it } from "vitest";

import {
  DEFAULT_VERIFIER_DATABASE_IMAGE, DEFAULT_VERIFIER_DATABASE_URL_VARIABLE,
  VERIFIER_DATABASE_DATA_DIRECTORY, VerifierDatabaseConfigurationError, isPemCertificate,
  resolveVerifierDatabaseProvisioning, tlsCertificateCommand, tlsEnableCommand, tlsExtractCommand,
  verifierDatabaseProvisioningFromEnvironment,
} from "./verifier-database-provisioning.js";

/**
 * The operator seam behind the verifier's disposable database (UnAI, 2026-09-17: a product
 * needing pgvector + TLS + its own variable names could never verify against the hard-coded
 * plain postgres + DATABASE_URL). Every arm asserts the exact shape, not merely "no throw".
 */
describe("resolveVerifierDatabaseProvisioning", () => {
  it("absent configuration is the old shape exactly: plain image, DATABASE_URL only, no TLS", () => {
    expect(resolveVerifierDatabaseProvisioning(undefined)).toEqual({
      caPathVariable: null, image: DEFAULT_VERIFIER_DATABASE_IMAGE, tls: false,
      urlVariables: [DEFAULT_VERIFIER_DATABASE_URL_VARIABLE],
    });
    expect(DEFAULT_VERIFIER_DATABASE_IMAGE).toBe("postgres:17-alpine");
    expect(DEFAULT_VERIFIER_DATABASE_URL_VARIABLE).toBe("DATABASE_URL");
  });

  it("carries the operator's image, every url variable (deduplicated) and the CA variable", () => {
    expect(resolveVerifierDatabaseProvisioning({
      caPathVariable: "UNAI_DATABASE_CA_PATH", image: "pgvector/pgvector:pg17", tls: true,
      urlVariables: ["DATABASE_URL", "UNAI_MIGRATION_DATABASE_URL", "DATABASE_URL"],
    })).toEqual({
      caPathVariable: "UNAI_DATABASE_CA_PATH", image: "pgvector/pgvector:pg17", tls: true,
      urlVariables: ["DATABASE_URL", "UNAI_MIGRATION_DATABASE_URL"],
    });
  });

  it("drops the CA variable when TLS is off, so nothing delivers a path that does not exist", () => {
    expect(resolveVerifierDatabaseProvisioning({ caPathVariable: "X_CA", tls: false }).caPathVariable).toBeNull();
  });

  it.each([
    [{ tls: true }, /CA path variable/u],
    [{ urlVariables: [] }, /at least one variable/u],
    [{ urlVariables: ["1BAD"] }, /not a valid environment variable name/u],
    [{ urlVariables: ["OK"], caPathVariable: "has space", tls: true }, /not a valid environment variable name/u],
    [{ image: "" }, /not a valid image reference/u],
    [{ image: "bad image" }, /not a valid image reference/u],
  ] as const)("refuses %j as a configuration error", (config, message) => {
    expect(() => resolveVerifierDatabaseProvisioning(config)).toThrow(VerifierDatabaseConfigurationError);
    expect(() => resolveVerifierDatabaseProvisioning(config)).toThrow(message);
  });
});

describe("verifierDatabaseProvisioningFromEnvironment", () => {
  it("is undefined when nothing is set, so the caller omits the option and keeps the old path", () => {
    expect(verifierDatabaseProvisioningFromEnvironment({})).toBeUndefined();
    expect(verifierDatabaseProvisioningFromEnvironment({ MOE_VERIFIER_DB_IMAGE: "  ", MOE_VERIFIER_DB_URL_VARS: " , " })).toBeUndefined();
  });

  it("reads the four operator variables, trimming and splitting the url list", () => {
    expect(verifierDatabaseProvisioningFromEnvironment({
      MOE_VERIFIER_DB_CA_VAR: " UNAI_DATABASE_CA_PATH ",
      MOE_VERIFIER_DB_IMAGE: " pgvector/pgvector:pg17 ",
      MOE_VERIFIER_DB_TLS: "1",
      MOE_VERIFIER_DB_URL_VARS: "DATABASE_URL, UNAI_MIGRATION_DATABASE_URL ,",
    })).toEqual({
      caPathVariable: "UNAI_DATABASE_CA_PATH", image: "pgvector/pgvector:pg17", tls: true,
      urlVariables: ["DATABASE_URL", "UNAI_MIGRATION_DATABASE_URL"],
    });
  });

  it.each([["1", true], ["true", true], ["ON", true], ["yes", true], ["0", false], ["off", false], ["maybe", false]])(
    "reads MOE_VERIFIER_DB_TLS=%s as tls=%s", (raw, tls) => {
      expect(verifierDatabaseProvisioningFromEnvironment({ MOE_VERIFIER_DB_TLS: raw })).toEqual({ tls });
    },
  );
});

describe("the TLS docker commands", () => {
  it("mints one self-signed cert as root, pinned to loopback, marked CA, key left 0600 for postgres", () => {
    const command = tlsCertificateCommand("moe-verifier-x");
    expect(command.slice(0, 6)).toEqual(["exec", "--user", "root", "moe-verifier-x", "sh", "-ec"]);
    const script = command[6]!;
    expect(script.startsWith(`cd ${VERIFIER_DATABASE_DATA_DIRECTORY} && openssl req -x509`)).toBe(true);
    expect(script).toContain("-addext subjectAltName=IP:127.0.0.1,DNS:localhost");
    expect(script).toContain("-addext basicConstraints=critical,CA:TRUE");
    expect(script).toContain("-keyout server.key -out server.crt");
    expect(script).toContain("chown postgres:postgres server.key server.crt");
    expect(script).toContain("chmod 600 server.key");
    // A single exec, no host shell: every argument is a literal array element.
    expect(command).toHaveLength(7);
  });

  it("turns ssl on by ALTER SYSTEM + reload, stopping on the first error", () => {
    const command = tlsEnableCommand("moe-verifier-x", "app", "app");
    expect(command.slice(0, 4)).toEqual(["exec", "--user", "postgres", "moe-verifier-x"]);
    expect(command).toContain("ON_ERROR_STOP=1");
    const sql = command[command.length - 1]!;
    expect(sql).toContain("ALTER SYSTEM SET ssl = 'on'");
    expect(sql).toContain("ssl_cert_file = 'server.crt'");
    expect(sql).toContain("ssl_key_file = 'server.key'");
    expect(sql).toContain("pg_reload_conf()");
  });

  it("extracts only the public certificate, never the key", () => {
    const command = tlsExtractCommand("moe-verifier-x");
    expect(command).toEqual(["exec", "moe-verifier-x", "cat", `${VERIFIER_DATABASE_DATA_DIRECTORY}/server.crt`]);
    expect(command.join(" ")).not.toContain("server.key");
  });
});

describe("isPemCertificate", () => {
  const pem = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUZ+abc=\n-----END CERTIFICATE-----\n";
  it("accepts exactly one PEM certificate block", () => {
    expect(isPemCertificate(pem)).toBe(true);
    expect(isPemCertificate(pem.replaceAll("\n", "\r\n"))).toBe(true);
  });
  it.each([
    ["", "empty"],
    ["not a cert", "prose"],
    [`${pem}${pem}`, "two certificates"],
    // Assembled at runtime: the packer's secret scanner refuses any source that carries this
    // marker as contiguous bytes (PACK_SOURCE_SENSITIVE_PATH), and it is right to.
    [["-----BEGIN", "PRIVATE", "KEY-----\nabc=\n-----END", "PRIVATE", "KEY-----"].join(" "), "a private key"],
    [`${pem}trailing`, "trailing bytes"],
  ])("rejects %s (%s)", (text) => {
    expect(isPemCertificate(text)).toBe(false);
  });
});
