/** Strict browser decoding shared by the operator evidence and recovery readers. */
export type EffectReadFailure = { readonly status: "ERROR" | "REFUSED"; readonly code: string; readonly layer: string };
export const effectText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;
export const effectCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const effectHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
export const effectSha = (value: unknown): value is string => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);

export function effectRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const proto = Object.getPrototypeOf(value); const own = Reflect.ownKeys(value);
    if ((proto !== null && proto !== Object.prototype) || own.length !== keys.length
      || own.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
      copy[key] = descriptor.value;
    }
    return Object.freeze(copy);
  } catch { return null; }
}

export function effectList<T>(value: unknown, decode: (item: unknown) => T | null, maximum = 256): readonly T[] | null {
  try {
    if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return null;
    const result: T[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) return null;
      const decoded = decode(descriptor.value); if (decoded === null) return null;
      result.push(decoded);
    }
    return Object.freeze(result);
  } catch { return null; }
}

export function effectOffer(value: unknown, kind: string): Readonly<Record<string, unknown>> | null {
  const offer = effectRecord(value, ["commandEnvelopeVersion", "commandId", "commandKind", "expectedVersion", "inputSchemaVersion", "targetAggregateId"]);
  return offer !== null && offer.commandEnvelopeVersion === "moe-runtime-command/1" && offer.commandKind === kind
    && effectText(offer.commandId) && effectText(offer.inputSchemaVersion) && effectText(offer.targetAggregateId)
    && effectCount(offer.expectedVersion) ? offer : null;
}

export function effectRefusal(value: unknown): EffectReadFailure | null {
  const direct = effectRecord(value, ["code", "layer"]) ?? effectRecord(value, ["outcome", "code", "layer"]);
  if (direct !== null && (direct.outcome === undefined || direct.outcome === "REFUSED")
    && effectText(direct.code) && effectText(direct.layer)) return { status: "REFUSED", code: direct.code, layer: direct.layer };
  for (const field of ["refusal", "error"] as const) {
    const outer = effectRecord(value, ["httpStatus", "ok", "outcome", field, "stage"]);
    if (outer === null || outer.ok !== false || !effectText(outer.stage)) continue;
    const nested = outer[field];
    if (typeof nested !== "object" || nested === null) continue;
    try {
      const code = Object.getOwnPropertyDescriptor(nested, "code");
      const layer = Object.getOwnPropertyDescriptor(nested, "layer");
      if (code !== undefined && "value" in code && effectText(code.value)) return { status: "REFUSED", code: code.value,
        layer: layer !== undefined && "value" in layer && effectText(layer.value) ? layer.value : outer.stage };
    } catch { return null; }
  }
  return null;
}

export async function readEffect<T>(headers: Readonly<Record<string, string>>, path: string,
  payload: Readonly<Record<string, unknown>>, map: (status: number, value: unknown) => T,
  layer: string, post?: (body: string) => Promise<Response>): Promise<T | EffectReadFailure> {
  let response: Response;
  try {
    const body = JSON.stringify(payload);
    response = await (post === undefined ? fetch(path, { body, headers, method: "POST", signal: AbortSignal.timeout(15_000) }) : post(body));
  } catch { return { status: "ERROR", code: "TRANSPORT_REQUEST_FAILED", layer }; }
  let body: unknown;
  try { body = await response.json(); } catch { return map(response.status, null); }
  return map(response.status, body);
}
