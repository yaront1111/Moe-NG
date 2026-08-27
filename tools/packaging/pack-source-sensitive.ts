const PRIVATE_KEY_EXTENSIONS = Object.freeze(new Set([
  "der", "jks", "kdbx", "key", "keystore", "p12", "p8", "pem", "pfx", "ppk",
]));
const SECRET_DOCUMENT_EXTENSIONS = Object.freeze(new Set([
  "conf", "config", "csv", "ini", "json", "toml", "txt", "xml", "yaml", "yml",
]));
const CLOUD_CREDENTIAL_PATHS = Object.freeze([
  /(?:^|\/)\.kube\/config(?:$|\.)/u,
  /(?:^|\/)\.aws\/(?:config|credentials)(?:$|\.)/u,
  /(?:^|\/)\.aws\/(?:cli|sso)\/cache\/[^/]+$/u,
  /(?:^|\/)(?:\.config\/)?gcloud\/(?:access_tokens\.db|application_default_credentials\.json|credentials\.db)$/u,
  /(?:^|\/)(?:\.config\/)?gcloud\/legacy_credentials(?:\/|$)/u,
  /(?:^|\/)\.azure\/(?:accesstokens\.json|msal_token_cache(?:\.[^/]+)?|service_principal_entries\.json|tokencache\.dat)$/u,
  /(?:^|\/)\.config\/gh\/hosts\.yml$/u,
]);
const SENSITIVE_DOCUMENT_STEM =
  /(?:^|[-_.])(?:auth|credentials?|secrets?|service[-_.]?accounts?(?:[-_.]?keys?)?|(?:access|api|github)[-_.]?(?:keys?|tokens?))(?:[-_.]|$)/u;
/**
 * Basenames that ARE the secret, with no qualifier to give them away. Matched by
 * EXACT stem equality, never as a substring: `design-tokens.json`, `tokenizer.ts`,
 * `token-bucket.ts`, `session-token.ts` and `credential-codec.ts` are ordinary
 * source a release is obliged to ship, and a substring rule would refuse all five.
 */
const EXACT_SECRET_STEMS = Object.freeze(new Set([
  "credential", "credentials", "secret", "secrets", "token", "tokens",
]));
const BACKUP_SUFFIX = /(?:~|\.(?:bak|backup|old|orig|save|swp|temp|tmp))$/u;

function withoutBackupSuffixes(basename: string): string {
  let classified = basename;
  while (BACKUP_SUFFIX.test(classified)) classified = classified.replace(BACKUP_SUFFIX, "");
  return classified;
}

/** Path-only release denylist; contents are never read or echoed to classify credentials. */
export function isSensitivePackSourcePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const rawBasename = normalized.split("/").at(-1) ?? "";
  const basename = withoutBackupSuffixes(rawBasename);
  const classifiedPath = normalized.slice(0, normalized.length - rawBasename.length) + basename;
  if (basename === ".envrc" || basename.endsWith(".env") || basename.startsWith(".env.")) return true;
  if ([
    ".credentials", ".dockercfg", ".git-credentials", ".netrc", ".npmrc", ".pnpmrc",
    ".pypirc", ".vault-token", ".yarnrc", ".yarnrc.yml", "_netrc",
  ].includes(basename)) return true;
  if (classifiedPath === ".docker/config.json" || classifiedPath.includes("/.docker/config.json")) return true;
  if (CLOUD_CREDENTIAL_PATHS.some((pattern) => pattern.test(classifiedPath))) return true;
  if (/^id_(?:dsa|ecdsa|ed25519|rsa)(?:_sk)?$/u.test(basename)) return true;
  const separator = basename.lastIndexOf(".");
  const extension = separator < 0 ? "" : basename.slice(separator + 1);
  if (PRIVATE_KEY_EXTENSIONS.has(extension)) return true;
  if (extension === "" && /^authkey(?:[-_][a-z0-9]+)*$/u.test(basename)) return true;
  // Leading dots are a HIDING convention, not a file type. `lastIndexOf(".")` reads
  // `.secret` as stem "" plus extension "secret", so the whole conventional roster
  // walked past this gate the moment someone hid it. Classify `.token.txt` as
  // `token.txt`. ALL leading dots go, not one: stripping a single dot only moves the
  // evasion to `...token`, which POSIX hides identically. The dotted spelling is
  // preserved above, where `.env*`, `.envrc`, the literal list and the private-key
  // extensions all still need it.
  const named = basename.replace(/^\.+/u, "");
  const namedSeparator = named.lastIndexOf(".");
  const namedExtension = namedSeparator < 0 ? "" : named.slice(namedSeparator + 1);
  const stem = namedSeparator < 0 ? named : named.slice(0, namedSeparator);
  return (namedExtension === "" || SECRET_DOCUMENT_EXTENSIONS.has(namedExtension))
    && (EXACT_SECRET_STEMS.has(stem) || SENSITIVE_DOCUMENT_STEM.test(stem));
}
