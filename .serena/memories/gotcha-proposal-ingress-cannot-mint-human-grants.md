# Proposal ingress must never accept a pre-granted human gate

While composing HumanAuthorityGate into `plan.propose`, a tempting implementation persisted the caller's entire gate object. That made a coherent hand-written `grant` authoritative: `decideApprovalAuthority` correctly revalidates its fields/bindings, but a pure structural contract cannot prove which boundary minted those bytes. A caller could then supply a forged HUMAN grant and override an otherwise REQUIRE_HUMAN policy.

Rule: an untrusted work-creation/proposal boundary may establish only an **unsatisfied** gate (`grant: null`). Normalize any caller-supplied non-null grant to unreadable/fail-closed. A satisfied gate requires a separate authority-bearing writer (control-room/human session path). Preserve already-durable granted gates across lifecycle transitions, but do not mint them from proposal payloads.

The daemon regression test is named `refuses a caller-forged human grant at plan-proposal ingress`; before the fix it received ok:true and activated.