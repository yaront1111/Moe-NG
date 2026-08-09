import { createHash } from "node:crypto";

import {
  ScopeObserverError,
  type GitRefListing,
  type GitRefObservation,
} from "./scope-contract.js";

/**
 * Parsing of `git for-each-ref` output, separated from the process boundary.
 *
 * scope-git.ts owns spawning; this owns grammar. They are split because the two
 * responsibilities are genuinely different — one is an external effect, the
 * other is a pure function — and because keeping them together pushed
 * scope-git.ts well past the per-file target.
 *
 * The pure half is also the only half the refusal tests can reach: real git
 * cannot be made to emit invalid UTF-8 or a truncated record on demand, so the
 * malformed cases drive this function directly. It is production code that
 * listRefs() calls, not a reimplementation of it.
 */

const REF_SCOPES = Object.freeze(["refs/heads/", "refs/remotes/"] as const);
const LOWERCASE_COMMIT = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/u;

function malformed(label: string, detail: string): ScopeObserverError {
  return new ScopeObserverError(
    "RUNNER_SCOPE_STATUS_MALFORMED",
    `git ${label} ${detail}`,
    "GIT_OBSERVER",
  );
}

/**
 * `for-each-ref` has no `-z` mode: the closest safe shape is NUL between fields
 * with one LF terminating each record, so the LF is part of the grammar and is
 * validated rather than trimmed. Every field is required, the trailing NUL
 * before the LF is required, and anything outside refs/heads or refs/remotes is
 * a malformed observation rather than a silently dropped row — a parser that
 * skips what it does not recognise cannot tell a scope change from a bug.
 */
export function parseRefListing(bytes: Uint8Array, label: string): GitRefListing {
  const text = decodeUtf8Ref(bytes, label);
  const refs: GitRefObservation[] = [];
  const seen = new Set<string>();
  if (text.length > 0) {
    if (!text.endsWith("\n")) {
      throw malformed(label, "output is not LF-terminated");
    }
    for (const line of text.slice(0, -1).split("\n")) {
      refs.push(parseRecord(line, label, seen));
    }
  }
  refs.sort((left, right) =>
    left.refName < right.refName ? -1 : left.refName > right.refName ? 1 : 0,
  );
  return Object.freeze({
    refs: Object.freeze(refs),
    refCount: refs.length,
    observationDigest: digestRefs(refs),
  });
}

function parseRecord(line: string, label: string, seen: Set<string>): GitRefObservation {
  const fields = line.split("\0");
  if (fields.length !== 4 || fields[3] !== "") {
    throw malformed(label, "record does not carry exactly three NUL-framed fields");
  }
  const [refName, targetCommit, objectType] = fields as [string, string, string, string];
  if (!REF_SCOPES.some((scope) => refName.startsWith(scope))) {
    throw malformed(label, "record names a ref outside refs/heads and refs/remotes");
  }
  if (objectType !== "commit") {
    throw malformed(label, "record target is not a commit");
  }
  if (!LOWERCASE_COMMIT.test(targetCommit)) {
    throw malformed(label, "record target is not a lowercase 40- or 64-hex commit");
  }
  if (seen.has(refName)) {
    throw malformed(label, "output repeats a ref name");
  }
  seen.add(refName);
  return Object.freeze({ refName, targetCommit });
}

function decodeUtf8Ref(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw malformed(label, "output is not valid UTF-8");
  }
}

/** Length-framed so no ref name can forge a field boundary inside the digest. */
function digestRefs(refs: readonly GitRefObservation[]): string {
  const canonical = ["MOE-GIT-REFS/1", `N${refs.length}`];
  for (const ref of refs) {
    canonical.push(`${ref.refName.length}:${ref.refName}${ref.targetCommit}`);
  }
  return createHash("sha256").update(canonical.join("\n"), "utf8").digest("hex");
}
