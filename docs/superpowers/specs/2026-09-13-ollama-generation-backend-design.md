# Ollama as an alternative generation backend — Design

## Goal

Let the user generate Style-Bible-driven themes, components, and page-layout suggestions using a
local Ollama model instead of Claude, selected per generation, with no change to the generators'
existing output shape or downstream pipeline.

This is the first of two originally-combined ideas, deliberately split during brainstorming:

1. **This spec** — Ollama as a swap-in alternative to Claude for the 3 existing structured-output
   generators.
2. **Separate, later spec** — a dashboard-wide AI copilot that explains GameForge's own features
   and recommends settings/prompts for the user's specific project. Genuinely different subsystem
   (new conversational UI, no existing surface to extend) — not touched here.

Also explicitly out of scope, raised in the same conversation and deferred on the user's own
instruction: a new dashboard visual design system (Sentient/Satoshi fonts, a Persimmon color
palette). Unrelated to AI work; its own task whenever picked up.

## Scope

**In scope:** `ClaudeApiThemeGenerator`, `ComponentGenerator`, and `PageLayoutSuggester` — the 3
generators that already share `callClaudeTool()` (`lib/services/claudeToolCall.ts`, built in the
2026-09-12 audit-fixes plan's Task 18) — gain Ollama as a second callable backend.

**Out of scope:**
- Sprite/image generation (`PixellabGenerator`/`MockGenerator`) — local vision/image models are a
  much less mature area than local text models; Pixellab/Mock stays as-is.
- **Reference-image input to the in-scope generators.** Found while re-reading the actual generator
  code before writing this spec (not caught during brainstorming): `ClaudeApiThemeGenerator` and
  `ComponentGenerator` both accept an optional reference image as multimodal content alongside the
  text prompt. Stacking "local model" + "vision-capable" + "reliable tool-calling" is a materially
  higher, separately-unverified bar than the text-only case this spec is built on. Resolution: the
  Ollama option is **not offered in the per-generation picker when a reference image is attached** —
  Claude remains the only choice for that specific generation. Revisit only once the text-only path
  has real usage and a vision-capable model is independently validated the same way the text models
  are.
- The AI copilot (separate spec, item 2 above).
- The visual design system change (separate, unrelated task).
- Any automatic retry of a failed tool-call — see "Failure handling" below.

## Why this is feasible now (and what changes from the Claude-only assumption)

GameForge already has the right shape to extend, not replace:

- `ImageGenerator.ts` already picks a provider (Pixellab vs. Mock) at runtime based on
  configuration — the same pattern this spec reuses for Claude vs. Ollama.
- `claudeToolCall.ts` already dedups "call a model, force one tool, extract its input" across all
  3 generators. Ollama becomes a second implementation of that same interface, not a new one.

One real architectural difference, confirmed directly against Ollama's own API docs and corroborated
by real-world research (see Appendix), that the Claude-only code never had to handle: **Ollama has
no forced tool-choice.** Anthropic's API guarantees the model calls exactly the one tool you offer
(`tool_choice: {type:'tool', name: toolName}`). Ollama's model decides for itself whether to call a
tool at all, and can simply return plain text instead. Since GameForge only ever offers one tool per
call, "wrong tool" isn't a real risk here — but "no tool call at all" is a real, expected failure
mode, not a rare edge case, and the design below treats it that way throughout.

## Architecture

### `lib/services/ollamaToolCall.ts`

Same call signature as `callClaudeTool`, so the 3 generators barely change:

```
callOllamaTool(params: {
  host: string;            // e.g. "http://localhost:11434"
  model: string;           // e.g. "llama3-groq-tool-use:8b"
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  messages: Array<{ role: string; content: unknown }>;
  maxTokens?: number;
  signal?: AbortSignal;
  operationLabel: string;
  truncatedMessage: string;
}): Promise<unknown>
```

Each of the 3 generators gains a `provider: 'claude' | 'ollama'` (+ `model`, + Ollama host when
relevant) parameter, threaded from the job's existing `options` JSON column — no schema change,
same place theme-candidate tokens already live today.

Request shape, each point confirmed against Ollama's own docs or real-world bug reports (not
assumed — see Appendix):

- POST to Ollama's **native** `/api/chat` — deliberately not the OpenAI-compatible endpoint, which
  has no way to set `num_ctx`. A large tool schema could otherwise be silently truncated by the
  small default context window, with no error at all.
- `stream: false` — avoids a real, documented bug where Ollama's OpenAI-compat layer drops
  streamed `tool_calls` deltas. Non-streaming isn't affected by that bug either way, and matches
  how `callClaudeTool` already works (no streaming anywhere in the existing Claude integration).
- `options.num_ctx` set explicitly. All 3 in-scope schemas are small and flat (verified directly —
  `ClaudeApiThemeGenerator`'s is 8 plain string fields, `ComponentGenerator`'s is 2, `PageLayoutSuggester`'s
  is one array of integers; none use `oneOf`/`anyOf`/enum, so Ollama's JSON-Schema subset support is
  not a blocker here), so a single generous constant (e.g. 8192) comfortably covers prompt + schema
  + output for all 3 without needing a per-call token-estimation formula. Guard against the silent-
  truncation failure mode directly: if the response's `prompt_eval_count` (Ollama reports this)
  comes back at or above `num_ctx`, treat it as a truncation, not a clean response.
- `tools: [{ type: 'function', function: { name: toolName, description: toolDescription,
  parameters: inputSchema } }]` (Ollama's tool shape, not Anthropic's).

### Concurrency

GameForge's worker (`worker.ts`) claims and processes up to `WORKER_BATCH_SIZE` (default 5) jobs
**concurrently** via `Promise.allSettled` — verified directly, not assumed. That's fine for Claude
(a cloud API that scales independently of this machine), but firing several concurrent generations
at one local Ollama daemon on typical consumer hardware (one GPU, finite VRAM) risks real resource
contention — OOM, severe slowdown, or requests queueing inside Ollama in a way this design's
timeouts don't account for. `ollamaToolCall.ts` holds a simple module-level mutex: only one Ollama
call in flight at a time from this process, regardless of how many jobs the batch concurrently
claims; any other queued Ollama call just waits its turn. A single global lock, not a per-host or
per-model scheme — the simplest thing that removes the real risk; revisit only if real usage shows
it's a throughput bottleneck worth the added complexity.

### Response handling

- **`message.tool_calls` present, arguments already structured** → parse directly, same as the
  Claude path.
- **`message.tool_calls` present, but an argument value is a JSON-encoded string instead of a real
  nested object/array** → a real, documented quirk (nested tool-call arguments come back
  stringified, not structured) — `JSON.parse()` that specific field before validating against the
  Zod schema. That parse is wrapped in its own try/catch: a malformed/truncated string (the model
  cut off mid-JSON) maps to the same specific hard-fail error as "no tool call at all," not a raw
  Zod validation error — the latter would read as "your request was invalid," which is wrong; the
  request was fine, the model's output wasn't.
- **No `tool_calls` at all** (model just returned plain text, possibly in `content`) → **hard-fail**
  with a specific error ("this model didn't produce structured output — try a different model, or
  retry with a correction"), surfaced through the exact same job-failure-message path Task 22 of
  the audit-fixes plan already built (`jobs.error_message`, shown on the job card).

## Failure handling: hard-fail by default, manual correction on request

Decided explicitly, not defaulted to without thought — the closest real precedent
(`pydantic-ai`) retries once automatically before failing; chat-style tools (Open WebUI) just show
whatever text came back as the answer. Neither fits a single-shot structured-generation pipeline
well. This design:

- **Hard-fails immediately** on a missing tool call — no automatic retry, no silent fallback. This
  also means the recommended-models list (below) needs to actually be reliable, and the user has
  already committed to personally testing each recommended model before trusting it, rather than
  relying on vendor/community claims alone.
- Offers a **manual "Retry with correction"** action on a job that failed this specific way: re-runs
  the same request with one added instruction telling the model it must call the tool. This is
  deliberately a separate action from the existing generic job-retry (Task 21's retry/backoff,
  which handles transient 429/5xx errors — a different failure class entirely), not a variant of
  it. Lives in the job's failure-detail view (where `jobs.error_message` is already shown), clearly
  labeled as distinct from the generic retry button, not placed next to it as a same-looking
  alternative.

## Model selection & recommendation

- **Per-generation picker**, not a global setting: wherever a theme/component/page-layout
  generation is triggered today, a provider selector appears — "Claude" plus whichever Ollama
  models are actually installed. Defaults to Claude (no behavior change for existing usage).
- **Dynamic discovery**: the picker's Ollama options come from a live `GET /api/tags` call, not a
  stored/typed setting — always matches what's really installed, never goes stale.
- **Recommended models list** (Settings page, see below) leads with `llama3-groq-tool-use:8b` — the
  one model in this research with real published benchmark evidence for tool-calling reliability
  (89%+ on the Berkeley Function-Calling Leaderboard). Every other commonly-suggested model
  (llama3.1, qwen2.5, etc.) is only "officially tagged as supporting tools," not independently
  verified — one of those tags (llama3.1:8b) has a live bug report of silently returning plain text
  instead of calling the tool. The list is honest about this distinction rather than presenting
  every tagged model as equally trustworthy. Final list is confirmed by actually running each
  candidate against GameForge's real schemas before it ships, not by research claims alone.

## Settings & model management

New `/dashboard/settings/ollama` page, same structural pattern as the existing `/dashboard/settings/
aseprite` page:

- **Connection**: host/port field, default `http://localhost:11434`, editable (so it also works
  pointed at another machine on the local network running Ollama). A **"Test connection"** button —
  a live check against `/api/tags` — since, unlike the Aseprite path, "is it actually running" is
  something worth instant feedback on. One-line warning in the UI: Ollama has no built-in
  authentication, so pointing this at a non-localhost host is the user's own trust decision, not
  something GameForge gates.
- **Installed models**: live list from `/api/tags`. No separate sync step.
- **Recommended models**: the curated, honestly-labeled list above, each with a **"Pull this
  model"** button. Progress comes from Ollama's real `/api/pull` NDJSON stream — one JSON object
  per line, `{"status":"pulling manifest"}` → repeated `{"status":"pulling <digest>","digest":...,
  "total":<bytes>,"completed":<bytes>}` (note: `completed` is absent until the download actually
  starts — the progress bar needs to handle that, not assume it's always present) →
  `{"status":"success"}` as the only real terminal signal, with **no `total`/`completed` fields at
  all on that line**. The progress calculation checks `status === 'success'` first and jumps
  straight to 100% in that case — it never computes `completed/total` on the terminal line, which
  would otherwise divide by zero. The pull request itself carries an `AbortSignal.timeout` (a
  generous one — multi-GB downloads are slow; a few minutes, not the 60s used elsewhere) so an
  abandoned or hung request doesn't run forever; Ollama resumes partial pulls on retry, so timing
  out isn't destructive.

## Testing

CI (`ubuntu-latest`, no GPU, no Ollama daemon) can never run a real model. Every test here mocks
`fetch`, the same pattern the existing Claude-integration tests already use
(`test/claudeToolCall.test.ts`):

- `ollamaToolCall.ts`: request-shape assertions (native `/api/chat`, `stream: false`, the one tool,
  `options.num_ctx` set); response-handling cases for a clean `tool_calls` response, a nested
  stringified-argument response, a malformed/truncated stringified argument (maps to the hard-fail
  error, not a raw Zod error), no `tool_calls` at all (hard-fail path), the model dumping the call
  into `content` instead (same hard-fail, not a crash), and a `prompt_eval_count >= num_ctx`
  response (treated as truncation). Also: two concurrent calls in the same test process only issue
  one `fetch` at a time — the second doesn't fire until the first's promise settles — proving the
  mutex actually serializes rather than just existing unused.
- Model-pull progress parsing: a faked NDJSON stream, asserting the parser tolerates a missing
  `completed` field, computes `completed/total` correctly on the mid-stream lines, and on the
  terminal `status:"success"` line (which carries neither field) jumps straight to 100% rather than
  computing a division and getting `NaN`. Also: a pull that never resolves is cut off by the
  configured timeout rather than hanging the test (or the request) forever.
- The Settings "Test connection" route: mocked reachable/unreachable cases.
- **Explicitly not automated**: whether a given real model is actually reliable at tool-calling.
  That needs a real local Ollama + real multi-GB weights, which can't and shouldn't run in CI — it's
  the manual validation step already planned before the recommended list ships, matching how
  GameForge already treats anything that can't be meaningfully unit-tested.

## Appendix — research that shaped this design

Done before writing this spec, at the user's explicit request to ground the design in real sources
rather than assumptions, given an earlier reference (pi.dev) turned out to be a real but
differently-shaped project (a terminal coding-agent framework, not a UI-navigation or asset-builder
tool — still MIT-licensed and genuinely Ollama-compatible, noted as a possible pattern reference but
not adopted as a dependency, consistent with AGENTS.md's "no utility libraries, direct code over
generic abstraction" convention).

- **Ollama has no forced tool-choice** — confirmed directly against `github.com/ollama/ollama/blob/
  main/docs/api.md`. No `tool_choice` parameter exists; the model decides autonomously.
- **Model reliability**: real benchmark evidence (Berkeley Function-Calling Leaderboard, 89-90%)
  exists only for the Groq tool-use tune of Llama 3. Other commonly-recommended models are tagged
  as tool-capable by Ollama's own library but not independently verified — llama3.1:8b has a
  documented failure case (github.com/pydantic/pydantic-ai/issues/777).
- **Pitfalls found beyond the already-known streaming bug**: Ollama's tool-schema support is a
  subset of JSON Schema (no `oneOf`, enums forced to strings); nested-object arguments come back as
  a JSON-encoded string, not structured JSON (github.com/ollama/ollama/issues/6155, patched around
  in LangChain.js for the same reason); some models place the call in `content` instead of
  `tool_calls` even when not streaming; the OpenAI-compatible endpoint has no way to set `num_ctx`,
  risking silent truncation of large tool schemas under the small default context window.
- **CORS/networking**: confirmed irrelevant — this is a server-to-server call (Next.js route to
  `localhost:11434`), never touches a browser's CORS enforcement. Real risk instead: Ollama's API
  has no authentication at all, which shaped the Settings-page warning above.
- **Architecture precedent**: a thin, same-shape helper (this design's approach) was corroborated
  as the right scale of solution for 2 providers / 3 call sites — heavier multi-provider
  abstractions (LiteLLM, Vercel AI SDK's provider layer) solve a different problem (routing across
  many divergent providers) and wouldn't have protected against the provider-specific quirks found
  above anyway.
- **Real-world precedent on failure handling**: conversational tools (Open WebUI) treat "no tool
  call" as normal — showing the text is the product. Structured/agentic frameworks (`pydantic-ai`)
  retry once with a corrective message before failing. This design deliberately takes neither
  exactly — hard-fail by default (matching this being a single-shot structured pipeline, not a
  multi-turn chat), with the correction move available as a manual, user-initiated action instead of
  an automatic retry loop.
- **Model-management UX precedent**: LM Studio, Jan.ai, and Ollama's own desktop app all separate
  "pick an installed model" from "get one you don't have," and all show real download progress (%,
  not a spinner) — directly informing the Settings-page design above. The real `/api/pull` NDJSON
  shape was confirmed against Ollama's own docs, not assumed.
- **Product-level prior art**: ComfyUI-Copilot (peer-reviewed, ACL 2025, active — github.com/AIDC-AI/
  ComfyUI-Copilot) is the closest real match for the *separate, later* AI-copilot spec — an in-app
  copilot for a local-capable generation tool, explicitly supporting local backends alongside cloud
  APIs. Not relevant to this spec's scope, but worth starting from when item 2 above is brainstormed.
  InvokeAI's "named presets" (saving a full generation config for reuse) is structurally the same
  idea as GameForge's own Style Bibles — validates that existing design rather than suggesting a
  change. A separately-suggested project, FreeToken (FlashML-org), was checked and ruled out: it's a
  heavier, less mature competitor to Ollama itself (a GPU-bound inference engine for huge frontier
  models), not a layer on top of it or a relevant copilot framework.
