# "It never read the payload" does not prove "it never allocated for it"

Found 2026-08-10 while running the required mutation drill on task-14ab762db8
(broker bounded framing). The plan's own suggested proof was the weak one.

## The setup

DoD: an over-limit frame must be refused "WITHOUT allocating to the declared
size". The obvious test instruments the channel and asserts the reader stopped
at the header:

```rust
assert_eq!(error.reason(), ProtocolReason::LengthOverLimit);
assert_eq!(channel.bytes_read(), FRAME_HEADER_BYTES);
```

## Why it is not the property you wanted

Mutate the codec to allocate BEFORE bounds-checking but still check before
reading:

```rust
let mut payload = vec![0u8; declared as usize];   // 4 GiB
if declared > cap { return Err(LengthOverLimit); }  // still first
```

`bytes_read` is still 6. The reason is still `LengthOverLimit`. The test is
GREEN. Four gigabytes were committed. The assertion measures reads, and the
threat is allocation — two different things that happen to coincide in the
correct implementation and diverge in exactly the buggy one.

## What actually asserts it

A counting `#[global_allocator]` in the test binary:

```rust
static ALLOCATED: AtomicUsize = AtomicUsize::new(0);
struct Counting;
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 { ALLOCATED.fetch_add(l.size(), Relaxed); unsafe { System.alloc(l) } }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 { ALLOCATED.fetch_add(l.size(), Relaxed); unsafe { System.alloc_zeroed(l) } }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 { ALLOCATED.fetch_add(n, Relaxed); unsafe { System.realloc(p, l, n) } }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) { unsafe { System.dealloc(p, l) } }
}
#[global_allocator] static A: Counting = Counting;
```

`alloc_zeroed` is the one that matters: `vec![0u8; n]` goes there, not `alloc`.
Miss it and the counter reads zero for the exact case under test.

The drill then reddens with the real number:
`refusing an over-limit frame allocated 4295033325 bytes against a declared 4294967287`.

## Caveats worth writing down

- The counter is process-wide and cargo runs tests threaded, so assert an UPPER
  BOUND, not a delta. 1 MiB was three orders of magnitude above anything else
  that binary allocates and ~4000x below the regression.
- Do NOT expect the mutant to OOM-abort as your detector. On 64-bit Windows a
  4 GiB `alloc_zeroed` frequently SUCCEEDS. "It would exhaust memory" is not a
  test; the counter is.
- One `#[global_allocator]` per test binary; integration tests are separate
  binaries so this does not leak into others or into production.

Generalisation: whenever a DoD says "without doing X", check whether your
assertion measures X or measures something merely correlated with X. See
`mem:guard-premise-detaches-while-green` for the same shape in a different
disguise.
