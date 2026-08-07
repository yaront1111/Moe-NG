import { describe, expect, it } from "vitest";

import {
  describeTruthClass,
  type TruthClass,
  type TruthPresentationDescriptor,
} from "@moe/control-room-model";

const expectedMappings = [
  {
    input: "OBSERVED",
    descriptor: {
      truthClass: "OBSERVED",
      glyph: "●",
      shortLabel: "OBS",
      semanticTone: "neutral slate",
      meaning: "Captured directly by Moe or the OS.",
      borderStyle: "solid",
      provenanceAffordance: "press Enter for provenance.",
      ariaLabel:
        "OBSERVED Captured directly by Moe or the OS. press Enter for provenance.",
      chipTestId: "cr.chip.observed",
    },
  },
  {
    input: "AGENT_REPORTED",
    descriptor: {
      truthClass: "AGENT_REPORTED",
      glyph: "💬",
      shortLabel: "AGT",
      semanticTone: "amber",
      meaning: "Asserted by an agent; not independently verified.",
      borderStyle: "solid",
      provenanceAffordance: "press Enter for provenance.",
      ariaLabel:
        "AGENT_REPORTED Asserted by an agent; not independently verified. press Enter for provenance.",
      chipTestId: "cr.chip.agent_reported",
    },
  },
  {
    input: "DAEMON_VERIFIED",
    descriptor: {
      truthClass: "DAEMON_VERIFIED",
      glyph: "▣",
      shortLabel: "VER",
      semanticTone: "green",
      meaning: "Produced by Moe's runner with a hash-bound receipt.",
      borderStyle: "solid",
      provenanceAffordance: "press Enter for provenance.",
      ariaLabel:
        "DAEMON_VERIFIED Produced by Moe's runner with a hash-bound receipt. press Enter for provenance.",
      chipTestId: "cr.chip.daemon_verified",
    },
  },
  {
    input: "HUMAN_APPROVED",
    descriptor: {
      truthClass: "HUMAN_APPROVED",
      glyph: "◉",
      shortLabel: "HUM",
      semanticTone: "blue",
      meaning: "Explicitly accepted by an authenticated human.",
      borderStyle: "solid",
      provenanceAffordance: "press Enter for provenance.",
      ariaLabel:
        "HUMAN_APPROVED Explicitly accepted by an authenticated human. press Enter for provenance.",
      chipTestId: "cr.chip.human_approved",
    },
  },
  {
    input: "UNKNOWN",
    descriptor: {
      truthClass: "UNKNOWN",
      glyph: "◇",
      shortLabel: "UNK",
      semanticTone: "high-contrast magenta",
      meaning: "Evidence is absent, corrupt, stale, or irreconcilable.",
      borderStyle: "dashed",
      provenanceAffordance: "press Enter for provenance.",
      ariaLabel:
        "UNKNOWN Evidence is absent, corrupt, stale, or irreconcilable. press Enter for provenance.",
      chipTestId: "cr.chip.unknown",
    },
  },
] as const satisfies readonly {
  readonly input: TruthClass;
  readonly descriptor: TruthPresentationDescriptor;
}[];

function mustDescribe(truthClass: TruthClass): TruthPresentationDescriptor {
  const result = describeTruthClass(truthClass);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected ${truthClass} to have a descriptor`);
  }
  return result.descriptor;
}

describe("truth presentation mappings", () => {
  it.each(expectedMappings)("maps $input exactly", ({ input, descriptor }) => {
    expect(describeTruthClass(input)).toEqual({ ok: true, descriptor });
  });

  it("returns byte-equivalent stable results for equivalent input", () => {
    for (const { input } of expectedMappings) {
      const first = describeTruthClass(input);
      const second = describeTruthClass(`${input}`);
      expect(second).toBe(first);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    }
  });

  it("makes UNKNOWN the only dashed and most distinct class", () => {
    const descriptors = expectedMappings.map(({ input }) => mustDescribe(input));
    expect(
      descriptors
        .filter(({ borderStyle }) => borderStyle === "dashed")
        .map(({ truthClass }) => truthClass),
    ).toEqual(["UNKNOWN"]);
    expect(new Set(descriptors.map(({ glyph }) => glyph)).size).toBe(5);
    expect(new Set(descriptors.map(({ shortLabel }) => shortLabel)).size).toBe(5);
    expect(
      new Set(
        descriptors.map(({ glyph, shortLabel, borderStyle }) =>
          JSON.stringify([glyph, shortLabel, borderStyle])
        ),
      ).size,
    ).toBe(5);
  });

  it("triple-encodes every class without making color the sole carrier", () => {
    for (const { input } of expectedMappings) {
      const descriptor = mustDescribe(input);
      expect(descriptor.glyph.length).toBeGreaterThan(0);
      expect(descriptor.shortLabel.length).toBe(3);
      expect(descriptor.semanticTone.length).toBeGreaterThan(0);
      expect(descriptor.ariaLabel).toContain(descriptor.truthClass);
      expect(descriptor.ariaLabel).toContain(descriptor.shortLabel === "UNK"
        ? "Evidence is absent"
        : descriptor.meaning);
    }
  });
});
