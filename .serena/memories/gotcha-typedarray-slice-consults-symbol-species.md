# A byte snapshot taken with `.slice()` runs caller code

Found on task-bcea7056 (`@moe/core` project-configuration codec), by the worker's own adversarial pass and re-proved by QA with a mutation drill.

A function whose entire contract is "never throws, only refuses" took its snapshot of caller-supplied bytes with:

```ts
const source = Uint8Array.prototype.slice.call(bytes);
```

`%TypedArray%.prototype.slice` consults `Symbol.species` on the constructor. A **genuine `Uint8Array` subclass** passes every internal-slot brand check a strict decoder can run — `@@toStringTag` returns `"Uint8Array"` for subclass instances because it reads `[[TypedArrayName]]`, and the `[[ArrayBufferData]]` / detached / SharedArrayBuffer probes all succeed. So the subclass reaches the snapshot, and then its species getter runs:

- a throwing getter throws straight out of the must-never-throw function;
- a species returning a longer buffer makes any later canonical-bytes comparison read bytes other than the ones actually decoded.

`bytes.slice()` is worse still: for a `Buffer`, `Buffer.prototype.slice` returns a **shared view**, so the "snapshot" aliases caller memory.

The safe form copies from internal slots and calls nothing the caller controls:

```ts
const source = new Uint8Array(bytes as Uint8Array);
```

## How to test it so the guard cannot rot back
Arm a real subclass and pair it with a CONTROL, or a green result proves only that the fixture was inert:

```ts
class SpeciesTrapBytes extends Uint8Array {
  static get [Symbol.species](): typeof Uint8Array { throw new Error("species trap"); }
}
expect(() => Uint8Array.prototype.slice.call(trapped)).toThrow("species trap"); // control
expect(decode(trapped).ok).toBe(true);                                          // subject
```

Drill confirms it: swapping `new Uint8Array(bytes)` back to `Uint8Array.prototype.slice.call(bytes)` reddens exactly that one test.

Related: `mem:gotcha-array-isarray-throws-on-revoked-proxy` — same family, a caller-controlled object running code inside a guard.
