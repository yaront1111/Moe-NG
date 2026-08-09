/**
 * The pure half of the doctor's version report: vocabulary, shape and comparison.
 * Nothing here reads a process, a file or a clock — the host half hands values in.
 *
 * The shape carries the guarantee. `ObservedValue` is a two-arm union, so a value
 * the host could not read is PRESENT, typed and coded: never omitted, never
 * defaulted, never mistakable for a satisfied pin. Declared and observed stay
 * SEPARATE on every verdict, since a merged result cannot distinguish a satisfied
 * pin from an unread one. Two layers, because two things can decline to answer:
 * the host reader under DOCTOR_VERSION_HOST when a file or tool yields nothing,
 * this comparator under DOCTOR_VERSION when it cannot interpret a string.
 */
export const DOCTOR_VERSION_REPORT_VERSION = "moe-doctor-version-report/1" as const;

export const DOCTOR_VERSION_LAYERS = Object.freeze([
  "DOCTOR_VERSION",
  "DOCTOR_VERSION_HOST",
] as const);
export type DoctorVersionLayer = (typeof DOCTOR_VERSION_LAYERS)[number];

export const PIN_VERDICTS = Object.freeze(["SATISFIED", "MISMATCHED", "UNKNOWN"] as const);
export type PinVerdict = (typeof PIN_VERDICTS)[number];

export const VERSION_PIN_KINDS = Object.freeze([
  "NODE_RUNTIME",
  "PNPM_TOOL",
  "ENGINES_NODE",
  "ENGINES_PNPM",
] as const);
export type VersionPinKind = (typeof VERSION_PIN_KINDS)[number];

/**
 * Spread into DOCTOR_ERROR_CODES rather than restated there, so the two cannot
 * drift. The tests close the other direction: a declared code nothing emits is dead.
 */
export const DOCTOR_VERSION_ERROR_CODES = Object.freeze([
  "DOCTOR_VERSION_REPORT_ABSENT",
  "DOCTOR_RUNTIME_VERSION_UNREADABLE",
  "DOCTOR_TOOL_VERSION_UNREADABLE",
  "DOCTOR_DECLARED_PIN_UNREADABLE",
  "DOCTOR_COMPONENT_INVENTORY_EMPTY",
  "DOCTOR_PIN_RANGE_UNSUPPORTED",
] as const);
export type DoctorVersionErrorCode = (typeof DOCTOR_VERSION_ERROR_CODES)[number];

export type ObservedValue =
  | { readonly known: true; readonly value: string }
  | {
      readonly known: false;
      readonly code: DoctorVersionErrorCode;
      readonly layer: DoctorVersionLayer;
    };

export interface VersionPinVerdict {
  readonly pin: VersionPinKind;
  readonly declared: ObservedValue;
  readonly observed: ObservedValue;
  readonly verdict: PinVerdict;
}

export interface ComponentEntry {
  readonly name: string;
  readonly version: ObservedValue;
}

export interface DoctorVersionReport {
  readonly reportVersion: typeof DOCTOR_VERSION_REPORT_VERSION;
  readonly observed: {
    readonly node: ObservedValue;
    readonly pnpm: ObservedValue;
    readonly platform: ObservedValue;
    readonly arch: ObservedValue;
  };
  readonly declared: {
    readonly nodeVersionFile: ObservedValue;
    readonly packageManager: ObservedValue;
    readonly enginesNode: ObservedValue;
    readonly enginesPnpm: ObservedValue;
  };
  readonly pins: readonly VersionPinVerdict[];
  readonly components: readonly ComponentEntry[];
  readonly componentCount: number;
  /** Could the sweep run at all (DoD 3)? Else "found zero" and "could not look" collide. */
  readonly componentInventory: ObservedValue;
}

/**
 * Declared here so `doctor-commands.ts` gains a type import, not a full interface
 * — it starts at 229 against a 250 cap. `kind` is the literal, not
 * `DoctorCommandKind`, which would close a type cycle for no gain.
 */
export interface DoctorVersionsReported {
  readonly ok: true;
  readonly outcome: "VERSIONS_REPORTED";
  readonly kind: "doctor.report_versions";
  readonly report: DoctorVersionReport;
  readonly appliesChange: false;
}

/** Success constructor, kept beside its type so the two cannot drift apart. */
export const versionsReported = (report: DoctorVersionReport): DoctorVersionsReported =>
  Object.freeze({
    ok: true,
    outcome: "VERSIONS_REPORTED",
    kind: "doctor.report_versions",
    report,
    appliesChange: false,
  });

export const known = (value: string): ObservedValue => Object.freeze({ known: true as const, value });

export const unknown = (code: DoctorVersionErrorCode, layer: DoctorVersionLayer): ObservedValue =>
  Object.freeze({ known: false as const, code, layer });

/**
 * `process.version` is `v24.16.0`; `.node-version` is `24.16.0\n`. Measured: without
 * BOTH normalisations NODE_RUNTIME reads MISMATCHED on a correct host. Absorbs CRLF.
 */
const normalize = (raw: string): string => raw.trim().replace(/^v/, "");

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** `[major, minor, patch]`, or null when the string is not an exact version. */
function parseVersion(raw: string): readonly [number, number, number] | null {
  const match = SEMVER.exec(normalize(raw));
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const compareVersions = (
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number => left[0] - right[0] || left[1] - right[1] || left[2] - right[2];

/**
 * A deliberately NARROW grammar — `>=<exact> <partial>`, what `engines.node`
 * actually declares. Anything else is refused as unsupported rather than guessed:
 * a range compared by string equality reads MISMATCHED forever.
 */
const RANGE = /^>=(\d+)\.(\d+)\.(\d+)\s+<(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

function satisfiesRange(range: string, observed: string): boolean | null {
  const match = RANGE.exec(range.trim());
  const version = parseVersion(observed);
  if (match === null || version === null) return null;
  const lower = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  const upper = [Number(match[4]), Number(match[5] ?? 0), Number(match[6] ?? 0)] as const;
  return compareVersions(version, lower) >= 0 && compareVersions(version, upper) < 0;
}

/**
 * A missing observation is not a disagreement: when either side is unknown the
 * verdict is UNKNOWN — never SATISFIED, so an unreadable value cannot pass as a
 * met pin, and never MISMATCHED, which would blame a host that could not look.
 */
export function comparePin(
  pin: VersionPinKind,
  declared: ObservedValue,
  observed: ObservedValue,
): VersionPinVerdict {
  if (!declared.known || !observed.known) {
    return Object.freeze({ pin, declared, observed, verdict: "UNKNOWN" as const });
  }
  const left = normalize(declared.value);
  const right = normalize(observed.value);
  // A blank is absence wearing a value's clothes. Every reader here refuses one, but
  // this function is exported, so two blanks must not compare SATISFIED for a caller.
  if (left === "" || right === "") {
    return Object.freeze({ pin, declared, observed, verdict: "UNKNOWN" as const });
  }
  return Object.freeze({ pin, declared, observed, verdict: left === right ? "SATISFIED" : "MISMATCHED" });
}

/**
 * The range counterpart. An unsupported range becomes a DECLARED value this layer
 * could not interpret, so the code and refusing layer travel with the pin rather
 * than flattening into a bare UNKNOWN verdict.
 */
export function compareRangePin(
  pin: VersionPinKind,
  declared: ObservedValue,
  observed: ObservedValue,
): VersionPinVerdict {
  if (!declared.known || !observed.known) {
    return Object.freeze({ pin, declared, observed, verdict: "UNKNOWN" as const });
  }
  const satisfied = satisfiesRange(declared.value, observed.value);
  if (satisfied === null) {
    return Object.freeze({
      pin,
      declared: unknown("DOCTOR_PIN_RANGE_UNSUPPORTED", "DOCTOR_VERSION"),
      observed,
      verdict: "UNKNOWN" as const,
    });
  }
  return Object.freeze({ pin, declared, observed, verdict: satisfied ? "SATISFIED" : "MISMATCHED" });
}

/** `pnpm@11.0.8` is a name AND a version; the pin compares only the version half. */
export function packageManagerVersion(declared: ObservedValue): ObservedValue {
  if (!declared.known) return declared;
  const at = declared.value.lastIndexOf("@");
  if (at <= 0 || at === declared.value.length - 1) {
    return unknown("DOCTOR_DECLARED_PIN_UNREADABLE", "DOCTOR_VERSION");
  }
  return known(declared.value.slice(at + 1));
}

export interface DoctorVersionReportInput {
  readonly observed: DoctorVersionReport["observed"];
  readonly declared: DoctorVersionReport["declared"];
  readonly components: readonly ComponentEntry[];
  readonly componentInventory: ObservedValue;
}

/**
 * `componentCount` is DERIVED from the array rather than supplied alongside it,
 * so a report cannot claim a sweep it did not perform. DoD 4's positive-count
 * assertion is only meaningful if the count and the array cannot disagree.
 */
const freezeGroup = <T extends Readonly<Record<string, ObservedValue>>>(group: T): T => {
  for (const value of Object.values(group)) Object.freeze(value);
  return Object.freeze(group);
};

export function buildDoctorVersionReport(input: DoctorVersionReportInput): DoctorVersionReport {
  // Freeze the two groups BEFORE building pins, so the values the verdicts alias
  // are already frozen — a verdict frozen around a mutable value is not frozen.
  const observed = freezeGroup({ ...input.observed });
  const declared = freezeGroup({ ...input.declared });
  const components = input.components.map((entry) =>
    Object.freeze({ name: entry.name, version: Object.freeze(entry.version) }),
  );
  const pins: readonly VersionPinVerdict[] = [
    comparePin("NODE_RUNTIME", declared.nodeVersionFile, observed.node),
    comparePin("PNPM_TOOL", packageManagerVersion(declared.packageManager), observed.pnpm),
    compareRangePin("ENGINES_NODE", declared.enginesNode, observed.node),
    comparePin("ENGINES_PNPM", declared.enginesPnpm, observed.pnpm),
  ];
  return Object.freeze({
    reportVersion: DOCTOR_VERSION_REPORT_VERSION,
    observed,
    declared,
    pins: Object.freeze(pins),
    components: Object.freeze(components),
    componentCount: components.length,
    componentInventory: Object.freeze(input.componentInventory),
  });
}
