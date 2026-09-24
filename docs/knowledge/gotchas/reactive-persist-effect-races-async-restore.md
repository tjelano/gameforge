---
title: A reactive "sync state to storage" effect races an async "restore from storage" effect on mount
date: 2026-09-24
tags: [react, localstorage, testing]
---

`CopilotPanel.tsx` needed to remember its active conversation id across page reloads. The natural
first design: a `useEffect` that watches `conversationId` and writes/clears `localStorage` whenever
it changes, plus a separate effect that reads `localStorage` on mount (gated on `useCurrentUser`'s
async `user` becoming available) to resume.

This is broken. The "watch and persist" effect also fires on the component's very first mount, at
which point `conversationId` is still its initial `null` — so it immediately calls
`localStorage.removeItem(...)`, wiping whatever a *previous* mount (a previous page load) had
stored, before the async resume effect (waiting on `user`, which only resolves after its own fetch)
ever gets a chance to read it.

**Fix:** don't derive a persistence side effect from watching state reactively when the state's
*initial* value is indistinguishable from "the user cleared it." Instead, persist explicitly at each
actual site the state changes for a real reason (on send, on load, on explicit "new chat") — never a
generic `useEffect(() => sync(x), [x])` for state that starts at the same value an intentional clear
would set it to.

**Testing trap, worth remembering separately:** a unit test mocking `useCurrentUser` to return a
truthy `user` *synchronously from the first render* did not catch this bug — it passed even with the
broken code, because the function that reads storage had already captured the id as a plain argument
before the wipe could matter. The real hook resolves `user` asynchronously (its own `useEffect` +
fetch), so `user` is genuinely `null` on the first render in production. Only a mock that reproduces
that same async gap (e.g. an internal `useState` + `useEffect` + `Promise.resolve().then(...)`, not a
value returned synchronously) can reproduce a race that depends on it. A test environment that's
"close enough" to production in shape but not in timing can still structurally miss the exact bug
it's meant to catch -- when a fix depends on ordering between an async effect and a synchronous one,
make sure the test's mocks preserve that same async/sync split, not just the same return values.
