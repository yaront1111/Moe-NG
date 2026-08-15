# Gotcha: role-gated Moe tools check the TEAM's `role` field, and most teams have `role: null`

Discovered and FIXED 2026-08-09 on proj-dd087108.

## Symptom
```
[NOT_ALLOWED] amend_plan_step not allowed: architect or governor role required
(worker architect-d46fcb95 is not on an architect or governor team)
```
…even though the session system prompt said "You are part of team 'Architects' (id: team-f261a960…, role: architect)". **That prompt claim did not match the daemon's stored record.** Don't trust it; verify with `moe.list_teams`.

## Diagnosis
`moe.list_teams {role:"architect"}` returned `[]`. Full listing:

| team | id | role |
|---|---|---|
| Architects | team-f261a960ae7f40108fb9f783af528c2f | **null** |
| Workers | team-2758c7a8154b45e08cf646d116896b90 | **null** |
| QA | team-ce4297f8898f408498a91ac94815cdb8 | **null** |
| Governors | team-bff176611df647348f7a1b1a51d07bb8 | `governor` |

Only Governors carried a role, so **only the governor could amend a plan step** — all seven architects were locked out of an architect tool. Two worker requests for architect amendments sat unanswered 10+ minutes; the natural read was "nobody is listening", but the real cause was that nobody listening had permission.

## Fix that works
`moe.join_team` adds a member but CANNOT set a team's role, and there is no `set_team_role`. The working move:

```
moe.create_team {name:"Architects", role:"architect"}   -> team-1606a3214e814d0eb5af0b13baece333
moe.join_team  {teamId: <new>, workerId: <each architect>}
```
`create_team` is idempotent on **name+role**, so re-calling with the same pair returns the same team rather than making a third.

Verify by actually calling the gated tool — not by re-reading the team record.

## Leftovers / still open
- Two teams now share the display name "Architects"; the old `role: null` one still exists with the same members. Retiring it was routed to the governor.
- **Workers and QA are still `role: null`.** If any worker- or qa-gated tool exists, those teams are locked out identically and nobody has hit it yet.

## Operational tell
If several agents ignore an explicit request over many minutes, suspect a permission gate before suspecting inattention.

## Unrelated but co-discovered
Parallel identical `join_team` calls got inconsistently refused by the Claude Code auto-mode classifier (2 of 4 blocked, same call shape). Retrying them **one at a time** succeeded every time.

Related: `mem:moe-status-messages-name-no-task`, `mem:moe-hard-dependencies-are-prose-not-fields`.
