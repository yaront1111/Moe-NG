# A rotated session still reads ACTIVE — record the generation or "rotated" is not a branch

`apps/daemon/src/identity/session-authority.ts:371` `readActiveSession` returns ABSENT for
expired, closed, revoked-credential, cross-project, and `credential.generation !== session.generation`.

`rotateCredential` bumps BOTH generations together, so after a rotation `readActiveSession` is
still `{status:"FOUND"}`. Anything that treats "rotated" as a synonym for "the authority no longer
holds it" has no rotated branch at all — a row written at generation 1 keeps resolving against a
generation-2 session, and the test for it passes for the wrong reason.

Fix used in the coordination recipient registry: persist `authority.session.generation` in the
registration event and require it to equal the CURRENT session generation at resolve time.

## How to prove the branch is real

Assert the session layer still says FOUND immediately before asserting your own refusal:

    rotateSession(state, session, nonce);
    expect(state.sessions.readActiveSession(id)).toMatchObject({ status: "FOUND" });
    expect(registry.resolveRecipient(address)).toEqual({ known: false, role: null });

Without the first line the case can be silently answered by the session layer and the mutation
drill on your own guard stays green. Same shape applies to any cross-project or project-scoping
guard: name the gate you claim to be testing and prove every earlier gate PASSES first.

Related: `mem:refusal-test-answered-by-earlier-guard`,
`mem:gotcha-expectedversion-is-hashed-into-the-request-identity`.
