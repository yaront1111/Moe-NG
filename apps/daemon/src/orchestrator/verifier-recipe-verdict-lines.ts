/**
 * THE LINES A FAILED RECIPE MAY SAY, AND NOTHING ELSE. `verifier-database.ts` replaces the
 * recipe's raw output with a value-free verdict on purpose: the child ran with the disposable
 * database's URL and password in its environment, and any line of it may carry them whole, or
 * split across a truncation boundary. That verdict used to be all a failed run said —
 * `{"migrations":"PASSED","recipeExitCode":1}` — so the seat that had to fix the failure and
 * the operator reading the escalation card learned nothing but the exit code (UnAI 2026-09-18,
 * node 11: 502 tests green in the seat, exit 1 in the verifier, no name for what differed).
 *
 * This keeps the recipe's VERDICT lines only: a test runner's FAIL / × markers, assertion and
 * error lines, and the closing counts — the lines that name a failing test and why. Five gates,
 * in order, each one sufficient on its own for what it covers:
 * 1. SHAPE: a line that could carry a delivered value is refused before its content is read —
 *    any `scheme://…@` connection string, `password`, a `*_URL` variable, a certificate, a
 *    token, an api key.
 * 2. WHOLE: every delivered secret is redacted, case-insensitively, wherever it appears, in its
 *    raw spelling and with its own control bytes stripped (a value may carry one).
 * 3. WINDOW: every contiguous window of a delivered secret at EVERY offset drops the line —
 *    16 characters for a secret of 32 or more, half the secret for a shorter one (never under
 *    8) — so a truncated secret is dropped rather than trimmed. Review of ed62c143: an
 *    8-aligned scan let 36 of the 49 sixteen-character windows of a 64-hex password through.
 * 4. BUDGET, across lines: the kept lines are read TOGETHER. Every run of four or more
 *    characters of a secret that a kept line says is charged against that secret's window
 *    length; a line that would take the total said past the window is dropped. Review of
 *    aa60eb44: five lines of thirteen characters each reconstructed the password exactly while
 *    every line passed gate 3 alone.
 * 5. BOUNDS: ANSI CSI/OSC sequences, every other C0 control and the invisible format characters
 *    (soft hyphen, zero-width and bidi controls, BOM) are stripped; every line is made
 *    well-formed UTF-16; at most {@link RECIPE_VERDICT_LINE_LIMIT} lines, the LAST ones (the
 *    counts sit at the end), each cut at {@link RECIPE_VERDICT_LINE_CHARS}.
 * Outside its reach, by construction: a secret the recipe re-encoded (base64, a hash, a
 * character-by-character transform), or split into runs shorter than BUDGET_RUN, which are
 * charged nothing — twelve lines of three characters is that ceiling, and a recipe that does
 * it is exfiltrating, not reporting (it already holds the value in its own environment and
 * could open a socket). Charging three-character runs would collide with any sha256 an
 * ordinary verdict line carries and drop the very lines this module exists to keep. The
 * runner's raw output is still never persisted; only these lines leave the process.
 */

export const RECIPE_VERDICT_LINE_LIMIT = 12;
export const RECIPE_VERDICT_LINE_CHARS = 200;
/** Window length for a long secret; a shorter secret is scanned at half its length, at least this floor. */
const FRAGMENT_WINDOW = 16;
const FRAGMENT_WINDOW_FLOOR = 8;
/** The shortest run of a secret that counts toward the cross-line budget. */
const BUDGET_RUN = 4;

/** CSI (`ESC [ … m`), OSC (`ESC ] … BEL` / `ESC ] … ESC \`), then every other C0 control but TAB,
 *  DEL, and the invisible format characters. Built from character codes: an escape byte written
 *  into a regex literal reaches the file raw. */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const BACKSLASH = String.fromCharCode(92);
const chars = (...codes: readonly number[]): string => codes.map((code) => String.fromCharCode(code)).join("");
const ANSI_CSI = new RegExp(`${ESC}${BACKSLASH}[[0-?]*[ -/]*[@-~]`, "gu");
const ANSI_OSC = new RegExp(`${ESC}${BACKSLASH}][^${BEL}${ESC}]*(?:${BEL}|${ESC}${BACKSLASH}${BACKSLASH})?`, "gu");
const CONTROLS = new RegExp(
  `[${chars(0)}-${chars(8)}${chars(10)}-${chars(31)}${chars(127)}`
  + `${chars(0xad)}${chars(0x200b)}-${chars(0x200f)}${chars(0x2028)}${chars(0x2029)}${chars(0x202a)}-${chars(0x202e)}`
  + `${chars(0x2060)}-${chars(0x2064)}${chars(0xfeff)}]`, "gu",
);
/** A test runner's own verdict vocabulary (vitest, jest, mocha, node:test, tsc, pnpm). */
const VERDICT = new RegExp(
  "^\\s*(?:[×✗✘●✕✖]|FAIL\\b|Failed Tests|Test Files\\b|Tests\\s+\\d|Test Suites:|Tests:|AssertionError|"
  + "Error:|TypeError|ReferenceError|RangeError|expected\\b|received\\b|[+-] (?:Expected|Received)|"
  + "npm ERR!|ERR_[A-Z_]+|error TS\\d|\\d+ failing|not ok \\d|# fail \\d|ELIFECYCLE|Command failed)", "iu",
);
/** Refused by shape before content: anything that could carry a delivered value. */
const CARRIES_SECRET_SHAPE = /[a-z][a-z0-9+.-]*:\/\/\S*@|postgres(?:ql)?:\/\/|password|passwd|_URL\b|-----BEGIN|PRIVATE KEY|CERTIFICATE|\.crt\b|Bearer\s|token=|secret|api[_-]?key/iu;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function stripped(text: string): string {
  return text.replace(ANSI_CSI, "").replace(ANSI_OSC, "").replace(CONTROLS, "");
}

function windowLength(secret: string): number {
  return secret.length >= FRAGMENT_WINDOW * 2 ? FRAGMENT_WINDOW : Math.max(FRAGMENT_WINDOW_FLOOR, Math.ceil(secret.length / 2));
}

/** Every window of `secret` (already lower-cased) at every offset, deduplicated. */
function windows(secret: string): readonly string[] {
  const length = windowLength(secret);
  if (secret.length < length) return [];
  const out = new Set<string>();
  for (let at = 0; at + length <= secret.length; at += 1) out.add(secret.slice(at, at + length));
  return [...out];
}

/** Which positions of `secret` (lower-cased) this line says, in runs of at least BUDGET_RUN. */
function saidPositions(folded: string, secret: string): Set<number> {
  const said = new Set<number>();
  for (let at = 0; at + BUDGET_RUN <= secret.length; at += 1) {
    let end = at + BUDGET_RUN;
    if (!folded.includes(secret.slice(at, end))) continue;
    while (end < secret.length && folded.includes(secret.slice(at, end + 1))) end += 1;
    for (let index = at; index < end; index += 1) said.add(index);
  }
  return said;
}

export function recipeVerdictLines(output: string, secrets: readonly string[]): readonly string[] {
  // Both spellings of every delivered value: as delivered, and with its own control bytes
  // stripped, because the line is stripped before it is compared (review of aa60eb44).
  const whole = [...new Set(secrets.flatMap((secret) => [secret, stripped(secret)]).filter((secret) => secret.length > 0))];
  const redactions = whole.map((secret) => new RegExp(escapeRegExp(secret), "giu"));
  const folded = whole.map((secret) => secret.toLowerCase());
  const fragments = folded.filter((secret) => secret.length >= FRAGMENT_WINDOW_FLOOR).flatMap(windows);
  const kept: string[] = [];
  for (const raw of output.split(/\r?\n/u)) {
    const line = stripped(raw);
    if (!VERDICT.test(line)) continue;
    if (CARRIES_SECRET_SHAPE.test(line)) continue;
    // Whole secrets are redacted FIRST: a line that carries one whole would otherwise match every
    // window of it and be dropped instead of said; what survives is then checked for windows.
    let said = line;
    for (const redaction of redactions) said = said.replace(redaction, "***");
    const lower = said.toLowerCase();
    if (fragments.some((fragment) => lower.includes(fragment))) continue;
    said = said.trim().toWellFormed();
    kept.push(said.length > RECIPE_VERDICT_LINE_CHARS ? `${said.slice(0, RECIPE_VERDICT_LINE_CHARS)}…`.toWellFormed() : said);
  }
  // THE BUDGET, over the lines that will actually be said, oldest first: what one line may not
  // say alone, twelve lines may not say together.
  const last = kept.slice(-RECIPE_VERDICT_LINE_LIMIT);
  const budget = folded.filter((secret) => secret.length >= FRAGMENT_WINDOW_FLOOR)
    .map((secret) => ({ secret, limit: windowLength(secret), said: new Set<number>() }));
  const out: string[] = [];
  for (const line of last) {
    const lower = line.toLowerCase();
    const charges = budget.map((entry) => ({ entry, positions: saidPositions(lower, entry.secret) }));
    if (charges.some(({ entry, positions }) => new Set([...entry.said, ...positions]).size >= entry.limit)) continue;
    for (const { entry, positions } of charges) for (const position of positions) entry.said.add(position);
    out.push(line);
  }
  return Object.freeze(out);
}

/**
 * The most UTF-16 code units the JSON-encoded verdict can add for these lines: every kept line
 * is well-formed, so every character costs at most two units when escaped (`"` and `\`), plus
 * the quotes and comma per line and the key. `node-verifier-failure.ts` sizes its finding tail
 * from this so the lines always arrive whole.
 */
export const RECIPE_VERDICT_LINES_MAX_ENCODED_UNITS =
  RECIPE_VERDICT_LINE_LIMIT * ((RECIPE_VERDICT_LINE_CHARS + 1) * 2 + 3) + 128;
