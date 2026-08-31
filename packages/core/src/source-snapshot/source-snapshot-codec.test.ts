import { createHash } from "node:crypto";

import * as core from "../index.js";
import { describe, expect, it } from "vitest";

const HEX_64 = (digit: string): string => digit.repeat(64);
const HEX_40 = (digit: string): string => digit.repeat(40);
const VERSION = "moe-source-snapshot/1";
const DOMAIN = "moe-source-snapshot-digest/1";

interface Draft {
  baseRevisionHash: string;
  projectId: string;
  repositoryBaseTree: string;
  repositoryRef: string;
  scopeRef: string;
}
interface Snapshot extends Draft {
  sourceSnapshotDigest: string;
  version: string;
}
interface Ref { projectId: string; sourceSnapshotDigest: string }
interface Refusal { code: string; layer: string; ok: false }
type Result = Refusal | Readonly<Record<string, unknown> & { ok: true }>;
type Api = Readonly<Record<string, unknown>> & {
  readonly SOURCE_SNAPSHOT_CODES?: readonly string[];
  readonly SOURCE_SNAPSHOT_DIGEST_DOMAIN?: string;
  readonly SOURCE_SNAPSHOT_LAYERS?: readonly string[];
  readonly SOURCE_SNAPSHOT_LIMITS?: Readonly<Record<string, number>>;
  readonly SOURCE_SNAPSHOT_REF_KEYS?: readonly string[];
  readonly SOURCE_SNAPSHOT_VERSION?: string;
};

const api = core as Api;
const draft = (): Draft => ({
  baseRevisionHash: HEX_64("a"),
  projectId: "project-a",
  repositoryBaseTree: HEX_40("b"),
  repositoryRef: "refs/heads/main",
  scopeRef: "services/api",
});

function invoke(name: string, input: unknown): Result {
  const candidate = api[name];
  return typeof candidate === "function"
    ? (candidate as (value: unknown) => Result)(input)
    : Object.freeze({ code: "SOURCE_SNAPSHOT_IMPLEMENTATION_MISSING",
      layer: "SOURCE_SNAPSHOT_IMPLEMENTATION", ok: false as const });
}
function create(input: unknown = draft()): Result { return invoke("createSourceSnapshot", input); }
function encode(input: unknown): Result { return invoke("encodeSourceSnapshot", input); }
function decode(input: unknown): Result { return invoke("decodeSourceSnapshotBytes", input); }
function derive(input: unknown): Result { return invoke("deriveSourceSnapshotDigest", input); }
function admitRef(input: unknown): Result { return invoke("admitSourceSnapshotRef", input); }

function snapshotOrThrow(input: unknown = draft()): Snapshot {
  const result = create(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result["snapshot"] as Snapshot;
}
function bytesOrThrow(input: unknown = snapshotOrThrow()): Uint8Array {
  const result = encode(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result["bytes"] as Uint8Array;
}
function expectRefusal(result: Result, code: string, layer: string): void {
  expect(result).toStrictEqual({ code, layer, ok: false });
  expect(Object.isFrozen(result)).toBe(true);
}
function deeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) return true;
  return Object.isFrozen(value) && Reflect.ownKeys(value).every(
    (key) => deeplyFrozen((value as Readonly<Record<PropertyKey, unknown>>)[key]),
  );
}

describe("source snapshot public contract", () => {
  it("publishes a closed stable vocabulary", () => {
    expect(api.SOURCE_SNAPSHOT_VERSION).toBe(VERSION);
    expect(api.SOURCE_SNAPSHOT_DIGEST_DOMAIN).toBe(DOMAIN);
    expect(api.SOURCE_SNAPSHOT_CODES).toStrictEqual([
      "SOURCE_SNAPSHOT_MALFORMED",
      "SOURCE_SNAPSHOT_VERSION_UNSUPPORTED",
      "SOURCE_SNAPSHOT_LIMIT_EXCEEDED",
      "SOURCE_SNAPSHOT_BYTES_INVALID",
      "SOURCE_SNAPSHOT_DUPLICATE_KEY",
      "SOURCE_SNAPSHOT_NONCANONICAL",
      "SOURCE_SNAPSHOT_DIGEST_MISMATCH",
    ]);
    expect(api.SOURCE_SNAPSHOT_LAYERS).toStrictEqual([
      "SOURCE_SNAPSHOT_ADMISSION",
      "SOURCE_SNAPSHOT_VERSION",
      "SOURCE_SNAPSHOT_LIMITS",
      "SOURCE_SNAPSHOT_CODEC",
      "SOURCE_SNAPSHOT_CANONICALIZATION",
      "SOURCE_SNAPSHOT_DIGEST",
    ]);
    expect(api.SOURCE_SNAPSHOT_LIMITS).toStrictEqual({
      maxBytes: 1_048_576, maxRefCodeUnits: 256,
    });
    expect(api.SOURCE_SNAPSHOT_REF_KEYS).toStrictEqual([
      "projectId", "sourceSnapshotDigest",
    ]);
    for (const value of [api.SOURCE_SNAPSHOT_CODES, api.SOURCE_SNAPSHOT_LAYERS,
      api.SOURCE_SNAPSHOT_LIMITS, api.SOURCE_SNAPSHOT_REF_KEYS]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it("creates the canonical immutable record and binds every material field", () => {
    const input = draft();
    const snapshot = snapshotOrThrow(input);
    const sourceText = JSON.stringify({
      baseRevisionHash: input.baseRevisionHash,
      projectId: input.projectId,
      repositoryBaseTree: input.repositoryBaseTree,
      repositoryRef: input.repositoryRef,
      scopeRef: input.scopeRef,
      version: VERSION,
    });
    const expectedDigest = createHash("sha256").update(DOMAIN, "utf8")
      .update(Uint8Array.of(0)).update(sourceText, "utf8").digest("hex");
    expect(expectedDigest).toBe("9eb1abeaac80f014c4048b91dde314f8c07f6b02565756f301eb7cc45625c2a2");
    expect(Object.keys(snapshot)).toStrictEqual([
      "baseRevisionHash", "projectId", "repositoryBaseTree", "repositoryRef", "scopeRef",
      "sourceSnapshotDigest", "version",
    ]);
    expect(snapshot).toStrictEqual({ ...input, sourceSnapshotDigest: expectedDigest,
      version: VERSION });
    expect(deeplyFrozen(snapshot)).toBe(true);
    expect(snapshotOrThrow(input)).toStrictEqual(snapshot);

    const variants: Draft[] = [
      { ...input, baseRevisionHash: HEX_64("c") },
      { ...input, projectId: "project-b" },
      { ...input, repositoryBaseTree: HEX_64("d") },
      { ...input, repositoryRef: "refs/tags/v2" },
      { ...input, scopeRef: "services/web" },
    ];
    expect(new Set(variants.map((value) => snapshotOrThrow(value).sourceSnapshotDigest)).size)
      .toBe(variants.length);
    expect(variants.every((value) => snapshotOrThrow(value).sourceSnapshotDigest
      !== snapshot.sourceSnapshotDigest)).toBe(true);

    input.projectId = "caller-mutated";
    expect(snapshot.projectId).toBe("project-a");
  });

  it("refuses every malformed or hostile draft without invoking accessors", () => {
    const { projectId: _removed, ...missing } = draft();
    const accessor = draft() as unknown as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(accessor, "projectId", { enumerable: true, get: () => {
      getterCalls += 1; return "forged";
    } });
    const symbol = draft() as unknown as Record<PropertyKey, unknown>;
    Object.defineProperty(symbol, Symbol("extra"), { enumerable: true, value: "x" });
    const nonenumerable = draft();
    Object.defineProperty(nonenumerable, "projectId", {
      enumerable: false, value: "project-a",
    });
    const revoked = Proxy.revocable(draft(), {}); revoked.revoke();
    const malformed: readonly unknown[] = [
      null, [], missing, { ...draft(), extra: true }, new Proxy(draft(), {}), revoked.proxy,
      accessor, symbol, nonenumerable, Object.assign(Object.create({ inherited: true }), draft()),
      { ...draft(), baseRevisionHash: HEX_64("A") },
      { ...draft(), baseRevisionHash: HEX_40("a") },
      { ...draft(), repositoryBaseTree: "b".repeat(39) },
      { ...draft(), repositoryBaseTree: "B".repeat(40) },
      { ...draft(), projectId: "" },
      { ...draft(), repositoryRef: "e\u0301" },
      { ...draft(), scopeRef: "bad\0ref" },
      { ...draft(), scopeRef: "\ud800" },
    ];
    expect(malformed).toHaveLength(18);
    for (const candidate of malformed) {
      expectRefusal(create(candidate), "SOURCE_SNAPSHOT_MALFORMED", "SOURCE_SNAPSHOT_ADMISSION");
    }
    expect(getterCalls).toBe(0);
    expect(snapshotOrThrow({ ...draft(), projectId: "é".repeat(256) }).projectId.length).toBe(256);
    expectRefusal(create({ ...draft(), projectId: "x".repeat(257) }),
      "SOURCE_SNAPSHOT_LIMIT_EXCEEDED", "SOURCE_SNAPSHOT_LIMITS");
  });

  it("encodes exact sorted-key bytes and refuses forged full records", () => {
    const snapshot = snapshotOrThrow();
    const bytes = bytesOrThrow(snapshot);
    expect(new TextDecoder().decode(bytes)).toBe(JSON.stringify(snapshot));
    expect(derive(snapshot)).toStrictEqual({ ok: true,
      sourceSnapshotDigest: snapshot.sourceSnapshotDigest });

    expectRefusal(encode({ ...snapshot, sourceSnapshotDigest: HEX_64("f") }),
      "SOURCE_SNAPSHOT_DIGEST_MISMATCH", "SOURCE_SNAPSHOT_DIGEST");
    expectRefusal(encode({ ...snapshot, version: "moe-source-snapshot/2" }),
      "SOURCE_SNAPSHOT_VERSION_UNSUPPORTED", "SOURCE_SNAPSHOT_VERSION");
    expectRefusal(encode({ ...snapshot, extra: true }),
      "SOURCE_SNAPSHOT_MALFORMED", "SOURCE_SNAPSHOT_ADMISSION");
    const { scopeRef: _scope, ...missing } = snapshot;
    expectRefusal(encode(missing), "SOURCE_SNAPSHOT_MALFORMED", "SOURCE_SNAPSHOT_ADMISSION");
  });

  it("decodes only bounded duplicate-free canonical bytes with a matching digest", () => {
    const snapshot = snapshotOrThrow();
    const text = new TextDecoder().decode(bytesOrThrow(snapshot));
    const roundTrip = decode(new TextEncoder().encode(text));
    expect(roundTrip).toStrictEqual({ ok: true, snapshot });
    expect(deeplyFrozen(roundTrip)).toBe(true);

    const duplicate = text.replace('"projectId":',
      '"\\u0070rojectId":"shadow","projectId":');
    expectRefusal(decode(new TextEncoder().encode(duplicate)),
      "SOURCE_SNAPSHOT_DUPLICATE_KEY", "SOURCE_SNAPSHOT_CODEC");
    expectRefusal(decode(new TextEncoder().encode(text.replace("{", "{ "))),
      "SOURCE_SNAPSHOT_NONCANONICAL", "SOURCE_SNAPSHOT_CANONICALIZATION");
    const reordered = JSON.stringify({
      projectId: snapshot.projectId, baseRevisionHash: snapshot.baseRevisionHash,
      repositoryBaseTree: snapshot.repositoryBaseTree, repositoryRef: snapshot.repositoryRef,
      scopeRef: snapshot.scopeRef, sourceSnapshotDigest: snapshot.sourceSnapshotDigest,
      version: snapshot.version,
    });
    expectRefusal(decode(new TextEncoder().encode(reordered)),
      "SOURCE_SNAPSHOT_NONCANONICAL", "SOURCE_SNAPSHOT_CANONICALIZATION");
    expectRefusal(decode(new TextEncoder().encode(text.replace(
      snapshot.sourceSnapshotDigest, HEX_64("f")))),
    "SOURCE_SNAPSHOT_DIGEST_MISMATCH", "SOURCE_SNAPSHOT_DIGEST");
    expectRefusal(decode("not bytes"),
      "SOURCE_SNAPSHOT_BYTES_INVALID", "SOURCE_SNAPSHOT_CODEC");
    expectRefusal(decode(new Proxy(bytesOrThrow(snapshot), {})),
      "SOURCE_SNAPSHOT_BYTES_INVALID", "SOURCE_SNAPSHOT_CODEC");
    expectRefusal(decode(Uint8Array.of(0xff)),
      "SOURCE_SNAPSHOT_BYTES_INVALID", "SOURCE_SNAPSHOT_CODEC");
    expectRefusal(decode(new Uint8Array(1_048_577)),
      "SOURCE_SNAPSHOT_LIMIT_EXCEEDED", "SOURCE_SNAPSHOT_LIMITS");
  });

  it("admits only the exact detached source snapshot reference", () => {
    const snapshot = snapshotOrThrow();
    const input: Ref = { projectId: snapshot.projectId,
      sourceSnapshotDigest: snapshot.sourceSnapshotDigest };
    const admitted = admitRef(input);
    expect(admitted).toStrictEqual({ ok: true, ref: input });
    expect(deeplyFrozen(admitted)).toBe(true);
    if (!admitted.ok) throw new Error(`${admitted.code}@${admitted.layer}`);
    input.projectId = "caller-mutated";
    expect((admitted["ref"] as Ref).projectId).toBe("project-a");

    for (const candidate of [
      snapshot,
      { projectId: "project-a" },
      { ...input, extra: true },
      { ...input, sourceSnapshotDigest: HEX_64("F") },
      { ...input, projectId: "" },
      { ...input, projectId: "e\u0301" },
      new Proxy({ ...input }, {}),
    ]) expectRefusal(admitRef(candidate),
      "SOURCE_SNAPSHOT_MALFORMED", "SOURCE_SNAPSHOT_ADMISSION");
    expectRefusal(admitRef({ ...input, projectId: "x".repeat(257) }),
      "SOURCE_SNAPSHOT_LIMIT_EXCEEDED", "SOURCE_SNAPSHOT_LIMITS");
  });
});
