---
name: deepseek-review
description: Adversarial review using DeepSeek V4.1 Flash (via OpenRouter by default, CheaperInference as a fallback) as the read-only critic — a drop-in replacement for claudex-loop's codex-review now that Codex isn't available. Two modes — (1) PLAN review: Claude drafts/loads a plan into PLAN.md, DeepSeek adversarially reviews it and returns VERDICT:APPROVED or VERDICT:REVISE, Claude revises and resends full history until APPROVED or MAX_ROUNDS; (2) DIFF review: single-pass advisory review of a git diff or PR, PR-style findings, no verdict loop. Use when the user says "/deepseek-review", "deepseek review my plan", "deepseek review this diff", "have deepseek review this", or is about to build/ship something high-stakes (auth, schema, concurrency, migrations, payments) and wants a second-model sanity check. NOT for trivial changes.
---

# DeepSeek-Review — Adversarial Review via OpenRouter

Same doctrine as claudex-loop's `codex-review`: one model builds, a different model attacks it, cross-model beats an echo chamber. DeepSeek V4.1 Flash plays the critic, called via OpenRouter's OpenAI-compatible chat-completions API.

**Key architectural difference from an agentic reviewer:** an agentic CLI (Codex, Claude Code itself) can browse the repo inside a sandbox. DeepSeek here is a plain chat-completions API — it has no filesystem access at all. It is read-only by construction (it can only return text), but Claude must actively paste whatever file contents the critic needs to see directly into the message. Don't assume it can "go read the code" — if a file matters to the review, include it.

**Why this matters, not just doctrine:** an adversarial review catches *reasoning* errors, not *empirical* ones — a critic (any critic, cross-model or not) can be unanimously, confidently wrong. Published multi-agent review research documents a case where 80 independent review agents all endorsed a vulnerability that didn't exist; it was only killed by actually running the code. That's the whole reason Claude stays final arbiter on every finding below, not a formality — check every finding against the real code before acting on it, never against how convincing it sounds.

## Setup

**OpenRouter is the default provider** (CheaperInference, a Claude-proxy some projects also use, has had repeated real flakiness; OpenRouter has been reliable in every real call so far):
- Set `OPENROUTER_API_KEY` in your shell (e.g. `setx OPENROUTER_API_KEY "sk-or-..."` on Windows, persists across new shells; `export OPENROUTER_API_KEY=sk-or-...` in your shell profile on macOS/Linux). Get a key at [openrouter.ai](https://openrouter.ai) — a few dollars of credit covers a very large number of review calls (fractions of a cent each).
- Endpoint: `https://openrouter.ai/api/v1/chat/completions`, model `deepseek/deepseek-v4.1-flash` — both overridable via `OPENROUTER_BASE_URL` / `OPENROUTER_MODEL`.
- Every call explicitly requests `reasoning: {effort: "high"}` — DeepSeek V4.1 Flash's own API defaults its thinking mode to high effort, but that's not guaranteed to survive OpenRouter's pass-through unless asked for directly, so the script asks for it directly rather than leaving it to chance.
- Every call also sends a `models: [primary, fallback]` array (OpenRouter's own native fallback mechanism, not a hand-rolled retry loop) — OpenRouter automatically tries the older `deepseek/deepseek-v4-flash` slug if the primary errors, so a transient failure doesn't require Claude to notice and retry manually.
- Call helper: `.claude/skills/deepseek-review/scripts/deepseek-call.mjs` (relative to this repo's root — Node, no deps).

**Fallback provider:** set `DEEPSEEK_REVIEW_PROVIDER=cheaperinference` in the shell to switch to CheaperInference instead — same OpenAI-compatible chat-completions shape, no reasoning-effort or models-fallback request fields (unverified whether CheaperInference honors either). Requires `CHEAPERINFERENCE_API_KEY`; defaults to `https://api.cheaperinference.com/v1/chat/completions` / model `deepseek-v4-flash`, both overridable via `CHEAPERINFERENCE_BASE_URL` / `CHEAPERINFERENCE_MODEL`.

**Known quirk, not a bug:** the model sometimes self-identifies as "ChatGPT" if asked directly what it is — a known data-contamination artifact in several open models trained partly on GPT-generated synthetic data. The API response's own `model` field correctly reports the real model (`deepseek/deepseek-v4.1-flash` or similar), and OpenRouter's own usage dashboard (or `cheaper_inference.billing` on the fallback path) confirms real billed usage — trust those over the model's self-report.

## Payload size and chunking

CheaperInference's proxy has a real, non-deterministic payload ceiling somewhere around 30-40KB — chunk a large plan or diff by section if you're on that path. OpenRouter doesn't have this problem the same way: DeepSeek V4.1 Flash's real context window is 1M+ tokens, verified against OpenRouter's own model listing — a diff or plan would have to be enormous to need chunking on the default path. If a single OpenRouter call still fails on a genuinely huge payload, chunk it the same way (by logical section, one review pass per chunk) rather than assuming chunking is never needed.

## Calibration — how much to trust a finding

Expect roughly 1-in-5 "Important"-labeled findings to actually hold up once checked against the real code, not more. This isn't a reason to skip the review (a real finding once in five calls is still worth catching), but it is a reason to never act on a finding without verifying it yourself first — see "Why this matters" above. DeepSeek has no filesystem access, so most false positives are it guessing wrong about code it never actually saw.

## Chunked / multi-round review gotchas

- **A resumed history grows every round** — chunking a plan review keeps any ONE call's payload small, but a long multi-round back-and-forth on the SAME chunk still accumulates. Watch it, especially near `MAX_ROUNDS`.
- **Never pipe a call through `tee` under `set -e`** — `cmd | tee file` masks the exit code of `cmd` (the pipeline's exit status becomes `tee`'s, which almost always succeeds), so a failed call silently continues as if it worked. Check the call's own exit code directly, or use `set -o pipefail` if the shell supports it.

## The call mechanic

```bash
# Round 1 (creates history, sets system prompt):
node .claude/skills/deepseek-review/scripts/deepseek-call.mjs <history-file> <message-file> --system <system-file>

# Round 2+ (resumes — script reads existing history-file, appends, resends full history):
node .claude/skills/deepseek-review/scripts/deepseek-call.mjs <history-file> <message-file>
```

Write the system/message text to a scratch file first (never inline via `-d`/argv — plans and diffs contain quotes/backticks/newlines that break shell escaping). The script prints the critic's reply to stdout and appends both turns to `<history-file>` on disk — that JSON file **is** the resumable thread, no thread-ID bookkeeping needed. On any non-zero exit, stop and tell the user (missing key, HTTP error, malformed response) rather than retrying blind.

---

## MODE 1 — Plan review (loop)

### Tunables
| Var | Default | Meaning |
|-----|---------|---------|
| `MAX_ROUNDS` | `5` | Hard cap on review rounds. |
| `PLAN_FILE` | `PLAN.md` | The plan under review. |
| `LOG_FILE` | `PLAN-REVIEW-LOG.md` | Append-only transcript. |
| `HISTORY_FILE` | scratchpad `deepseek-review-history.json` | The resumable conversation state — delete before Round 1 of a fresh review. |

### System prompt (Round 1 only)
> You are an adversarial reviewer for an implementation plan. Your mandate is to kill it, not improve it — the plan only survives if you genuinely can't find a way to break it. You have no filesystem access; the user will paste everything you need to see. Attack from three angles: (1) what would a naive read-through miss? (2) does the plan actually satisfy its own stated goals and invariants? (3) does it cross a hard boundary — security, data loss, concurrency? For each real flaw, give a one-line fix. End your reply with EXACTLY one line: `VERDICT: APPROVED` if the plan survived, or `VERDICT: REVISE` if it didn't.

### Round 1 message
Paste the full contents of `PLAN_FILE`, plus any repo files the plan depends on that DeepSeek would need to judge feasibility (schema files, the module being extended, etc. — Claude's judgment call on what's load-bearing enough to include).

### Round 2+ message
> I revised the plan based on your critique. Here is the new version of PLAN.md: <full contents>. Re-review — check whether your prior findings are addressed and flag anything new. End with VERDICT: APPROVED or VERDICT: REVISE.

### Each round
1. Append the reply to `LOG_FILE` under `## Round <n> — DeepSeek`.
2. Check the last line for the verdict token.
   - `APPROVED` → done, go to Resolution.
   - `REVISE` → Claude is final arbiter: decide what's actually worth acting on, revise `PLAN_FILE`, log what changed/was rejected and why under `### Claude's response`, increment round.
3. `round > MAX_ROUNDS` → Resolution as deadlock.

### Resolution (human gate)
- **APPROVED:** show the final plan, a 3-bullet summary of what changed, round count. Ask before writing any code.
- **Deadlock:** don't fake convergence — list each unresolved point and Claude's counter-position, hand it to the user.

---

## MODE 2 — Diff review (single pass, advisory)

PR-style feedback, not a gate — no verdict loop.

1. Get the diff: `git diff <base>...<head>` (or the working tree diff for uncommitted work).
2. Write one message containing: the diff itself, `PLAN.md` if one exists for this work, and a short note on what the change is trying to do.
3. System prompt:
   > You are reviewing a code diff, PR-style. Your mandate is to refute it — assume each change is wrong until you can't find how. You have no filesystem access beyond what's pasted here — ask for more context only by naming the exact file/lines you need, don't guess. Attack from three angles: (1) what would a quick skim miss? (2) does the diff actually do what it claims to do? (3) does it cross a hard boundary — security, correctness, data loss? Don't invent scope creep. One finding per line: file/location, what's wrong, why it matters, one-line fix. No verdict line needed.
4. Single call (fresh history file — no resume needed for a one-shot review, unless the user wants a re-check after fixes, in which case resume the same history file with "Here's the updated diff after addressing your findings: <diff>").
5. Present findings to the user; Claude decides which to act on (same final-arbiter rule as Mode 1), fixes, and — only if the user asks for reinspection — sends the updated diff through the same history file once more.

---

## Hard rules

- Never inline plan/diff text via shell `-d`/argv — always via a scratch file, the script reads them.
- Claude is final arbiter on every finding in both modes — incorporate good critiques, reject bad ones with a logged reason.
- Mode 1's loop always terminates at `MAX_ROUNDS`.
- Code/fixes only after the human gate (Mode 1: after APPROVED + explicit go-ahead; Mode 2: this reviews existing work, so findings just get triaged like any other review).
- If the relevant API key is missing (`OPENROUTER_API_KEY`, or `CHEAPERINFERENCE_API_KEY` on the fallback path) or a call fails outright (not just a fallback-model retry — that's automatic), stop and surface it — don't silently fall back to Claude reviewing its own work solo, that defeats the entire point of a cross-model check.

## What NOT to do

- Don't assume DeepSeek can read repo files on its own — it can't, paste what it needs.
- Don't trust the model's self-reported identity if asked directly — check the API response's `model` field instead.
- Don't skip `LOG_FILE` — it's the deliverable that shows the argument actually happened.
