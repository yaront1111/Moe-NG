import {
  MAX_JSON_STRING_UTF8_BYTES,
  RUNTIME_COMMAND_KINDS,
  RUNTIME_QUERY_KINDS,
  RUNTIME_TELEMETRY_KINDS,
} from "@moe/contracts";
import { describe, expect, it } from "vitest";

import {
  ADAPTER_SUPPLIED_COMMAND_FIELDS,
  ADAPTER_SUPPLIED_QUERY_FIELDS,
  STDIO_TOOL_ENTRIES,
  STDIO_TOOL_INDEX,
  STDIO_TOOL_LABEL_PATTERN,
  generateStdioToolEntries,
  toolLabelForKind,
} from "./stdio-tool-schemas.js";
import type { StdioToolEntry } from "./stdio-tool-schemas.js";

/** Property names that must never reach an MCP client, whose logs capture tool args. */
const CREDENTIAL_BEARING = /credential|secret|password|token|bearer|api[_-]?key|digest/iu;

function collectPropertyNames(node: unknown, sink: Set<string>): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return;
  const record = node as Readonly<Record<string, unknown>>;
  const properties = record["properties"];
  if (properties !== null && typeof properties === "object") {
    for (const [name, child] of Object.entries(properties)) {
      sink.add(name);
      collectPropertyNames(child, sink);
    }
  }
  for (const key of ["items", "additionalProperties"]) {
    collectPropertyNames(record[key], sink);
  }
}

function entryFor(kind: string): StdioToolEntry {
  const entry = STDIO_TOOL_ENTRIES.find((candidate) => candidate.kind === kind);
  if (entry === undefined) throw new Error(`no generated tool for kind ${kind}`);
  return entry;
}

describe("stdio tool schema generation", () => {
  it("generates byte-identical output on repeated runs", () => {
    const first = JSON.stringify(generateStdioToolEntries());
    const second = JSON.stringify(generateStdioToolEntries());
    expect(second).toBe(first);
    expect(JSON.stringify(STDIO_TOOL_ENTRIES)).toBe(first);
  });

  it("covers every command and query kind exactly once with no extras", () => {
    const expected = [...RUNTIME_COMMAND_KINDS, ...RUNTIME_QUERY_KINDS].slice().sort();
    const actual = STDIO_TOOL_ENTRIES.map((entry) => entry.kind).slice().sort();
    expect(actual).toEqual(expected);
    expect(STDIO_TOOL_ENTRIES).toHaveLength(
      RUNTIME_COMMAND_KINDS.length + RUNTIME_QUERY_KINDS.length,
    );
  });

  it("marks each entry with the surface that matches its kind vocabulary", () => {
    const commands = STDIO_TOOL_ENTRIES.filter((entry) => entry.surface === "command");
    const queries = STDIO_TOOL_ENTRIES.filter((entry) => entry.surface === "query");
    expect(commands.map((entry) => entry.kind).slice().sort()).toEqual(
      RUNTIME_COMMAND_KINDS.slice().sort(),
    );
    expect(queries.map((entry) => entry.kind).slice().sort()).toEqual(
      RUNTIME_QUERY_KINDS.slice().sort(),
    );
  });

  it("exposes no telemetry kind through the tool surface", () => {
    const telemetry: readonly string[] = RUNTIME_TELEMETRY_KINDS;
    expect(STDIO_TOOL_ENTRIES.filter((entry) => telemetry.includes(entry.kind))).toEqual([]);
  });

  it("publishes events.resume exactly once as a generated command", () => {
    const matches = STDIO_TOOL_ENTRIES.filter((entry) => entry.kind === "events.resume");

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ kind: "events.resume", surface: "command" });
    expect(matches[0]?.tool.name).toBe("events_resume");
    expect(matches[0]?.tool.inputSchema).toBe(entryFor("goal.create").tool.inputSchema);
    expect(RUNTIME_QUERY_KINDS).not.toContain("events.resume");
    expect(RUNTIME_TELEMETRY_KINDS).not.toContain("events.resume");
  });

  it("publishes product_contract.approve_gate_1 exactly once as a generated command", () => {
    const kind = "product_contract.approve_gate_1";
    const matches = STDIO_TOOL_ENTRIES.filter((entry) => entry.kind === kind);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ kind, surface: "command" });
    expect(matches[0]?.tool.name).toBe("product_contract_approve_gate_1");
    expect(matches[0]?.tool.inputSchema).toBe(entryFor("goal.create").tool.inputSchema);
    expect(RUNTIME_QUERY_KINDS).not.toContain(kind);
    expect(RUNTIME_TELEMETRY_KINDS).not.toContain(kind);
  });
});

describe("stdio tool name mapping", () => {
  it("emits labels that satisfy the conservative client tool-name grammar", () => {
    for (const entry of STDIO_TOOL_ENTRIES) {
      expect(entry.tool.name).toMatch(STDIO_TOOL_LABEL_PATTERN);
      expect(entry.tool.name).not.toContain(".");
    }
  });

  it("maps dots to underscores bijectively across the full vocabulary", () => {
    const labels = new Set(STDIO_TOOL_ENTRIES.map((entry) => entry.tool.name));
    expect(labels.size).toBe(STDIO_TOOL_ENTRIES.length);
    expect(toolLabelForKind("goal.create")).toBe("goal_create");
    expect(toolLabelForKind("scheduler.readiness_explain")).toBe("scheduler_readiness_explain");
  });

  it("round-trips label to kind to label through the lookup index", () => {
    expect(STDIO_TOOL_INDEX.size).toBe(STDIO_TOOL_ENTRIES.length);
    for (const entry of STDIO_TOOL_ENTRIES) {
      const resolved = STDIO_TOOL_INDEX.get(entry.tool.name);
      expect(resolved?.kind).toBe(entry.kind);
      expect(toolLabelForKind(resolved?.kind ?? "")).toBe(entry.tool.name);
    }
  });

  it("carries the verbatim dotted kind in the tool description", () => {
    for (const entry of STDIO_TOOL_ENTRIES) {
      expect(entry.tool.description).toContain(entry.kind);
    }
  });
});

describe("stdio tool credential exclusion", () => {
  it("declares the adapter-supplied envelope fields it must never accept", () => {
    expect(ADAPTER_SUPPLIED_COMMAND_FIELDS).toEqual([
      "commandKind",
      "requestDigest",
      "schemaVersion",
      "sessionCredential",
    ]);
    expect(ADAPTER_SUPPLIED_QUERY_FIELDS).toEqual([
      "queryKind",
      "schemaVersion",
      "sessionCredential",
    ]);
  });

  it("exposes command inputs as envelope keys minus adapter-supplied fields", () => {
    const schema = entryFor("goal.create").tool.inputSchema;
    expect(Object.keys(schema.properties).slice().sort()).toEqual([
      "commandId",
      "correlationId",
      "expectedVersion",
      "graphRevisionHash",
      "leaseAuthority",
      "payload",
      "policyRevisionHash",
      "targetAggregateId",
    ]);
    expect(schema.required.slice().sort()).toEqual([
      "commandId",
      "correlationId",
      "expectedVersion",
      "payload",
      "targetAggregateId",
    ]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.type).toBe("object");
  });

  it("exposes query inputs as envelope keys minus adapter-supplied fields", () => {
    const schema = entryFor("goal.list").tool.inputSchema;
    expect(Object.keys(schema.properties).slice().sort()).toEqual([
      "correlationId",
      "cursor",
      "payload",
      "targetAggregateId",
    ]);
    expect(schema.required.slice().sort()).toEqual(["correlationId", "payload"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("names no credential-bearing property anywhere in any generated schema", () => {
    const offenders: string[] = [];
    for (const entry of STDIO_TOOL_ENTRIES) {
      const names = new Set<string>();
      collectPropertyNames(entry.tool.inputSchema, names);
      for (const name of names) {
        if (CREDENTIAL_BEARING.test(name)) offenders.push(`${entry.kind}.${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("stdio tool schema bounds", () => {
  it("bounds every generated string property within the decoder string limit", () => {
    const unbounded: string[] = [];
    for (const entry of STDIO_TOOL_ENTRIES) {
      for (const [name, property] of Object.entries(entry.tool.inputSchema.properties)) {
        if (property.type !== "string") continue;
        const withinLimit =
          Number.isSafeInteger(property.maxLength) &&
          property.maxLength >= 1 &&
          property.maxLength <= MAX_JSON_STRING_UTF8_BYTES;
        if (!withinLimit) unbounded.push(`${entry.kind}.${name}`);
      }
    }
    expect(unbounded).toEqual([]);
  });

  it("bounds the integer expectedVersion to the safe-count range the decoder accepts", () => {
    const property = entryFor("goal.create").tool.inputSchema.properties["expectedVersion"];
    expect(property).toEqual({
      description: expect.stringContaining("expectedVersion") as unknown as string,
      maximum: Number.MAX_SAFE_INTEGER,
      minimum: 0,
      type: "integer",
    });
  });

  it("keeps payload an opaque object until the M3 per-command schema pipeline lands", () => {
    for (const entry of STDIO_TOOL_ENTRIES) {
      const payload = entry.tool.inputSchema.properties["payload"];
      expect(payload?.type).toBe("object");
      expect(Object.hasOwn(payload ?? {}, "properties")).toBe(false);
    }
  });

  it("freezes every generated entry against downstream mutation", () => {
    const entry = STDIO_TOOL_ENTRIES[0];
    expect(entry).toBeDefined();
    expect(Object.isFrozen(STDIO_TOOL_ENTRIES)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry?.tool)).toBe(true);
    expect(Object.isFrozen(entry?.tool.inputSchema)).toBe(true);
    expect(Object.isFrozen(entry?.tool.inputSchema.properties)).toBe(true);
  });
});
