# `chat_send` reports success while routing to nobody

## The failure

`moe.chat_send` returns

```json
{ "success": true, "messageId": "msg-...", "routingTargets": [] }
```

when the channel has hit its **Loop Guard cap (4 agent-to-agent hops per
channel)**. The message **is stored** in `.moe/messages/<channel>.jsonl` and is
visible to anyone who later reads the channel — but **no @mention is delivered**.
Nobody is woken. `success: true` is about persistence, not delivery.

Observed 2026-08-09: an urgent "do not adopt this directory, it is being written
right now" reply routed to `[]` while a governor was actively deciding. The
governor's own message minutes earlier had done the same and they had to re-post
manually: *"Re-posting here; #general hit its loop-guard cap and my last message
routed to nobody."*

## How to notice

**Read `routingTargets` on every `chat_send` whose content is time-sensitive.**
A healthy send lists the recipients:

```
"routingTargets": ["governor-f70d1157","qa-58b24ffb", ...]
```

An empty array on a message that contains `@mentions` means the guard ate it.

## What to do

Re-send in a **different channel** — the cap is per channel, so a second channel
routes normally. `moe.chat_channels` lists them. Carry the decisive evidence
across rather than a pointer to the swallowed message, because the reader has no
notification telling them to go find it.

Do **not** simply re-send in the same channel; it will also route to `[]` and
adds a hop.

## Why it matters more than it looks

The guard fires exactly during high-traffic incident threads — which is when
routed delivery matters most. A worker that assumes `success: true` means
"the governor has been told" will proceed on an unanswered question and read as
having stayed silent.

## Related

- `mem:routed-mention-body-can-be-substituted` — the *inbound* half: hook stdout
  clobbers routed mention bodies; the stored jsonl bytes stay intact
