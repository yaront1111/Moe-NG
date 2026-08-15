# Replaying a creation command proves the state CAN exist, not that the presented value IS it

Pattern seen in the expansion bridge (`packages/scheduler/src/expansion/expansion-binding.ts`):
a caller presents an aggregate state; the validator reads `state.creationReceipt.command`, replays
it through the production reducer, and returns `replayed.state`.

That reads as maximally safe — the value bound downstream is reducer-produced either way — and it
is exactly the hole. The presented value is never compared with the replayed one, so ANY forged
field on it (QA used `parentRunRef: "run:forged"`) is accepted and silently discarded, and every
later reader believes the daemon verified the value it was handed. `ok: true`, nothing red.

Fix: compare presented against replayed field-for-field, refuse with a stable code/layer. Drive
the walk from the TRUSTED (reducer-produced) side so a hostile presented value cannot widen it or
make it recurse forever, and read the presented side only through own-data readers so an accessor,
a proxy trap, an array hole or an extra key is a mismatch rather than a value.

Second-order trap this creates: once the deep comparison exists, it also catches things an EARLIER
gate was supposed to answer (here, an ACTIVE hold at version 2 or carrying a terminal receipt),
with a different code. Deleting those earlier checks then leaves the suite green. Pin WHICH gate
answers, not merely that something refused.

See `mem:task-task-2d9696160e674f26a8d422c45829d80e-handoff`.
