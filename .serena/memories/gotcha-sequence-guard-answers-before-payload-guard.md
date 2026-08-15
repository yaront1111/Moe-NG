# A stateful protocol test can be answered by the state machine, not the decoder

Found 2026-08-10 on task-14ab762db8 (broker control layer). Caught by the exact
reason assertion; an `is_err()` assertion would have shipped it.

## The bug, in my own test

Intent: prove a CANCEL frame carrying a payload is refused as `TrailingBytes`,
because CANCEL has no field to hold one.

```rust
let outcome = offer(&mut AcceptState::new(), frame(Inbound::Cancel.opcode(), b"why"));
assert_refused(outcome, ProtocolReason::TrailingBytes, ProtocolStage::Control);
```

RED with `left: FrameOutOfOrder / right: TrailingBytes`. On a FRESH state a
CANCEL is illegal *whatever it carries* — the sequence guard runs before the
payload is decoded (deliberately: an illegal-next frame should never have its
attacker-chosen bytes parsed). The test never reached its subject.

Fix: drive the state to where the frame is legal first, and say why in a comment
so nobody "simplifies" the setup away.

```rust
let mut state = AcceptState::new();
offer(&mut state, a_launch_frame()).expect("the sequence guard must not answer this case");
let outcome = offer(&mut state, frame(Inbound::Cancel.opcode(), b"why"));
```

## The general shape

In any decoder with an admission/sequence check ahead of a content check, a test
for the CONTENT rule must first satisfy the ADMISSION rule. Otherwise it passes
on the admission refusal and reads as coverage forever. Sibling of
`mem:refusal-test-answered-by-earlier-guard`; the new wrinkle is that here the
earlier guard is a STATE MACHINE, so the fixture looks perfectly well-formed —
nothing about the bytes hints that the wrong layer answered.

## Two things that made it visible, both cheap

1. Assert the EXACT reason code, never `is_err()`. The reason name is what
   identified the wrong answerer.
2. Give the harness a helper whose `expect` pins the layer that must SUCCEED:

```rust
fn offer(state: &mut AcceptState, bytes: Vec<u8>) -> Result<Accepted, ProtocolError> {
    let raw = read_frame(&mut Scripted::serving(bytes), ChannelKind::Control)
        .expect("framing must accept this frame: the case under test is a control-layer refusal");
    state.accept(&raw)
}
```

That `expect` is not convenience — it is the assertion that the framing layer did
not answer a control-layer test.
