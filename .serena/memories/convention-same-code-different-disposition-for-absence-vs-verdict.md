# When the code tuple is closed: carry the distinction in the DISPOSITION

`FairnessContractIssueCode` (`packages/scheduler/src/fairness/fairness-contract.ts:43-53`) is a
closed union over a frozen 18-member tuple, and `makeFairnessIssue` / `refuseFairness` /
`unknownFairness` all take that type. A CONSUMER module therefore **cannot mint a code** — not by
convention, structurally. Confirm this before planning "I'll add a code for X".

The escape is the three-disposition design (`:65-77`): `REFUSED` is a verdict (the value is wrong),
`UNKNOWN` is the absence of one (the value is representable but an input needed to classify it was
never supplied, and `unknownFairness` FORCES you to name that input).

## The pattern
Two genuinely different faults can share one code when the disposition separates them:

```ts
// MISSING record -> an absence. Names the exact input that would settle it.
unknownFairness("FAIRNESS_CONTRACT_UNDECLARED_RESOURCE", "RESOURCE",
  `capacities[${declared.resourceId}]`, [declared.resourceId]);

// EXTRA record -> a verdict. The ring does not declare that resource.
refuseRotation("FAIRNESS_CONTRACT_UNDECLARED_RESOURCE", "RESOURCE",
  "a capacity record names a resource the ring does not declare", [id]);
```

Both are `ok: false` with the same code; `disposition` is the discriminator. The same pair also
distinguishes both from `fairness-ring.ts`'s RING-layer REFUSED under that identical code — so
**(code, layer, disposition)** is the real key, not the code alone.

## Consequence for tests (epic rail 6)
A test asserting only `issue.code` passes on either arm. Assert the disposition SEPARATELY:

```ts
expect((result as FairnessContractRefusal).disposition).toBe("UNKNOWN");
expect(issue.code).toBe("FAIRNESS_CONTRACT_UNDECLARED_RESOURCE");
expect(issue.layer).toBe("RESOURCE");
expect(issue.missingInput).toBe("capacities[res.b]");
```

## Mint only when the tuple genuinely cannot express it
Two mappings on task-10cab3e5 were stretched and each says so at the call site: the pair above, and
`DISPATCHABILITY_UNOBSERVED` used for "the forced head is NOT dispatchable" (it is the only
dispatchability member of the tuple, so it carries both meanings and the message separates them).
Say which in a comment; do not let a stretched mapping pass silently.
