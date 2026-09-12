# Multi-Provider Theme Generation — Design Spec

> **Note (added during a later audit):** kie.ai support described below was never shipped — the final implementation only has `anthropic`/`cheaperinference` (see `lib/services/claudeApiProviders.ts`). This section is historical, not a guide to current behavior.

Status: Approved by user in brainstorming chat. Ready for implementation planning.

## Motivation

Website Theme Generation (shipped in PR #3) calls the official Anthropic
Messages API directly — the only way to use it costs real money billed
through `console.anthropic.com`. The user doesn't currently have billing
set up there, but wants the feature to also work through two third-party
resellers: **cheaperinference.com** and **kie.ai**, both of which proxy
real Claude models at a discount. This spec adds those as additional,
explicitly-selected options — the official Anthropic path is untouched
and stays the default.

## Provider research (done during brainstorming, not re-derived here)

Both providers were checked against their own documentation before this
spec was written, not assumed:

- **cheaperinference.com** exposes two endpoints: an OpenAI-Chat-Completions-shaped
  one at `https://api.cheaperinference.com/v1`, and a separate,
  genuinely **Anthropic-Messages-API-shaped** one at
  `https://api.cheaperinference.com`. The Messages-shaped endpoint takes
  an `X-Api-Key: ci_live_...` header (same header name our code already
  sends, different key value/prefix) and lists real Claude models
  (`claude-opus-4.6`, `claude-opus-4.8`, `claude-sonnet-5`,
  `claude-fable-5`). Its own docs claim `tools`/`tool_choice` support on
  this endpoint, but the exact shape of forced tool_choice wasn't
  confirmed from static docs alone.
- **kie.ai** is explicitly built as a drop-in for Anthropic's own
  `ANTHROPIC_BASE_URL` convention (the same env var the official Claude
  Code CLI uses to redirect itself) — base `https://api.kie.ai/claude`,
  with `/v1/messages` appended the same way the official client appends
  it. This is a strong signal it mirrors the real Messages API surface,
  including tool use, since it's designed to stand in for tools that
  already depend on that surface. Auth is **not** `x-api-key` — it's
  either an `ANTHROPIC_AUTH_TOKEN: <raw key>` header or an
  `ANTHROPIC_API_KEY: Bearer <key>` header. Exact model name strings
  weren't confirmed (their model catalog lives behind a page that didn't
  fetch cleanly).

**Neither provider's forced-`tool_choice` behavior is confirmed by a
real test call** — the user has no API key for either yet. This spec is
written to fail loudly and diagnosably if a provider's actual behavior
doesn't match what its docs claim, rather than assuming compatibility.

## Out of scope for this change

- **No fallback chain.** If the selected provider fails, the job fails
  — same as today. Automatically retrying against a different provider
  is a new kind of complexity this codebase doesn't have anywhere else,
  and it would silently mask a real problem with the configured
  provider as an intermittent, hard-to-notice failover. Explicitly
  rejected during brainstorming.
- **No per-job provider choice in the UI.** One provider is active for
  the whole app at a time, chosen by configuration, matching the
  existing mock-vs-real pattern (`PIXELLAB_API_KEY`,
  `ANTHROPIC_API_KEY` presence) rather than adding a new per-job field
  and a new UI control.
- **No changes to `PixellabGenerator`/`ImageGenerator`.** This is scoped
  to theme generation only — pixel-art generation has no reseller
  request from the user and stays exactly as it is.

## Architecture

A **provider profile** — a plain object, not a class — carries the three
things that actually differ between providers: the request URL, how to
build the auth header, and the model name string. One shared generator
class (renamed from `AnthropicThemeGenerator` to `ClaudeApiThemeGenerator`
— see "Renaming" below) takes a profile and does everything
provider-agnostic exactly as it already does today: build the request
body, force `tool_choice`, apply the timeout, validate the response
against `ThemeTokensSchema`, write the CSS file, diagnose failures.

This is a profile-object, not a wrapper class or a factory — AGENTS.md
forbids both, and the whole point here is to keep three vendors flat and
direct while putting the *safety-critical* logic (regex validation,
timeout, response parsing) in exactly one place, per AGENTS.md's
explicit "extract shared helpers for safety-critical logic on sight"
rule. Three separate generator classes would triple that logic — the
same mistake the previous feature's final review already caught once
(duplicated orphan-cleanup logic) — for the sake of an isolation this
project's own conventions don't ask for.

```typescript
// lib/services/claudeApiProviders.ts
export interface ClaudeApiProvider {
  name: 'anthropic' | 'cheaperinference' | 'kieai';
  requestUrl: string;
  model: string;
  buildAuthHeaders(apiKey: string): Record<string, string>;
  apiKeyEnvVar: string;
}

export const ANTHROPIC_PROVIDER: ClaudeApiProvider = {
  name: 'anthropic',
  requestUrl: 'https://api.anthropic.com/v1/messages',
  model: 'claude-sonnet-5',
  buildAuthHeaders: (apiKey) => ({ 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }),
  apiKeyEnvVar: 'ANTHROPIC_API_KEY',
};

export const CHEAPERINFERENCE_PROVIDER: ClaudeApiProvider = {
  name: 'cheaperinference',
  requestUrl: 'https://api.cheaperinference.com/v1/messages',
  model: 'claude-sonnet-5',
  buildAuthHeaders: (apiKey) => ({ 'X-Api-Key': apiKey }),
  apiKeyEnvVar: 'CHEAPERINFERENCE_API_KEY',
};

export const KIEAI_PROVIDER: ClaudeApiProvider = {
  name: 'kieai',
  requestUrl: 'https://api.kie.ai/claude/v1/messages',
  model: 'claude-sonnet-5', // UNCONFIRMED — kie.ai's exact model catalog wasn't reachable; verify against a real key before relying on this
  buildAuthHeaders: (apiKey) => ({ 'ANTHROPIC_AUTH_TOKEN': apiKey }),
  apiKeyEnvVar: 'KIEAI_API_KEY',
};
```

`anthropic-version`/`content-type` headers common to all three stay in
the generator itself (every provider proxies the same underlying API
shape); `buildAuthHeaders` only carries what genuinely differs.

## Provider selection

One new env var, `THEME_API_PROVIDER`, with values
`'anthropic' | 'cheaperinference' | 'kieai'`. **Unset behaves exactly
like today** — this is additive, not a behavior change for the existing
setup:

- `THEME_API_PROVIDER` unset (or `'anthropic'`) → existing behavior:
  `ANTHROPIC_API_KEY` present → real Anthropic; absent → `MockThemeGenerator`.
- `THEME_API_PROVIDER=cheaperinference` → requires
  `CHEAPERINFERENCE_API_KEY`. If it's missing, `getThemeGenerator()`
  throws a clear, specific error (`'THEME_API_PROVIDER is set to
  "cheaperinference" but CHEAPERINFERENCE_API_KEY is not configured.'`)
  rather than silently falling back to the mock — the user explicitly
  opted into a real provider, so a missing key is a misconfiguration to
  surface, not paper over. This throw happens inside the existing
  worker job try/catch, so it fails the specific job with a logged,
  diagnosable reason, exactly like any other generation failure.
- `THEME_API_PROVIDER=kieai` → same shape, requires `KIEAI_API_KEY`.

## Error diagnosis

Every thrown error from `ClaudeApiThemeGenerator` includes which
provider was active (e.g. `'Anthropic response (via cheaperinference)
contained no tool_use block for emit_theme.'`) — with three possible
providers now, a bare error message would leave "which one failed"
ambiguous in the worker log. This is a small addition to the existing
error strings, not new error-handling logic.

If a third-party provider's `tool_choice` behavior turns out not to
match Anthropic's (e.g. it ignores the forced tool and returns prose),
that already surfaces through the existing "no tool_use block" error
path — no new detection code needed, the existing check already covers
it structurally.

## Renaming

`AnthropicThemeGenerator` → `ClaudeApiThemeGenerator` (file and class),
since the class no longer talks to Anthropic exclusively — it talks to
whichever Claude-API-shaped host its profile points at. `MockThemeGenerator`
and the `ThemeGenerator` interface are untouched. This is a rename of
already-shipped code, not new functionality — every existing test and
call site (`worker.ts`, `ThemeGenerator.ts`'s `getThemeGenerator()`)
gets updated to match, with no behavior change for the existing
Anthropic-only path.

## Configuration documentation

`.env.local.example` and `README.md` gain the same treatment
`ANTHROPIC_API_KEY` already got: a comment block for
`THEME_API_PROVIDER`, `CHEAPERINFERENCE_API_KEY`, and `KIEAI_API_KEY`,
explaining that only one provider's key needs to be set (matching
whichever `THEME_API_PROVIDER` is configured), and that leaving
`THEME_API_PROVIDER` unset keeps today's Anthropic-or-mock behavior
unchanged.

## Testing

- Each provider profile is a plain object — trivially unit-testable on
  its own (`buildAuthHeaders` returns the right header shape per
  provider) with no network involved.
- `ClaudeApiThemeGenerator`'s existing test suite (currently
  `test/themeGenerator.test.ts`'s `AnthropicThemeGenerator` describe
  block) gets parameterized or duplicated per profile to confirm the
  right `requestUrl`/headers/model are actually used in the outgoing
  `fetch` call — mocking `fetch` exactly as today, no real network
  calls. This is the same "mock only the external HTTP boundary"
  pattern already established.
- `getThemeGenerator()`'s selection logic (default/unset,
  cheaperinference-with-key, cheaperinference-missing-key throws,
  kieai-with-key) gets direct unit tests.
- **No automated test can verify forced `tool_choice` actually works
  against the real cheaperinference.com or kie.ai APIs** — that
  requires a real key and a real call, deferred to manual verification
  once the user has signed up for one, mirroring exactly how the base
  Anthropic path's real-call verification was already deferred in the
  previous feature.

## Security note

Two new secrets (`CHEAPERINFERENCE_API_KEY`, `KIEAI_API_KEY`), handled
identically to `ANTHROPIC_API_KEY` — read server-side only, never
logged, never exposed to the browser. Routing generation prompts
(including Style Bible parameters) through a third-party reseller means
that content passes through infrastructure Anthropic doesn't operate —
this is an accepted, known trade-off of using a reseller, not something
this spec can mitigate in code; it's inherent to the user's choice to
use one.
