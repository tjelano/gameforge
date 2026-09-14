# Dashboard AI copilot — Design

## Goal

A floating, always-available panel that explains what a GameForge dashboard feature does, recommends
settings/prompts for the user's actual current project, and can navigate the user to the right page —
grounded in a small curated knowledge doc plus live project state, not free generation.

This is the second of two originally-combined ideas, deliberately split during brainstorming (see
`2026-09-13-ollama-generation-backend-design.md`'s own Goal section for the split). That spec shipped
Ollama as an alternative generation *backend*; this spec reuses several of its pieces (the
Claude/Ollama provider abstractions, the "optional tool use" lesson) for a different kind of feature —
a conversational helper, not a structured-output generator.

Explicitly out of scope, carried over from the same earlier conversation: a dashboard visual design
system refresh (Sentient/Satoshi fonts, a Persimmon color palette). Unrelated to this work.

## Scope

**In scope:**
- A floating button + panel, mounted once at the root layout, available on every dashboard page.
- Pure conversational Q&A grounded in a new curated knowledge doc plus GameForge's existing
  `/api/context` endpoint.
- One allow-listed navigation action (`navigate_to_page`) the model may optionally call.
- Selectable model backend per message: Claude (via whichever of `ANTHROPIC_API_KEY` /
  `CHEAPERINFERENCE_API_KEY` is configured, same as the generation features) or any installed Ollama
  model.
- Persisted, per-user conversation history with a conversation-list view inside the same panel.

**Out of scope (explicit deferrals, not oversights):**
- Multi-agent orchestration. ComfyUI-Copilot (the closest real prior art) uses a central assistant +
  specialist worker agents because ComfyUI's node ecosystem is huge and open-ended. GameForge's
  feature surface is small and fully enumerable in one compact doc — a multi-agent split would add
  complexity with no payoff here. Single agent, one model call per user message.
- Rate-limiting / abuse-hardening. This is a 2-person internal tool; the generation features already
  skip this for the same reason.
- A real retrieval/embedding pipeline. The knowledge doc is compact by design (a handful of KB, not a
  manual) — the whole doc is stuffed into the system prompt every call. No vector DB, no chunking, no
  embeddings. Revisit only if the doc later grows past what comfortably fits in a system prompt.
- Multi-round tool-use loops. If the model calls `navigate_to_page`, the client executes the
  navigation and shows whatever text came with it in the same turn — no "navigation succeeded"
  result is fed back to the model for a second round.
- Navigating to dynamic, ID-specific pages (a specific job's edit page, a specific asset). The
  navigation tool's target is an enum of the dashboard's static routes only.
- Conversation rename/delete. Not asked for; add later if it comes up.
- Shared/team visibility on conversations. Each user sees only their own history (see "Ownership"
  below) — no admin override, since this is personal Q&A content, not a shared project resource.

## Why this is feasible now (what it reuses vs. what's new)

GameForge already has most of the hard parts built, from the Ollama generation work:

- **Provider selection**: `lib/services/claudeApiProviders.ts` (`ANTHROPIC_PROVIDER` /
  `CHEAPERINFERENCE_PROVIDER`) and the `THEME_API_PROVIDER` env-var switch, reused for the copilot's
  "Claude" option — but the actual resolution logic (read `THEME_API_PROVIDER`, pick the provider
  object, read the matching API-key env var, throw if misconfigured) is today copy-pasted three times,
  once each as a private block inside `ThemeGenerator.ts`/`ComponentGenerator.ts`/
  `PageLayoutSuggester.ts`'s own lazy-singleton getters — none of it is exported for a fourth caller to
  reuse. This feature adds a fourth caller, which crosses the line into "extract on sight": add one
  exported function, `resolveClaudeProvider()` in `lib/services/claudeApiProviders.ts`, returning
  `{ provider: ClaudeApiProvider; apiKey: string } | { error: string }` (the `error` string being the
  exact "isn't configured" message used in "Error handling" below). The copilot route calls this
  directly; the three existing generators are not changed by this spec (out of scope — they keep their
  own inline copies unless a later cleanup task touches them).
- **Ollama host/model discovery**: `lib/hooks/useOllamaModels.ts` already fetches the installed model
  list and configured host — reused as-is for the copilot's model picker, same `<select>` pattern as
  `app/dashboard/themes/page.tsx` / `app/dashboard/components/page.tsx`.
- **The "no forced tool-choice" lesson**: `lib/services/ollamaToolCall.ts`'s header comment already
  documents that Ollama's API never guarantees a tool call — the generation features treat that as a
  hard failure (they need exactly one structured result). The copilot needs the *opposite* handling:
  no tool call is the normal, expected case (most turns are plain answers), and a tool call is the
  exception. This is a genuinely different contract from `callClaudeTool()`/`callOllamaTool()`, not a
  parameter tweak to them — see "New tool-call helpers" below.
- **Live project grounding**: `app/api/context/route.ts` already exists and already returns current
  styles, asset counts, and in-flight job counts — reused as-is, called once per copilot message and
  folded into the system prompt. That route itself has no auth check today (a pre-existing gap, already
  flagged in `2026-09-08-image-input-design.md`'s correction about sibling serving routes — not
  something this spec introduces or is responsible for fixing). It's called server-side, from inside
  `/api/copilot/message` which is itself auth-gated, so this feature doesn't newly expose it; it's just
  as reachable directly as it was before this spec.
- **Ownership pattern**: `PageService.ts`/`PresetService`-style `{error: 'NOT_FOUND' | 'FORBIDDEN'}`
  returns, scoped by `created_by` — reused for the new conversation service (see "Ownership" below).

What's genuinely new: the conversation loop itself (optional tool use, not forced), the two DB tables
and their routes, and the panel UI (chat view + history view).

## Architecture

### Section 1 — Overall shape

- A new client component, `app/components/CopilotPanel.tsx`, mounted in `app/layout.tsx` alongside
  `NavRail`, so it persists across page navigation without losing in-memory conversation state. A
  floating button (fixed position, bottom-right) toggles the panel open/closed.
- The panel only renders its contents for a logged-in user. `NavRail.tsx` currently does its own
  inline `/api/auth/me` fetch to get `{name, isAdmin}`; `CopilotPanel` needs the same user identity
  (specifically, `user.id`, to scope conversations). Rather than duplicate that fetch+state logic a
  second time, extract it into a shared `lib/hooks/useCurrentUser.ts` hook
  (`{ user: {id, name, isAdmin} | null }`) and switch `NavRail` to use it too. This is the "extract
  shared helpers on sight" rule from `AGENTS.md`, applied to code this feature is already touching.
- One new API route, `app/api/copilot/message/route.ts` — takes the conversation id (optional — omit
  to start a new conversation), the user's message text, and a provider choice, and returns the
  assistant's reply plus an optional navigation action.
- Two new read routes for history: list the current user's conversations, and load one conversation's
  full message list.
- Knowledge grounding: a new file, `docs/copilot-knowledge.md` — a compact, user-facing doc (not
  `AGENTS.md`, which is written for coding agents and is often wrong tone/content for an end-user
  "how do I generate a sprite" question). One entry per dashboard feature/settings page: what it does,
  where to find it, the options that matter. Loaded server-side and included verbatim in the system
  prompt on every call — no chunking, no retrieval step (see "Out of scope" above for why).

### Section 2 — The conversation loop & navigation

- Unlike `claudeToolCall.ts`/`ollamaToolCall.ts` (which *force* exactly one tool call every time), the
  copilot needs **optional** tool use: the model can answer in plain text, call `navigate_to_page`, or
  do both in one turn ("Sure, here's the Ollama settings page" + actually navigate there).
- **New tool-call helpers**, added to the existing provider-specific files rather than new files (they
  already own the retry/timeout/locking plumbing these need, and already exist specifically to be
  shared across callers — see each file's own header comment):
  - `callClaudeMessage()` in `lib/services/claudeToolCall.ts` — same request shape as `callClaudeTool`
    but with `tool_choice: { type: 'auto' }` instead of forcing a specific tool, and response parsing
    that extracts *both* any text block and an optional `tool_use` block (`callClaudeTool` only ever
    looks for the latter and throws if it's missing — wrong contract here).
  - `callOllamaMessage()` in `lib/services/ollamaToolCall.ts` — same `/api/chat` request shape as
    `callOllamaTool`, but treats a missing `tool_calls` entry as the normal case (returns
    `data.message.content` as text) instead of throwing `OLLAMA_NO_TOOL_CALL_ERROR_PREFIX`.
  - Both return the same shape: `{ text: string; toolCall?: { name: string; input: unknown } }`.
- **Navigation is one tool**, `navigate_to_page`, with a single `path` argument constrained to an enum
  of GameForge's real static dashboard routes — never an arbitrary model-constructed URL:

  ```
  /dashboard/generate, /dashboard/ui-sheets, /dashboard/themes, /dashboard/components,
  /dashboard/jobs, /dashboard/assets, /dashboard/styles, /dashboard/presets, /dashboard/export,
  /dashboard/drive, /dashboard/settings/storage, /dashboard/settings/aseprite,
  /dashboard/settings/seed-themes, /dashboard/settings/google-drive, /dashboard/settings/ollama
  ```

  (Exactly `NavRail.tsx`'s existing `LINKS` array, but `NavRail.tsx` is a `'use client'` component and
  this enum is built server-side when constructing the tool schema — so `LINKS` moves to a new shared,
  non-client file, `lib/dashboardRoutes.ts`, exporting `DASHBOARD_ROUTES: {href, label}[]`. `NavRail`
  imports it for its link list; the copilot's tool-schema builder imports it and maps to `href` for the
  enum. One source of truth, usable from both a client component and a server route.)
- **No multi-round tool-result loop.** If the response includes a `toolCall`, the client calls
  `router.push(toolCall.input.path)` directly and renders `text` in the same turn. The "navigation
  succeeded" fact is never sent back to the model.
- **Dynamic pages (a specific job, a specific asset) are not navigable targets.** The model has no way
  to know a valid id for one, and the tool's schema has no field for it.

### Section 3 — Knowledge grounding & confidence escalation

- Every `/api/copilot/message` call assembles one system prompt from three parts, fresh each time (no
  caching across turns — the live-context part can change between messages):
  1. The full contents of `docs/copilot-knowledge.md`.
  2. The current JSON from `GET /api/context` (styles, asset counts, in-flight job counts), so advice
     is grounded in the user's actual project, not generic.
  3. A fixed escalation instruction: *if the knowledge doc and the live context don't clearly answer
     the question, say so plainly and ask a clarifying question instead of guessing.* This is a
     prompt-level behavior, not a computed confidence score — there's no retrieval-confidence metric
     available from either provider's API to threshold on. It's the mechanism Intercom Fin uses
     (ground answers in curated docs, and *ask rather than confidently answer wrong* when the docs
     don't cover it) — adapted here as an explicit instruction rather than a measured value, since
     GameForge has no infrastructure to measure one.
- The prior turns of the *current* conversation are passed as the `messages` array (role `user` /
  `assistant`), same as any standard chat loop. No messages from other conversations are ever included.

### Section 4 — Persistence & history

**Tables** (migration `016_add_copilot_tables.sql`, following this codebase's plain-SQL, no-ORM
convention — see `lib/database/migrations/012_add_presets.sql` / `013_add_pages.sql` for the pattern
being matched):

```sql
CREATE TABLE copilot_conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_copilot_conversations_created_by ON copilot_conversations(created_by);

CREATE TABLE copilot_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES copilot_conversations(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  tool_call TEXT, -- JSON-serialized {name, input}, set only on an assistant turn that navigated
  provider TEXT CHECK (provider IN ('claude', 'ollama')), -- null on a user-authored row
  model TEXT, -- the specific model name that answered, e.g. "claude-sonnet-5" or "llama3-groq-tool-use:8b"
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_copilot_messages_conversation_id ON copilot_messages(conversation_id);
```

No `is_deleted` column — there's no delete/soft-delete feature in this version (see "Out of scope").

**Ownership.** Conversations are private per-user, scoped by `created_by`, matching the
`PageService`/`PresetService` pattern — but *without* an `isAdmin` override, since this feature has no
mutation that needs one (no update/delete route exists) and the content is personal Q&A, not a shared
project asset. `CopilotConversationService.list(userId)` and `.getWithMessages(id, userId)` simply
filter/check against `created_by` with no admin bypass path.

**Title.** Set once, at creation, to the first user message truncated to 60 characters (plus an
ellipsis if truncated). No separate "generate a title" model call — unnecessary cost/complexity for
a 2-person tool; the truncated first message is informative enough in a short list.

**Routes:**
- `GET /api/copilot/conversations` — the requesting user's conversations, `{id, title, updatedAt}[]`,
  newest first.
- `GET /api/copilot/conversations/[id]` — one conversation's full message list, `{error: 'FORBIDDEN'}`
  if `created_by` doesn't match the requesting user, `{error: 'NOT_FOUND'}` if it doesn't exist.
- `POST /api/copilot/message` — body `{ conversationId?: string, text: string, provider?: 'claude' |
  'ollama', model?: string, ollamaHost?: string }`, `model` and `ollamaHost` required together when
  `provider` is `'ollama'` — the exact same schema shape `app/api/generate/route.ts` already validates
  with (`z.enum(['claude','ollama']).optional()` + a `superRefine` requiring `model`+`ollamaHost`
  together), reused rather than re-invented. The panel's local picker state (one `<select>` holding
  either `'claude'` or a model name, same as the Themes/Components pages) translates to this wire shape
  client-side exactly like those pages already do. If `conversationId` is supplied, the route loads it
  first and returns `{error: 'FORBIDDEN'}` (403) if `created_by` doesn't match the requesting user, or
  `{error: 'NOT_FOUND'}` (404) if it doesn't exist — same ownership check as `GET .../[id]`, not
  skipped just because this route writes instead of reads. If `conversationId` is omitted, creates a
  new conversation first. Appends the user's message, calls the resolved provider, appends the
  assistant's reply (including `tool_call` if one was made), and returns
  `{ conversationId, reply: { text, toolCall? } }`.

All three routes require a logged-in user (`getCurrentUser(req)` from `lib/utils/session.ts`, the same
helper `app/api/auth/me/route.ts` and the export-sync apply route already use) and return 401 if absent.

**Panel UI.** `CopilotPanel` has two modes, `'chat' | 'history'`, toggled by a button inside the panel
— not a separate page, and not a sidebar competing with the dashboard's own `NavRail`:
- **Chat mode**: the active conversation's messages, a text input, the Claude/Ollama provider picker
  (identical `<select>` markup to the Themes/Components pages, backed by `useOllamaModels()`), a
  "History" button, and a "New chat" button (clears `activeConversationId` and the in-memory message
  list, switches back to chat mode with an empty conversation).
- **History mode**: the list from `GET /api/copilot/conversations` (title + relative date, newest
  first). Clicking one fetches `GET /api/copilot/conversations/[id]`, sets it as the active
  conversation, and switches back to chat mode.

## Error handling

- **No Claude key configured, Claude selected.** Mirrors the Critical bug found and fixed in the
  Ollama generation work (selecting a provider with no working backend used to silently fake success
  via an unguarded Mock fallback). The copilot has no mock backend at all — if neither
  `ANTHROPIC_API_KEY` nor `CHEAPERINFERENCE_API_KEY` resolves for the configured
  `THEME_API_PROVIDER`, `POST /api/copilot/message` returns a clear `503` with `"Claude isn't
  configured — set ANTHROPIC_API_KEY or CHEAPERINFERENCE_API_KEY, or pick an installed Ollama model
  instead."` No silent degradation.
- **Ollama unreachable / model not installed.** Same `fetch` failure surface the generation features
  already handle — returned as a `502` with the underlying error message. `callOllamaMessage()` makes
  a single attempt, no retry, exactly like `callOllamaTool()` does today (a local daemon either
  responds or it doesn't; there's no transient-failure retry logic to mirror).
- **Malformed `tool_call.input` from either provider** (e.g. a `path` not in the enum). Zod-validate
  the tool input same as every existing generator; on failure, drop the tool call and still return the
  text part of the reply — a bad navigation attempt shouldn't blank out an otherwise-good text answer.

## Testing

- `CopilotConversationService`/`CopilotMessageService`: unit tests against a real temporary SQLite
  file (`setProjectRootForTests()` + `DatabaseConnection.resetForTests()`, the project's established
  pattern), covering creation, listing scoped to `created_by`, and the `FORBIDDEN`/`NOT_FOUND` paths
  on `getWithMessages()`.
- `callClaudeMessage()`/`callOllamaMessage()`: unit tests with `fetch` mocked at the module boundary
  (same style as the existing `claudeToolCall`/`ollamaToolCall` tests), covering: text-only reply, reply
  with a tool call, and (Ollama only) the case where `tool_calls` is absent and `content` is returned
  as plain text.
- `navigate_to_page`'s enum: one test asserting it's derived from `lib/dashboardRoutes.ts`'s
  `DASHBOARD_ROUTES` rather than a second hardcoded list, so the two can't silently drift.
- `/api/copilot/message`: integration-style test covering the "no Claude key configured" 503 path
  explicitly, given that exact bug class's history in this codebase.

## Follow-ups explicitly deferred, not forgotten

- Conversation rename/delete.
- A real retrieval step, if `docs/copilot-knowledge.md` ever grows past comfortably fitting a system
  prompt.
- Reading `ollamaHost` server-side from saved Settings instead of per-request from the client — the
  Ollama generation work's final review already flagged this exact looseness as a deliberate,
  scoped-out follow-up; the copilot inherits the same `ollamaHost` wire shape and therefore the same
  follow-up, not a new instance of it.
