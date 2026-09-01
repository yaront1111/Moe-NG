import {
  FROZEN_GATE_IDS, FROZEN_OUT_OF_LADDER_GATE_IDS, FROZEN_RUNG_GATE_INVENTORY, FROZEN_RUNG_IDS,
  FROZEN_UMBRELLA_GATE_IDS,
} from "./pre-freeze-audit-rosters.js";
import {
  type PreFreezeAuditRefusal, type PreFreezeAuditVerdict, preFreezeAuditRefusal,
  preFreezeAuditVerdict,
} from "./pre-freeze-audit-vocabulary.js";
import type { PinnedSource } from "./pre-freeze-source-reader.js";

/**
 * DoD 2 (a) and (b) — THE RUNG→GATE INVENTORY AND THREE-VALUED HANDLING.
 *
 * Spec 12.1 item 3 demands that "every rung's decision rule and the Section 12 inventory
 * list the identical gate set". Those are two independently written places in the
 * document, so this is a genuine cross-section check rather than a comparison of a scan
 * with itself — and the hand-transcribed roster is a THIRD side, which is what stops a
 * revision that deletes a gate from both places from passing quietly.
 *
 * WHY THE VERDICT RESOLVER LIVES HERE AND NOT ONLY IN THE DOCUMENT CHECK. Spec:85 states
 * the rule the report must obey: "Absence-of-evidence ⇒ UNKNOWN; evidence-of-defect ⇒
 * FAIL. Precedence when both co-occur: FAIL dominates." Grepping the sentence proves the
 * document SAYS it. `resolveRungVerdict` is the production surface that DOES it, so a
 * consumer computing a rung verdict cannot re-derive a softer rule of its own — and a
 * mutation that lets UNKNOWN dominate FAIL reddens against behaviour rather than prose.
 */

export const TRIVALENT_VERDICTS = Object.freeze(["PASS", "FAIL", "UNKNOWN"] as const);
export type GateVerdict = (typeof TRIVALENT_VERDICTS)[number];

/**
 * FAIL dominates; UNKNOWN can never become PASS; an empty rung is UNKNOWN, never PASS.
 * The empty case is not a formality — a cohort or inventory that produced no verdicts is
 * exactly the "missing member verdict" spec 12.1 item 2 says must make a rung UNKNOWN
 * "never silently PASS", and `[].every(isPass)` is `true`, which is how that defect gets
 * written by accident.
 */
export const resolveRungVerdict = (verdicts: readonly GateVerdict[]): GateVerdict => {
  if (verdicts.includes("FAIL")) return "FAIL";
  if (verdicts.length === 0 || verdicts.includes("UNKNOWN")) return "UNKNOWN";
  return "PASS";
};

export type RungGateSet = {
  readonly gates: readonly string[];
  readonly line: number;
  readonly positional: readonly string[];
  readonly rung: string;
};

export type GateDefinition = {
  readonly body: string;
  readonly gateId: string;
  readonly indexed: boolean;
  readonly line: number;
};

export type ReportBlock = {
  readonly gateDefinitions: readonly GateDefinition[];
  readonly inventories: readonly RungGateSet[];
  readonly ladder: readonly RungGateSet[];
  readonly source: PinnedSource;
};

export const isReportBlock = (
  value: ReportBlock | PreFreezeAuditRefusal,
): value is ReportBlock => !("code" in value);

const GATE_TOKEN = /G-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g;
const SECTION_TOKEN = /Section \d+(?:\.\d+)*/g;
const LADDER_ROW = /^\|\s*\*\*(L[1-5])\s/;
const INVENTORY_ROW = /^\s{2}(L[1-5]):\s*(.*)$/;
const GATE_RULE = /^\s{2}(G-[A-Za-z0-9-]+?)(\[m\])?\s*\.*\s*\{(.*)\}\s*$/;
const BACK_REFERENCE = /\(L([1-5]) gates\)/g;
const isUmbrella = (id: string): boolean =>
  (FROZEN_UMBRELLA_GATE_IDS as readonly string[]).includes(id);

/**
 * Strips every bracket group EXCEPT the `[m]` member index. The annotations that must go
 * are `[umbrella alias G-L4 == AND of these over all m]` and `[G-expand is out-of-ladder]`,
 * both of which name a gate that is deliberately NOT a member of the inventory they
 * annotate. Keeping them would make the umbrella its own member and wire `G-expand` into
 * L5, and the comparison would then be against a set the document never claimed.
 */
const stripAnnotations = (text: string): string =>
  text.replace(/\[([^\]]*)\]/g, (whole, inner: string) => (inner === "m" ? whole : " "));

const readRungGateSet = (rung: string, line: number, text: string): RungGateSet => {
  const stripped = stripAnnotations(text);
  return {
    gates: Object.freeze(
      [...new Set(stripped.match(GATE_TOKEN) ?? [])].filter((id) => !isUmbrella(id)),
    ),
    line,
    positional: Object.freeze([...new Set(stripped.match(SECTION_TOKEN) ?? [])]),
    rung,
  };
};

export const parseReportBlock = (
  source: PinnedSource,
): ReportBlock | PreFreezeAuditRefusal => {
  const ladder: RungGateSet[] = [];
  const inventories: RungGateSet[] = [];
  const gateDefinitions: GateDefinition[] = [];
  const cumulative = new Map<string, readonly string[]>();
  source.lines.forEach((text, index) => {
    const line = index + 1;
    const ladderRow = LADDER_ROW.exec(text);
    if (ladderRow) ladder.push(readRungGateSet(ladderRow[1] as string, line, text));
    const inventoryRow = INVENTORY_ROW.exec(text);
    if (inventoryRow) {
      const rung = inventoryRow[1] as string;
      const body = (inventoryRow[2] as string).replace(
        BACK_REFERENCE,
        (_whole, referenced: string) => ` ${(cumulative.get(`L${referenced}`) ?? []).join(" ")} `,
      );
      const parsed = readRungGateSet(rung, line, body);
      cumulative.set(rung, parsed.gates);
      inventories.push(parsed);
    }
    const rule = GATE_RULE.exec(text);
    if (rule) {
      gateDefinitions.push({
        body: rule[3] as string, gateId: rule[1] as string, indexed: rule[2] !== undefined, line,
      });
    }
  });
  if (ladder.length !== FROZEN_RUNG_IDS.length || inventories.length !== FROZEN_RUNG_IDS.length
    || gateDefinitions.length === 0) {
    return preFreezeAuditRefusal("SPEC_UNPARSEABLE", 0, "rung ladder / inventory / gate rules");
  }
  return Object.freeze({
    gateDefinitions: Object.freeze(gateDefinitions),
    inventories: Object.freeze(inventories),
    ladder: Object.freeze(ladder),
    source,
  });
};

export type GateInventoryReport = PreFreezeAuditVerdict & {
  readonly gateDefinitionCases: number;
  readonly rungCases: number;
  readonly trivalentCases: number;
};

/** The Section 1 ladder is written per-rung; spec:81 makes it cumulative down the ladder. */
const cumulativeLadder = (ladder: readonly RungGateSet[]): ReadonlyMap<string, Set<string>> => {
  const closure = new Map<string, Set<string>>();
  const running = new Set<string>();
  for (const rung of ladder) {
    for (const gate of rung.gates) running.add(gate);
    closure.set(rung.rung, new Set(running));
  }
  return closure;
};

const sameSet = (left: Iterable<string>, right: Iterable<string>): boolean => {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
};

const auditRungs = (block: ReportBlock, refusals: PreFreezeAuditRefusal[]): number => {
  const closure = cumulativeLadder(block.ladder);
  for (const inventory of block.inventories) {
    const rung = inventory.rung as keyof typeof FROZEN_RUNG_GATE_INVENTORY;
    const transcribed = FROZEN_RUNG_GATE_INVENTORY[rung] ?? [];
    for (const pointer of inventory.positional) {
      refusals.push(preFreezeAuditRefusal("GATE_INVENTORY_MISMATCH", inventory.line, pointer));
    }
    if (!sameSet(inventory.gates, transcribed) || !sameSet(closure.get(rung) ?? [], transcribed)) {
      refusals.push(preFreezeAuditRefusal("GATE_INVENTORY_MISMATCH", inventory.line, rung));
    }
    for (const gate of [...inventory.gates, ...(closure.get(rung) ?? [])]) {
      if (!(FROZEN_GATE_IDS as readonly string[]).includes(gate)) {
        refusals.push(preFreezeAuditRefusal("GATE_INVENTORY_MISMATCH", inventory.line, gate));
      }
    }
  }
  const wired = new Set(block.inventories.flatMap((inventory) => [...inventory.gates]));
  for (const definition of block.gateDefinitions) {
    const exempt = isUmbrella(definition.gateId)
      || (FROZEN_OUT_OF_LADDER_GATE_IDS as readonly string[]).includes(definition.gateId);
    if (!exempt && !wired.has(definition.gateId)) {
      refusals.push(
        preFreezeAuditRefusal("GATE_INVENTORY_MISMATCH", definition.line, definition.gateId),
      );
    }
  }
  return block.inventories.length;
};

/**
 * The four clauses that together make PASS/FAIL/UNKNOWN exhaustive rather than merely
 * mentioned. Each is a separate case so a deletion names which clause went missing, and
 * each has its own arm — a single "the document says something about UNKNOWN" check would
 * survive losing any three of them.
 */
const TRIVALENT_CLAUSES = Object.freeze([
  { pattern: /GATE RESULTS[\s\S]*PASS\/FAIL\/UNKNOWN/, token: "PASS/FAIL/UNKNOWN domain" },
  { pattern: /any\s+`?UNKNOWN`?\s*(?:->|⇒|→)\s*`?UNKNOWN`?/i, token: "any UNKNOWN arm" },
  { pattern: /any\s+`?FAIL`?\s*(?:->|⇒|→)\s*`?FAIL`?/i, token: "any FAIL arm" },
  { pattern: /FAIL dominates/, token: "FAIL-dominates precedence" },
  { pattern: /never\s+(?:silently\s+)?`?PASS`?/i, token: "never-PASS guard" },
] as const);

const auditTrivalence = (block: ReportBlock, refusals: PreFreezeAuditRefusal[]): number => {
  const { text } = block.source;
  for (const clause of TRIVALENT_CLAUSES) {
    if (!clause.pattern.test(text)) {
      refusals.push(preFreezeAuditRefusal("TRIVALENT_INCOMPLETE", 0, clause.token));
    }
  }
  return TRIVALENT_CLAUSES.length;
};

export const auditGateInventory = (source: PinnedSource): GateInventoryReport => {
  const block = parseReportBlock(source);
  if (!isReportBlock(block)) {
    return Object.freeze({
      ...preFreezeAuditVerdict(0, [block]),
      gateDefinitionCases: 0, rungCases: 0, trivalentCases: 0,
    });
  }
  const refusals: PreFreezeAuditRefusal[] = [];
  const rungCases = auditRungs(block, refusals);
  const trivalentCases = auditTrivalence(block, refusals);
  const gateDefinitionCases = block.gateDefinitions.length;
  return Object.freeze({
    ...preFreezeAuditVerdict(rungCases + trivalentCases + gateDefinitionCases, refusals),
    gateDefinitionCases, rungCases, trivalentCases,
  });
};
