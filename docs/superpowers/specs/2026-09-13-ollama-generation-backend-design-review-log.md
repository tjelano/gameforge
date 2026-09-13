# DeepSeek spec review — 2026-09-13-ollama-generation-backend-design.md

## Round 1 — DeepSeek

10 "critical" findings plus 3 minor ones, full text in session transcript. Every finding checked
against real code or an explicit decision already made in this conversation before acting — DeepSeek
has no filesystem access, so a plausible-sounding claim isn't the same as a true one.

**Real, folded into the spec:**

1. **Concurrency.** Confirmed directly: `worker.ts` claims and processes up to `WORKER_BATCH_SIZE`
   (default 5) jobs concurrently via `Promise.allSettled`. Fine for Claude (cloud, scales
   independently); a real resource-contention risk for one local Ollama daemon on consumer
   hardware. Added a single global in-process mutex in `ollamaToolCall.ts` — one Ollama call in
   flight at a time, simplest fix that removes the real risk.
2. **`num_ctx` sizing was too vague** ("sized to the schema + prompt," no formula). Checked all 3
   in-scope schemas directly: all flat and small (8 string fields, 2 string fields, one integer
   array) — a single generous constant is enough, no per-call estimation needed. Added an explicit
   `prompt_eval_count`-based truncation check as a backstop.
3. **Stringified-argument parsing had no failure path** for malformed/truncated JSON. Added: wrap
   in try/catch, map to the same hard-fail error category as "no tool call," not a raw Zod error
   that would misleadingly suggest the user's own request was invalid.
4. **NDJSON success-line divide-by-zero.** Confirmed against the already-verified `/api/pull` shape
   from the plan's own prior research: the terminal `{"status":"success"}` line carries no
   `total`/`completed` fields at all. Added an explicit guard — check `status === 'success'` first,
   jump to 100%, never compute `completed/total` on that line.
5. **No timeout on `/api/pull`.** Real gap — a multi-GB download with no bound could hang
   indefinitely. Added a generous `AbortSignal.timeout`, noting Ollama resumes partial pulls so a
   timeout isn't destructive.
6. **"Retry with correction" UI placement was unstated**, risking two similar-looking retry buttons
   with different meanings. Pinned it to the job's failure-detail view specifically, not next to the
   generic retry button.

**Checked and found false:**

7. **Schema/Ollama JSON-Schema-subset incompatibility** (`oneOf`/`anyOf`/enum). Verified directly by
   reading all 3 real schemas (`ClaudeApiThemeGenerator`, `ComponentGenerator`, `PageLayoutSuggester`)
   — none use any of those keywords. False for this codebase's actual schemas.
8. **A cited "stray git path" typo** ("$.main/README") — grepped the spec file directly, no such
   text exists anywhere in it. Fabricated/hallucinated finding.

**Real in the abstract, but doesn't fit this project — not folded in:**

9. **SSRF-style host validation** (block non-private IP ranges on the Ollama host setting).
   Downgraded from DeepSeek's "critical" framing: the person editing this Settings field is already
   an authenticated dashboard user in a single-user/trusted-team local-first app — the same trust
   level already extended to the existing Aseprite-path setting (arbitrary local path, no IP/range
   validation) and the login-only routes just shipped this session. A full SSRF lockdown would be
   inconsistent with established precedent elsewhere in this exact codebase. Kept the already-
   planned one-line UI warning (no built-in Ollama auth, this is the user's own trust decision);
   did not add IP-range validation logic.
10. **Parse-before-hard-fail recovery** for a model that dumps its tool call into `content` instead
    of `tool_calls`. Directly contradicts a decision the user explicitly made earlier in this same
    conversation: hard-fail by default, no automatic recovery cleverness, a manual correction
    action instead of automatic retry. Not folded in — consistent with that decision, not an
    oversight.
11. **A formal "recommendation staleness" tracking system** (refresh-date constant, review
    checklist). Over-engineered for a curated list the user maintains personally on a local-first,
    single-user/small-team tool — contradicts this project's own established YAGNI/no-unrequested-
    abstraction conventions (AGENTS.md). Not folded in.
12. **Version-pinning check for Ollama's NDJSON shape changing across releases** — no citation,
    no evidence found in this session's own research; speculative. Not folded in without real
    evidence.

**Claude's response:** 6 of 12 findings were real and load-bearing, all fixed directly in the spec.
2 were checked against real code/text and found false. 4 were real-in-the-abstract engineering
concerns that don't fit this project's actual threat model, established precedent, or an already-
made decision — explicitly declined with reasoning, not silently ignored.
