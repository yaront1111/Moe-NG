import { exactGate1Row, gate1Text } from "./gate1-data-snapshot.js";

type Row = Readonly<Record<string, unknown>>;

export interface Gate1Refusal {
  readonly code: string;
  readonly layer: string;
}

const refused = (code: string, layer: string): Gate1Refusal => Object.freeze({ code, layer });

/** Preserves the exact daemon layer for every snapshotted refusal envelope this route emits. */
export function gate1RefusalFromSnapshot(status: number, value: unknown): Gate1Refusal | null {
  const route = exactGate1Row(value, ["code", "layer", "outcome"]);
  if (status === 200 && route !== null && route["outcome"] === "REFUSED"
    && gate1Text(route["code"]) && gate1Text(route["layer"])) {
    return refused(route["code"], route["layer"]);
  }
  const listener = exactGate1Row(value, ["code", "layer"]);
  if (status !== 200 && listener !== null
    && gate1Text(listener["code"]) && gate1Text(listener["layer"])) {
    return refused(listener["code"], listener["layer"]);
  }
  const port = exactGate1Row(value, ["httpStatus", "ok", "outcome", "refusal", "stage"]);
  const portRefusal = port === null ? null : exactGate1Row(
    port["refusal"], ["code", "detail", "httpStatus", "layer"],
  );
  if (status !== 200 && port !== null && portRefusal !== null
    && port["httpStatus"] === status && port["ok"] === false
    && port["outcome"] === "PORT_REFUSED" && gate1Text(port["stage"])
    && portRefusal["httpStatus"] === status && gate1Text(portRefusal["code"])
    && gate1Text(portRefusal["detail"]) && gate1Text(portRefusal["layer"])) {
    return refused(portRefusal["code"], portRefusal["layer"]);
  }
  const http = exactGate1Row(value, ["error", "httpStatus", "ok", "outcome", "stage"]);
  const runtimeError = http !== null && typeof http["error"] === "object"
    && http["error"] !== null && !Array.isArray(http["error"])
    ? http["error"] as Row : null;
  if (status !== 200 && http !== null && runtimeError !== null
    && http["httpStatus"] === status && http["ok"] === false
    && http["outcome"] === "REFUSED" && gate1Text(http["stage"])
    && gate1Text(runtimeError["code"])) {
    return refused(runtimeError["code"], http["stage"]);
  }
  return null;
}
