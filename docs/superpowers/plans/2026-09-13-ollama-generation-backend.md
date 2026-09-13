# Ollama Generation Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick a local Ollama model instead of Claude, per generation, for themes/components/page-layout suggestions — with no change to those generators' output shape or downstream pipeline.

**Architecture:** A new `ollamaToolCall.ts` mirrors `claudeToolCall.ts`'s call shape for a second provider; each of the 3 existing generators gains one optional trailing parameter (a provider override) rather than a new abstraction layer; provider/model choice threads through the existing `jobs.options` JSON column (theme/component) or directly in the request body (page-layout, which isn't job-queued); a new Settings page handles connection config, live model discovery, and one-click model pulls with real progress.

**Tech Stack:** Next.js App Router, TypeScript, Vitest (mocked `fetch`, no real Ollama in CI), no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-13-ollama-generation-backend-design.md` (paired review log: `docs/superpowers/specs/2026-09-13-ollama-generation-backend-design-review-log.md`)

## Global Constraints

- No new npm dependencies.
- `ollamaToolCall.ts` calls Ollama's **native** `/api/chat`, never the OpenAI-compatible endpoint (no way to set `num_ctx` there).
- `stream: false` on every chat call — avoids a documented bug where Ollama's OpenAI-compat layer drops streamed `tool_calls`.
- `options.num_ctx` is a single generous constant (8192) — all 3 in-scope schemas are small and flat, verified directly against the real schema definitions; no per-call token-estimation formula.
- A missing/malformed tool call **hard-fails** immediately — no automatic retry. A distinct, user-initiated "Retry with correction" action exists instead (Task 10).
- A single module-level mutex serializes all Ollama calls from this process (one in flight at a time) — `worker.ts` already processes up to `WORKER_BATCH_SIZE` (default 5) jobs concurrently, which is fine for a cloud API but a real resource-contention risk for one local Ollama daemon.
- Ollama is **not offered** as a provider option when a reference image is attached, and the in-scope generators never pass an Ollama provider through for `outputKind: 'image'` — enforced at the route layer (the trust boundary), not just hidden in the UI.
- `User.is_admin` is `0|1` — not used by this plan (no ownership/admin logic here; job-retry routes already enforce creator-or-admin, reused unchanged).
- Every test mocks `fetch` — this codebase's CI (`ubuntu-latest`) has no GPU and no Ollama daemon; nothing here may depend on a real model.

---

## Task 1: `ollamaToolCall.ts` — the core helper

**Files:**
- Create: `lib/services/ollamaToolCall.ts`
- Test: `test/ollamaToolCall.test.ts`

**Interfaces:**
- Produces: `callOllamaTool(params: OllamaToolCallParams): Promise<unknown>`, `OLLAMA_NO_TOOL_CALL_ERROR_PREFIX: string`, `OllamaProviderOverride` type (`{ type: 'ollama'; host: string; model: string; correctionRequested?: boolean }`) — **Task 2 depends on all three.**

- [ ] **Step 1: Write the failing tests**

```typescript
// test/ollamaToolCall.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callOllamaTool, OLLAMA_NO_TOOL_CALL_ERROR_PREFIX } from '@/lib/services/ollamaToolCall';

const baseParams = {
  host: 'http://localhost:11434',
  model: 'llama3-groq-tool-use:8b',
  toolName: 'emit_theme',
  toolDescription: 'Emit a theme',
  inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  messages: [{ role: 'user', content: 'hello' }],
  operationLabel: 'theme generation',
  truncatedMessage: 'the theme could not be generated',
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('callOllamaTool', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts to the native /api/chat endpoint, non-streaming, with the one tool and num_ctx set', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      message: { tool_calls: [{ function: { name: 'emit_theme', arguments: { colorBackground: '#000' } } }] },
    }));

    await callOllamaTool(baseParams);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:11434/api/chat');
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(false);
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'emit_theme', description: 'Emit a theme', parameters: baseParams.inputSchema } },
    ]);
    expect(body.options.num_ctx).toBeGreaterThanOrEqual(8192);
  });

  it('returns the tool call arguments directly when already structured', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      message: { tool_calls: [{ function: { name: 'emit_theme', arguments: { colorBackground: '#111' } } }] },
    }));
    const result = await callOllamaTool(baseParams);
    expect(result).toEqual({ colorBackground: '#111' });
  });

  it('JSON.parses a stringified nested argument', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      message: { tool_calls: [{ function: { name: 'emit_theme', arguments: '{"order":[1,2,3]}' } }] },
    }));
    const result = await callOllamaTool(baseParams);
    expect(result).toEqual({ order: [1, 2, 3] });
  });

  it('hard-fails with the shared error prefix when a stringified argument is malformed', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      message: { tool_calls: [{ function: { name: 'emit_theme', arguments: '{"order":[1,2' } }] },
    }));
    await expect(callOllamaTool(baseParams)).rejects.toThrow(OLLAMA_NO_TOOL_CALL_ERROR_PREFIX);
  });

  it('hard-fails with the shared error prefix when the model returns no tool call at all', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      message: { role: 'assistant', content: 'Sure, here is a theme for you...' },
    }));
    await expect(callOllamaTool(baseParams)).rejects.toThrow(OLLAMA_NO_TOOL_CALL_ERROR_PREFIX);
  });

  it('treats prompt_eval_count reaching num_ctx as truncation, not a clean response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      message: { tool_calls: [{ function: { name: 'emit_theme', arguments: {} } }] },
      prompt_eval_count: 8192,
    }));
    await expect(callOllamaTool(baseParams)).rejects.toThrow('truncated');
  });

  it('throws a specific error on an HTTP failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'model not found' }, false, 404));
    await expect(callOllamaTool(baseParams)).rejects.toThrow(/theme generation failed \(404\)/);
  });

  it('serializes concurrent calls -- the second fetch does not fire until the first resolves', async () => {
    // Both mock behaviors are queued up front, before either call starts --
    // queuing the second one later (e.g. between two `await`s) would race
    // against exactly when the second call's own fetch actually fires.
    let resolveFirst!: (value: Response) => void;
    const successResponse = jsonResponse({ message: { tool_calls: [{ function: { name: 'emit_theme', arguments: {} } }] } });
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveFirst = resolve; }));
    fetchMock.mockResolvedValueOnce(successResponse);

    const first = callOllamaTool(baseParams);
    const second = callOllamaTool(baseParams);

    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1); // second call hasn't fired its fetch yet

    resolveFirst(successResponse);
    await first;
    await second;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/ollamaToolCall.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/ollamaToolCall'`

- [ ] **Step 3: Write the implementation**

```typescript
// lib/services/ollamaToolCall.ts
//
// Mirrors claudeToolCall.ts's call shape for a second provider. Ollama has
// no forced tool-choice (confirmed directly against Ollama's own API docs)
// -- the model decides for itself whether to call the one tool offered,
// and can just return plain text instead. Since only one tool is ever
// offered, "wrong tool" isn't a real risk; "no tool call at all" is a
// real, EXPECTED failure mode here, not a rare edge case, and every branch
// below treats it that way.

// Local inference (especially CPU-only) is much slower than a cloud API --
// claudeToolCall.ts's 60s is too tight here.
const OLLAMA_REQUEST_TIMEOUT_MS = 120_000;

// All 3 in-scope schemas (theme tokens, component html/css, page-layout
// order array) are small and flat -- verified directly against their real
// definitions, none use oneOf/anyOf/enum. One generous constant covers
// prompt + schema + output for all 3 without a per-call estimation formula.
const DEFAULT_NUM_CTX = 8192;

export const OLLAMA_NO_TOOL_CALL_ERROR_PREFIX = 'Ollama model did not produce structured output';

export interface OllamaProviderOverride {
  type: 'ollama';
  host: string;
  model: string;
  /** Set by the "Retry with correction" flow (Task 10) to add one corrective instruction. */
  correctionRequested?: boolean;
}

export interface OllamaToolCallParams {
  host: string;
  model: string;
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  messages: Array<{ role: string; content: unknown }>;
  signal?: AbortSignal;
  /** e.g. "theme generation" -- used in the HTTP-failure and truncation error messages. */
  operationLabel: string;
  /** e.g. "the theme could not be generated" -- used in the truncation error message. */
  truncatedMessage: string;
}

interface OllamaChatResponse {
  message: {
    role: string;
    content: string;
    tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
  };
  done: boolean;
  prompt_eval_count?: number;
}

function combineWithTimeout(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(OLLAMA_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
}

// GameForge's worker processes up to WORKER_BATCH_SIZE (default 5) jobs
// concurrently (see worker.ts's processJobs()) -- fine for a cloud API that
// scales independently of this machine, but firing several concurrent
// generations at one local Ollama daemon on typical consumer hardware (one
// GPU, finite VRAM) risks real resource contention. This serializes every
// Ollama call from this process: one in flight at a time, others wait
// their turn. A single global lock, not per-host/per-model -- the
// simplest thing that removes the real risk.
let ollamaCallLock: Promise<void> = Promise.resolve();

async function withOllamaLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = ollamaCallLock;
  let release!: () => void;
  ollamaCallLock = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Calls Ollama's native /api/chat (never the OpenAI-compatible endpoint --
 * that endpoint has no way to set num_ctx, risking silent truncation of a
 * large tool schema under the small default context window) with a single
 * offered tool, and returns the tool call's raw `arguments` -- the caller
 * does its own Zod parse against its own tool's schema, same contract as
 * callClaudeTool. Throws a specific Error for an HTTP failure, a
 * truncation, and -- the real, expected case with Ollama -- no tool call
 * at all.
 */
export async function callOllamaTool(params: OllamaToolCallParams): Promise<unknown> {
  const { host, model, toolName, toolDescription, inputSchema, messages, signal, operationLabel, truncatedMessage } = params;

  return withOllamaLock(async () => {
    const res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages,
        tools: [{ type: 'function', function: { name: toolName, description: toolDescription, parameters: inputSchema } }],
        options: { num_ctx: DEFAULT_NUM_CTX },
      }),
      signal: combineWithTimeout(signal),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama ${operationLabel} failed (${res.status}): ${body || res.statusText}`);
    }

    const data = (await res.json()) as OllamaChatResponse;

    if (typeof data.prompt_eval_count === 'number' && data.prompt_eval_count >= DEFAULT_NUM_CTX) {
      throw new Error(`Ollama response for ${operationLabel} was truncated (prompt_eval_count reached num_ctx) -- ${truncatedMessage}.`);
    }

    const toolCall = data.message?.tool_calls?.[0];
    if (!toolCall) {
      throw new Error(`${OLLAMA_NO_TOOL_CALL_ERROR_PREFIX} for ${toolName} (model: ${model}) -- try a different model, or retry with a correction.`);
    }

    const args = toolCall.function.arguments;
    if (typeof args === 'string') {
      // Nested tool-call arguments come back as a JSON-encoded string, not
      // structured JSON -- a real, documented Ollama quirk. A malformed
      // string maps to the same hard-fail error as "no tool call at all",
      // not a raw parse exception -- the request was fine, the model's
      // output wasn't.
      try {
        return JSON.parse(args);
      } catch {
        throw new Error(`${OLLAMA_NO_TOOL_CALL_ERROR_PREFIX} for ${toolName} (model: ${model}) -- the model's structured output was malformed.`);
      }
    }
    return args;
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/ollamaToolCall.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/services/ollamaToolCall.ts test/ollamaToolCall.test.ts
git commit -m "feat: add callOllamaTool, the Ollama-backed sibling of callClaudeTool"
```

---

## Task 2: Wire Ollama into the 3 generators

Same mechanical change applied 3 times — batched into one task per this project's own "batch small same-shape work" convention, since splitting it into 3 separate review gates for an identical pattern would be pure overhead.

**Files:**
- Modify: `lib/services/ThemeGenerator.ts` (interface + `MockThemeGenerator` signature only — this file only re-exports/imports `ClaudeApiThemeGenerator`, it doesn't define it)
- Modify: `lib/services/ClaudeApiThemeGenerator.ts` (**correction, found during Task 2's own implementation**: `ClaudeApiThemeGenerator` is defined in its own file, not inside `ThemeGenerator.ts` as originally written here — the dispatch logic below belongs in this file)
- Modify: `lib/services/ComponentGenerator.ts`
- Modify: `lib/services/PageLayoutSuggester.ts`
- Modify: `test/themeGenerator.test.ts`
- Modify: `test/componentGenerator.test.ts`
- Modify: `test/pageLayoutSuggester.test.ts`

**Interfaces:**
- Consumes: `callOllamaTool`, `OLLAMA_NO_TOOL_CALL_ERROR_PREFIX`, `OllamaProviderOverride` (Task 1).
- Produces: `ThemeGenerator.generate(prompt, styleId, referenceImage?, basedOnContent?, signal?, providerOverride?: OllamaProviderOverride)`, `ComponentGenerator.generate(prompt, styleId, componentType?, referenceImage?, basedOnContent?, signal?, providerOverride?)`, `PageLayoutSuggester.suggest(pageName, candidates, signal?, providerOverride?)` — **Tasks 3 and 4 depend on these exact signatures (the new param is always last).**

- [ ] **Step 1: Write the failing tests**

Append to each existing test file (exact location doesn't matter — add alongside the other `describe`/`it` blocks already there):

```typescript
// Append to test/themeGenerator.test.ts
import { callOllamaTool } from '@/lib/services/ollamaToolCall';
vi.mock('@/lib/services/ollamaToolCall', () => ({ callOllamaTool: vi.fn() }));

// ...inside the existing describe block, or a new one:
it('calls callOllamaTool instead of callClaudeTool when a providerOverride is given', async () => {
  (callOllamaTool as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    colorBackground: '#000', colorForeground: '#fff', colorAccent: '#f00', colorBorder: '#333',
    fontHeading: 'serif', fontBody: 'sans', spaceUnit: '8px', radiusBase: '4px',
  });
  const generator = new ClaudeApiThemeGenerator('fake-key', ANTHROPIC_PROVIDER);
  await generator.generate('warm', 'style-1', undefined, undefined, undefined, {
    type: 'ollama', host: 'http://localhost:11434', model: 'llama3-groq-tool-use:8b',
  });
  expect(callOllamaTool).toHaveBeenCalledWith(expect.objectContaining({
    host: 'http://localhost:11434',
    model: 'llama3-groq-tool-use:8b',
    toolName: 'emit_theme',
  }));
});
```

```typescript
// Append to test/componentGenerator.test.ts
import { callOllamaTool } from '@/lib/services/ollamaToolCall';
vi.mock('@/lib/services/ollamaToolCall', () => ({ callOllamaTool: vi.fn() }));

it('calls callOllamaTool instead of callClaudeTool when a providerOverride is given', async () => {
  (callOllamaTool as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ html: '<button>Go</button>', css: '.btn{}' });
  const generator = new ClaudeApiComponentGenerator('fake-key', ANTHROPIC_PROVIDER);
  await generator.generate('a button', 'style-1', undefined, undefined, undefined, undefined, {
    type: 'ollama', host: 'http://localhost:11434', model: 'llama3-groq-tool-use:8b',
  });
  expect(callOllamaTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'emit_component' }));
});
```

```typescript
// Append to test/pageLayoutSuggester.test.ts
import { callOllamaTool } from '@/lib/services/ollamaToolCall';
vi.mock('@/lib/services/ollamaToolCall', () => ({ callOllamaTool: vi.fn() }));

it('calls callOllamaTool instead of callClaudeTool when a providerOverride is given', async () => {
  (callOllamaTool as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ order: [0] });
  const suggester = new ClaudeApiPageLayoutSuggester('fake-key', ANTHROPIC_PROVIDER);
  const result = await suggester.suggest('Home', [{ id: 'c1', assetType: 'nav', prompt: 'navbar' }], undefined, {
    type: 'ollama', host: 'http://localhost:11434', model: 'llama3-groq-tool-use:8b',
  });
  expect(callOllamaTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'emit_page_layout' }));
  expect(result).toEqual(['c1']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/themeGenerator.test.ts test/componentGenerator.test.ts test/pageLayoutSuggester.test.ts`
Expected: FAIL — each generator's `generate`/`suggest` call currently accepts fewer arguments; `callOllamaTool` is never called.

- [ ] **Step 3: Modify `ThemeGenerator.ts`**

In the `ThemeGenerator` interface, add the trailing param:

```typescript
export interface ThemeGenerator {
  generate(prompt: string, styleId: string, referenceImage?: ReferenceImagePayload, basedOnContent?: string, signal?: AbortSignal, providerOverride?: OllamaProviderOverride): Promise<GeneratedTheme>;
}
```

Add the import at the top: `import { callOllamaTool, type OllamaProviderOverride } from '@/lib/services/ollamaToolCall';`

In `ClaudeApiThemeGenerator.generate()`, change the signature to accept the new param and dispatch on it, replacing the existing `callClaudeTool` call:

```typescript
async generate(prompt: string, styleId: string, referenceImage?: ReferenceImagePayload, basedOnContent?: string, signal?: AbortSignal, providerOverride?: OllamaProviderOverride): Promise<GeneratedTheme> {
  // ...unchanged code above (style/avoidColors/fullPrompt/content building)...

  const toolInput = providerOverride
    ? await callOllamaTool({
        host: providerOverride.host,
        model: providerOverride.model,
        toolName: 'emit_theme',
        toolDescription: 'Emit a website design token set matching the requested aesthetic.',
        inputSchema: TOOL_INPUT_SCHEMA,
        messages: [{ role: 'user', content: providerOverride.correctionRequested
          ? `${fullPrompt}\n\nYou did not call the emit_theme tool last time -- you must call it now with valid arguments matching its schema.`
          : content }],
        signal,
        operationLabel: 'theme generation',
        truncatedMessage: 'the theme could not be generated',
      })
    : await callClaudeTool({
        provider: this.provider,
        apiKey: this.apiKey,
        toolName: 'emit_theme',
        toolDescription: 'Emit a website design token set matching the requested aesthetic.',
        inputSchema: TOOL_INPUT_SCHEMA,
        messages: [{ role: 'user', content }],
        signal,
        operationLabel: 'theme generation',
        truncatedMessage: 'the theme could not be generated',
      });

  // ...unchanged code below (ThemeTokensSchema.parse, file write)...
}
```

Note: the correction text replaces `content` (which may be the multimodal array) with a plain string built from `fullPrompt` — this is safe because `providerOverride` is never present alongside a reference image (enforced at the route layer in Task 3), so `content` is always a plain string whenever `providerOverride` is set.

In `MockThemeGenerator.generate()`, add the same trailing param, unused (prefixed `_`, matching this file's existing convention for unused params):

```typescript
async generate(prompt: string, _styleId: string, _referenceImage?: ReferenceImagePayload, _basedOnContent?: string, _signal?: AbortSignal, _providerOverride?: OllamaProviderOverride): Promise<GeneratedTheme> {
```

- [ ] **Step 4: Modify `ComponentGenerator.ts`** — identical pattern

Interface:
```typescript
export interface ComponentGenerator {
  generate(prompt: string, styleId: string, componentType?: string, referenceImage?: ReferenceImagePayload, basedOnContent?: string, signal?: AbortSignal, providerOverride?: OllamaProviderOverride): Promise<GeneratedComponent>;
}
```

`ClaudeApiComponentGenerator.generate()` gains the param and the same dispatch:

```typescript
async generate(prompt: string, styleId: string, componentType?: string, referenceImage?: ReferenceImagePayload, basedOnContent?: string, signal?: AbortSignal, providerOverride?: OllamaProviderOverride): Promise<GeneratedComponent> {
  // ...unchanged code above (style/fullPrompt/content building)...

  const toolInput = providerOverride
    ? await callOllamaTool({
        host: providerOverride.host,
        model: providerOverride.model,
        toolName: 'emit_component',
        toolDescription: 'Emit a single website UI component as HTML and CSS.',
        inputSchema: TOOL_INPUT_SCHEMA,
        messages: [{ role: 'user', content: providerOverride.correctionRequested
          ? `${fullPrompt}\n\nYou did not call the emit_component tool last time -- you must call it now with valid arguments matching its schema.`
          : content }],
        signal,
        operationLabel: 'component generation',
        truncatedMessage: 'the component could not be generated',
      })
    : await callClaudeTool({
        provider: this.provider,
        apiKey: this.apiKey,
        toolName: 'emit_component',
        toolDescription: 'Emit a single website UI component as HTML and CSS.',
        inputSchema: TOOL_INPUT_SCHEMA,
        messages: [{ role: 'user', content }],
        signal,
        operationLabel: 'component generation',
        truncatedMessage: 'the component could not be generated',
      });

  // ...unchanged code below (raw = z.object({html,css}).parse(toolInput), etc.)...
}
```

`MockComponentGenerator.generate()` gains the same trailing unused param.

- [ ] **Step 5: Modify `PageLayoutSuggester.ts`**

Interface:
```typescript
export interface PageLayoutSuggester {
  suggest(pageName: string, candidates: PageLayoutComponentCandidate[], signal?: AbortSignal, providerOverride?: OllamaProviderOverride): Promise<string[]>;
}
```

`ClaudeApiPageLayoutSuggester.suggest()`:

```typescript
async suggest(pageName: string, candidates: PageLayoutComponentCandidate[], signal?: AbortSignal, providerOverride?: OllamaProviderOverride): Promise<string[]> {
  if (candidates.length === 0) return [];

  const prompt = buildLayoutPrompt(pageName, candidates);
  const input = providerOverride
    ? await callOllamaTool({
        host: providerOverride.host,
        model: providerOverride.model,
        toolName: 'emit_page_layout',
        toolDescription: 'Emit the ordered list of component indices that belong on this page.',
        inputSchema: TOOL_INPUT_SCHEMA,
        messages: [{ role: 'user', content: providerOverride.correctionRequested
          ? `${prompt}\n\nYou did not call the emit_page_layout tool last time -- you must call it now with valid arguments matching its schema.`
          : prompt }],
        signal,
        operationLabel: 'page layout suggestion',
        truncatedMessage: 'the layout could not be suggested',
      })
    : await callClaudeTool({
        provider: this.provider,
        apiKey: this.apiKey,
        toolName: 'emit_page_layout',
        toolDescription: 'Emit the ordered list of component indices that belong on this page.',
        inputSchema: TOOL_INPUT_SCHEMA,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 1024,
        signal,
        operationLabel: 'page layout suggestion',
        truncatedMessage: 'the layout could not be suggested',
      });

  // ...unchanged validation/mapping code below...
}
```

`MockPageLayoutSuggester.suggest()` gains the same trailing unused param.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/themeGenerator.test.ts test/componentGenerator.test.ts test/pageLayoutSuggester.test.ts`
Expected: PASS, plus every pre-existing test in these 3 files still passes (the new param is optional and trailing, so no existing call site breaks)

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS / clean — confirms `MockThemeGenerator`/`MockComponentGenerator`/`MockPageLayoutSuggester` still satisfy their interfaces after the signature change

- [ ] **Step 8: Commit**

```bash
git add lib/services/ThemeGenerator.ts lib/services/ComponentGenerator.ts lib/services/PageLayoutSuggester.ts test/themeGenerator.test.ts test/componentGenerator.test.ts test/pageLayoutSuggester.test.ts
git commit -m "feat: thread an Ollama provider override through the 3 tool-calling generators"
```

---

## Task 3: `/api/generate` route + `worker.ts` — provider selection for theme/component jobs

**Files:**
- Modify: `app/api/generate/route.ts`
- Modify: `worker.ts`
- Modify: `test/generateRoute.test.ts`
- Modify: `test/workerThemeRouting.test.ts`
- Modify: `test/workerReferenceImage.test.ts` (**correction, found during Task 3's own implementation**: this pre-existing file has 3 assertions that call `toHaveBeenCalledWith(...)` on the theme generator with the OLD 4-positional-arg shape; once `worker.ts`'s `case 'theme':` branch always passes the 2 new trailing args, these 3 assertions fail on arg-count alone unless each gains `, undefined, undefined` at the end — no change to what's being tested, just matching the real, wider call signature)

**Interfaces:**
- Consumes: `ThemeGenerator.generate(...,providerOverride?)`, `ComponentGenerator.generate(...,providerOverride?)` (Task 2).
- Produces: `GenerateSchema` gains `provider?: 'claude'|'ollama'`, `model?: string`, `ollamaHost?: string`; `job.options` gains the same 3 keys (theme/component jobs only) — **Task 10 depends on this exact shape (`options.provider`, `options.model`, `options.ollamaHost`).**

- [ ] **Step 1: Write the failing tests**

Append to `test/generateRoute.test.ts`:

```typescript
it('rejects an ollama provider combined with a reference image', async () => {
  const res = await POST(makeRequest({
    styleId: STYLE_ID, assetType: 'theme', prompt: 'warm', outputKind: 'theme',
    provider: 'ollama', model: 'llama3-groq-tool-use:8b', ollamaHost: 'http://localhost:11434',
    referenceImage: { base64: 'AAAA', mediaType: 'image/png' },
  }));
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toMatch(/reference image/i);
});

it('rejects an ollama provider for image (sprite) generation', async () => {
  const res = await POST(makeRequest({
    styleId: STYLE_ID, assetType: 'button', prompt: 'a button', outputKind: 'image',
    provider: 'ollama', model: 'llama3-groq-tool-use:8b', ollamaHost: 'http://localhost:11434',
  }));
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toMatch(/image/i);
});

it('stores provider/model/ollamaHost in the job options when an ollama provider is given for a theme job', async () => {
  const res = await POST(makeRequest({
    styleId: STYLE_ID, assetType: 'theme', prompt: 'warm', outputKind: 'theme',
    provider: 'ollama', model: 'llama3-groq-tool-use:8b', ollamaHost: 'http://localhost:11434',
  }));
  expect(res.status).toBe(200);
  const body = await res.json();
  const storedOptions = JSON.parse((await jobService.getById(body.data.id))!.options);
  expect(storedOptions.provider).toBe('ollama');
  expect(storedOptions.model).toBe('llama3-groq-tool-use:8b');
  expect(storedOptions.ollamaHost).toBe('http://localhost:11434');
});
```

(`makeRequest`, `STYLE_ID`, and `jobService` — use whatever helper/import this test file's existing tests already use; they're established earlier in the same file.)

Append to `test/workerThemeRouting.test.ts`:

```typescript
it('passes a providerOverride to the theme generator when the job options request ollama', async () => {
  const generateSpy = vi.fn().mockResolvedValue({ path: 'theme-x.css', prompt: 'warm' });
  vi.spyOn(await import('@/lib/services/ThemeGenerator'), 'getThemeGenerator').mockReturnValue({ generate: generateSpy });

  const job = {
    id: 'job-1', style_id: 'style-1', prompt: 'warm', output_kind: 'theme',
    options: JSON.stringify({ provider: 'ollama', model: 'llama3-groq-tool-use:8b', ollamaHost: 'http://localhost:11434' }),
  };
  await processJob(job as any);

  expect(generateSpy).toHaveBeenCalledWith('warm', 'style-1', undefined, undefined, undefined, {
    type: 'ollama', host: 'http://localhost:11434', model: 'llama3-groq-tool-use:8b',
  });
});

it('passes a providerOverride to the component generator when the job options request ollama', async () => {
  const generateSpy = vi.fn().mockResolvedValue({ path: 'component-x.html', prompt: 'a button' });
  vi.spyOn(await import('@/lib/services/ComponentGenerator'), 'getComponentGenerator').mockReturnValue({ generate: generateSpy });

  const job = {
    id: 'job-2', style_id: 'style-1', prompt: 'a button', output_kind: 'component',
    options: JSON.stringify({ provider: 'ollama', model: 'llama3-groq-tool-use:8b', ollamaHost: 'http://localhost:11434' }),
  };
  await processJob(job as any);

  expect(generateSpy).toHaveBeenCalledWith('a button', 'style-1', undefined, undefined, undefined, undefined, {
    type: 'ollama', host: 'http://localhost:11434', model: 'llama3-groq-tool-use:8b',
  });
});
```

(**Correction, found during Task 3's own implementation**: the line above originally had one fewer
`undefined` — `ComponentGenerator.generate()`'s real, Task-2-established signature is 7 positional
parameters [`prompt, styleId, componentType?, referenceImage?, basedOnContent?, signal?,
providerOverride?`], and the worker.ts call site below already calls it with all 7; the expected-args
assertion needs 6 values before the override object, not 5, to match.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/generateRoute.test.ts test/workerThemeRouting.test.ts`
Expected: FAIL — the route doesn't know about `provider`/`model`/`ollamaHost` yet; `processJob` never reads them.

- [ ] **Step 3: Modify `app/api/generate/route.ts`**

Add to `GenerateSchema`:

```typescript
const GenerateSchema = z.object({
  styleId: z.string().uuid(),
  assetType: z.string().min(1),
  prompt: z.string().min(1).max(2000),
  options: z.record(z.string(), z.unknown()).optional(),
  outputKind: z.enum(['image', 'theme', 'component']).optional(),
  candidateCount: z.union([z.literal(1), z.literal(3), z.literal(5)]).optional(),
  referenceImage: ReferenceImageSchema.optional(),
  basedOnAssetId: z.string().uuid().optional(),
  width: z.number().int().min(16).max(400).optional(),
  height: z.number().int().min(16).max(400).optional(),
  provider: z.enum(['claude', 'ollama']).optional(),
  model: z.string().min(1).optional(),
  ollamaHost: z.string().regex(/^https?:\/\//).optional(),
});
```

Add `'provider', 'model', 'ollamaHost'` to `RESERVED_OPTION_KEYS`:

```typescript
const RESERVED_OPTION_KEYS = ['referenceImageFilename', 'referenceStrength', 'basedOnAssetId', 'width', 'height', 'provider', 'model', 'ollamaHost'] as const;
```

Add validation right after the existing `outputKind === 'theme'` / `candidateCount` checks:

```typescript
if (input.provider === 'ollama' && (input.outputKind === 'image' || input.outputKind === undefined)) {
  return NextResponse.json({ success: false, error: 'Ollama is not supported for image (sprite) generation.' }, { status: 400 });
}
if (input.provider === 'ollama' && input.referenceImage) {
  return NextResponse.json({ success: false, error: 'Ollama is not supported alongside a reference image.' }, { status: 400 });
}
```

Add to the `mergedOptions` assembly, alongside the existing `width`/`height`/`basedOnAssetId` blocks:

```typescript
if (input.provider === 'ollama') {
  mergedOptions.provider = input.provider;
  mergedOptions.model = input.model;
  mergedOptions.ollamaHost = input.ollamaHost;
}
```

- [ ] **Step 4: Modify `worker.ts`**

Add the import: `import type { OllamaProviderOverride } from '@/lib/services/ollamaToolCall';`

Replace the `case 'theme':` and `case 'component':` branches:

```typescript
case 'theme': {
  const basedOnContent = await loadBasedOnContent(options.basedOnAssetId, job.id);
  const providerOverride = buildOllamaOverride(options);
  result = await getThemeGenerator().generate(job.prompt, job.style_id, referenceImage ?? undefined, basedOnContent, undefined, providerOverride);
  break;
}
case 'component': {
  const basedOnContent = await loadBasedOnContent(options.basedOnAssetId, job.id);
  const providerOverride = buildOllamaOverride(options);
  result = await getComponentGenerator().generate(job.prompt, job.style_id, undefined, referenceImage ?? undefined, basedOnContent, undefined, providerOverride);
  break;
}
```

Add this helper above `processJob` (near `loadBasedOnContent`):

```typescript
/**
 * Builds the providerOverride the Task-2 generators expect, from a job's
 * raw options object. Returns undefined for a Claude job (the default) --
 * only 'ollama' jobs ever set this. `correctionRequested` is omitted
 * entirely rather than set to `false` when absent -- it's an optional
 * field on OllamaProviderOverride, and omitting it (instead of always
 * including an explicit `false`) keeps the object's shape identical to
 * what a plain ollama job (no correction) already produces.
 */
function buildOllamaOverride(options: any): OllamaProviderOverride | undefined {
  if (options.provider !== 'ollama') return undefined;
  const override: OllamaProviderOverride = { type: 'ollama', host: options.ollamaHost, model: options.model };
  if (options.ollamaCorrectionRequested === true) override.correctionRequested = true;
  return override;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/generateRoute.test.ts test/workerThemeRouting.test.ts`
Expected: PASS, plus every pre-existing test in both files still passes

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS / clean

- [ ] **Step 7: Commit**

```bash
git add app/api/generate/route.ts worker.ts test/generateRoute.test.ts test/workerThemeRouting.test.ts
git commit -m "feat: accept an ollama provider for theme/component generation jobs"
```

---

## Task 4: `suggest-layout` route — provider selection (not job-queued)

`PageLayoutSuggester` is called synchronously from its own route, not through the job queue — no `options` JSON column involved here, unlike Task 3.

**Files:**
- Modify: `app/api/styles/[id]/pages/suggest-layout/route.ts`
- Modify: `test/suggestPageLayoutRoute.test.ts`

**Interfaces:**
- Consumes: `PageLayoutSuggester.suggest(...,providerOverride?)` (Task 2).

- [ ] **Step 1: Write the failing tests**

Append to `test/suggestPageLayoutRoute.test.ts`:

```typescript
it('rejects an ollama provider without a model', async () => {
  const res = await POST(makeRequest({ pageName: 'Home', provider: 'ollama' }), { params: Promise.resolve({ id: STYLE_ID }) });
  expect(res.status).toBe(400);
});

it('passes a providerOverride through to the suggester when ollama is requested', async () => {
  const suggestSpy = vi.fn().mockResolvedValue([]);
  vi.spyOn(await import('@/lib/services/PageLayoutSuggester'), 'getPageLayoutSuggester').mockReturnValue({ suggest: suggestSpy });

  await POST(makeRequest({
    pageName: 'Home', provider: 'ollama', model: 'llama3-groq-tool-use:8b', ollamaHost: 'http://localhost:11434',
  }), { params: Promise.resolve({ id: STYLE_ID }) });

  expect(suggestSpy).toHaveBeenCalledWith('Home', expect.any(Array), undefined, {
    type: 'ollama', host: 'http://localhost:11434', model: 'llama3-groq-tool-use:8b',
  });
});
```

(`makeRequest`, `STYLE_ID` — use this file's existing helpers/constants.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/suggestPageLayoutRoute.test.ts`
Expected: FAIL — the route doesn't accept these fields yet.

- [ ] **Step 3: Modify `app/api/styles/[id]/pages/suggest-layout/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { getCurrentUser } from '@/lib/utils/session';
import { assetService } from '@/lib/services/AssetService';
import { getPageLayoutSuggester, type PageLayoutComponentCandidate } from '@/lib/services/PageLayoutSuggester';
import type { OllamaProviderOverride } from '@/lib/services/ollamaToolCall';

export const dynamic = 'force-dynamic';

const SuggestLayoutSchema = z.object({
  pageName: z.string().min(1),
  provider: z.enum(['claude', 'ollama']).optional(),
  model: z.string().min(1).optional(),
  ollamaHost: z.string().regex(/^https?:\/\//).optional(),
}).refine(
  input => input.provider !== 'ollama' || (!!input.model && !!input.ollamaHost),
  { message: 'model and ollamaHost are required when provider is "ollama"' }
);

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const input = SuggestLayoutSchema.parse(await req.json());

    const assets = await assetService.getActiveAssetsForStyle(id);
    const candidates: PageLayoutComponentCandidate[] = assets
      .filter(a => a.output_kind === 'component')
      .map(a => ({ id: a.id, assetType: a.asset_type, prompt: a.prompt }));

    const providerOverride: OllamaProviderOverride | undefined = input.provider === 'ollama'
      ? { type: 'ollama', host: input.ollamaHost!, model: input.model! }
      : undefined;

    const componentAssetIds = await getPageLayoutSuggester().suggest(input.pageName, candidates, undefined, providerOverride);

    return NextResponse.json({ success: true, data: { componentAssetIds } });
  } catch (error: any) {
    if (error instanceof ZodError) {
      return NextResponse.json({
        success: false,
        error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
      }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/suggestPageLayoutRoute.test.ts`
Expected: PASS, plus every pre-existing test in this file still passes

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS / clean

- [ ] **Step 6: Commit**

```bash
git add "app/api/styles/[id]/pages/suggest-layout/route.ts" test/suggestPageLayoutRoute.test.ts
git commit -m "feat: accept an ollama provider for page-layout suggestions"
```

---

## Task 5: Settings — Ollama connection (GET/PUT host) + test-connection

**Files:**
- Create: `app/api/settings/ollama/route.ts`
- Create: `app/api/settings/ollama/test-connection/route.ts`
- Create: `test/ollamaSettingsRoute.test.ts`
- Modify: `lib/config.ts`

**Interfaces:**
- Produces: `OLLAMA_HOST_SETTING_KEY`, `DEFAULT_OLLAMA_HOST` (`lib/config.ts`) — **Tasks 6, 7, 8 depend on these.**

- [ ] **Step 1: Write the failing tests**

```typescript
// test/ollamaSettingsRoute.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from '@/test/helpers/testSession';

let tempRoot: string;
let cookieHeader: string;

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/settings/ollama', {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-ollamasettings-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  ({ cookieHeader } = await seedSession());
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('GET/PUT /api/settings/ollama', () => {
  it('401s when not logged in', async () => {
    const { GET } = await import('@/app/api/settings/ollama/route');
    const res = await GET(new NextRequest('http://localhost/api/settings/ollama'));
    expect(res.status).toBe(401);
  });

  it('GET returns the default host when nothing has been saved', async () => {
    const { GET } = await import('@/app/api/settings/ollama/route');
    const res = await GET(req('GET'));
    const body = await res.json();
    expect(body.data.host).toBe('http://localhost:11434');
  });

  it('PUT saves the host, and a subsequent GET returns it', async () => {
    const { GET, PUT } = await import('@/app/api/settings/ollama/route');
    await PUT(req('PUT', { host: 'http://192.168.1.50:11434' }));
    const res = await GET(req('GET'));
    const body = await res.json();
    expect(body.data.host).toBe('http://192.168.1.50:11434');
  });

  it('PUT rejects a host with no http/https scheme', async () => {
    const { PUT } = await import('@/app/api/settings/ollama/route');
    const res = await PUT(req('PUT', { host: 'localhost:11434' }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/settings/ollama/test-connection', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reports reachable: true when /api/tags responds ok', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ models: [] }) });
    const { POST } = await import('@/app/api/settings/ollama/test-connection/route');
    const res = await POST(req('POST'));
    const body = await res.json();
    expect(body.data.reachable).toBe(true);
  });

  it('reports reachable: false when the request fails', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const { POST } = await import('@/app/api/settings/ollama/test-connection/route');
    const res = await POST(req('POST'));
    const body = await res.json();
    expect(body.data.reachable).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/ollamaSettingsRoute.test.ts`
Expected: FAIL — neither route exists yet.

- [ ] **Step 3: Add the settings key to `lib/config.ts`**

```typescript
// Settings-table key for the configured Ollama host, and its default when
// unset -- Ollama's own standard local port.
export const OLLAMA_HOST_SETTING_KEY = 'ollama_host';
export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
```

- [ ] **Step 4: Create `app/api/settings/ollama/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { settingsService } from '@/lib/services/SettingsService';
import { getCurrentUser } from '@/lib/utils/session';
import { OLLAMA_HOST_SETTING_KEY, DEFAULT_OLLAMA_HOST } from '@/lib/config';

export const dynamic = 'force-dynamic';

const SetHostSchema = z.object({
  host: z.string().regex(/^https?:\/\//, 'Host must start with http:// or https://'),
});

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }
    const savedHost = await settingsService.get(OLLAMA_HOST_SETTING_KEY);
    return NextResponse.json({ success: true, data: { host: savedHost ?? DEFAULT_OLLAMA_HOST } });
  } catch (error: any) {
    console.error('Failed to read ollama_host setting:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }
    const body = await req.json();
    const parsed = SetHostSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0].message }, { status: 400 });
    }
    await settingsService.set(OLLAMA_HOST_SETTING_KEY, parsed.data.host);
    return NextResponse.json({ success: true, data: { host: parsed.data.host } });
  } catch (error: any) {
    console.error('Failed to save ollama_host setting:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 5: Create `app/api/settings/ollama/test-connection/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { settingsService } from '@/lib/services/SettingsService';
import { getCurrentUser } from '@/lib/utils/session';
import { OLLAMA_HOST_SETTING_KEY, DEFAULT_OLLAMA_HOST } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
  }

  const host = (await settingsService.get(OLLAMA_HOST_SETTING_KEY)) ?? DEFAULT_OLLAMA_HOST;
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
    return NextResponse.json({ success: true, data: { reachable: res.ok } });
  } catch {
    return NextResponse.json({ success: true, data: { reachable: false } });
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/ollamaSettingsRoute.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS / clean

- [ ] **Step 8: Commit**

```bash
git add app/api/settings/ollama/route.ts app/api/settings/ollama/test-connection/route.ts test/ollamaSettingsRoute.test.ts lib/config.ts
git commit -m "feat: add Ollama connection settings (get/set host, test connection)"
```

---

## Task 6: Settings — list installed models

**Files:**
- Create: `app/api/settings/ollama/models/route.ts`
- Create: `test/ollamaModelsRoute.test.ts`

**Interfaces:**
- Consumes: `OLLAMA_HOST_SETTING_KEY`, `DEFAULT_OLLAMA_HOST` (Task 5).
- Produces: `GET /api/settings/ollama/models -> { success: true, data: { models: string[]; host: string } }` — returning the host alongside the models list (not just the models) means the per-generation picker (Task 9) can send generation requests to whichever host is actually configured, not a hardcoded default. **Task 9's per-generation picker depends on this exact shape.**

- [ ] **Step 1: Write the failing tests**

```typescript
// test/ollamaModelsRoute.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from '@/test/helpers/testSession';

let tempRoot: string;
let cookieHeader: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-ollamamodels-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  ({ cookieHeader } = await seedSession());
});

afterEach(async () => {
  vi.unstubAllGlobals();
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

function req(): NextRequest {
  return new NextRequest('http://localhost/api/settings/ollama/models', { headers: { Cookie: cookieHeader } });
}

describe('GET /api/settings/ollama/models', () => {
  it('401s when not logged in', async () => {
    const { GET } = await import('@/app/api/settings/ollama/models/route');
    const res = await GET(new NextRequest('http://localhost/api/settings/ollama/models'));
    expect(res.status).toBe(401);
  });

  it('returns the installed model names from /api/tags, plus the host they came from', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3-groq-tool-use:8b' }, { name: 'qwen2.5:7b' }] }),
    });
    const { GET } = await import('@/app/api/settings/ollama/models/route');
    const res = await GET(req());
    const body = await res.json();
    expect(body.data.models).toEqual(['llama3-groq-tool-use:8b', 'qwen2.5:7b']);
    expect(body.data.host).toBe('http://localhost:11434');
  });

  it('returns an empty list (not an error) when the host is unreachable, but still reports the configured host', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const { GET } = await import('@/app/api/settings/ollama/models/route');
    const res = await GET(req());
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.models).toEqual([]);
    expect(body.data.host).toBe('http://localhost:11434');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/ollamaModelsRoute.test.ts`
Expected: FAIL — the route doesn't exist yet.

- [ ] **Step 3: Create `app/api/settings/ollama/models/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { settingsService } from '@/lib/services/SettingsService';
import { getCurrentUser } from '@/lib/utils/session';
import { OLLAMA_HOST_SETTING_KEY, DEFAULT_OLLAMA_HOST } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
  }

  const host = (await settingsService.get(OLLAMA_HOST_SETTING_KEY)) ?? DEFAULT_OLLAMA_HOST;
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return NextResponse.json({ success: true, data: { models: [], host } });
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return NextResponse.json({ success: true, data: { models: (data.models ?? []).map(m => m.name), host } });
  } catch {
    // Unreachable host is not an error for this endpoint's purpose (the
    // picker just shows no local models) -- the Settings page's own
    // "Test connection" button (Task 5) is where "is it even running" gets
    // a real yes/no. `host` is still returned so the caller (Task 9's
    // picker) knows which host a subsequent generation request should
    // target, even if it's currently unreachable.
    return NextResponse.json({ success: true, data: { models: [], host } });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/ollamaModelsRoute.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS / clean

- [ ] **Step 6: Commit**

```bash
git add app/api/settings/ollama/models/route.ts test/ollamaModelsRoute.test.ts
git commit -m "feat: list installed Ollama models via a server-side proxy to /api/tags"
```

---

## Task 7: Settings — one-click model pull with streamed progress

**Files:**
- Create: `app/api/settings/ollama/models/pull/route.ts`
- Create: `test/ollamaModelPullRoute.test.ts`

**Interfaces:**
- Consumes: `OLLAMA_HOST_SETTING_KEY`, `DEFAULT_OLLAMA_HOST` (Task 5).
- Produces: `POST /api/settings/ollama/models/pull` (body `{model: string}`) — streams Ollama's raw NDJSON response straight through — **Task 8's Settings-page pull button depends on this streaming contract.**

- [ ] **Step 1: Write the failing tests**

```typescript
// test/ollamaModelPullRoute.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from '@/test/helpers/testSession';

let tempRoot: string;
let cookieHeader: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-ollamapull-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  ({ cookieHeader } = await seedSession());
});

afterEach(async () => {
  vi.unstubAllGlobals();
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/settings/ollama/models/pull', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify(body),
  });
}

describe('POST /api/settings/ollama/models/pull', () => {
  it('401s when not logged in', async () => {
    const { POST } = await import('@/app/api/settings/ollama/models/pull/route');
    const res = await POST(new NextRequest('http://localhost/api/settings/ollama/models/pull', { method: 'POST', body: JSON.stringify({ model: 'x' }) }));
    expect(res.status).toBe(401);
  });

  it('400s when no model is given', async () => {
    const { POST } = await import('@/app/api/settings/ollama/models/pull/route');
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });

  it('forwards the request to Ollama /api/pull with stream: true and the requested model', async () => {
    fetchMock.mockResolvedValue({ ok: true, body: new ReadableStream() });
    const { POST } = await import('@/app/api/settings/ollama/models/pull/route');
    await POST(req({ model: 'llama3-groq-tool-use:8b' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:11434/api/pull');
    expect(JSON.parse(init.body as string)).toEqual({ model: 'llama3-groq-tool-use:8b', stream: true });
  });

  it('returns the upstream NDJSON stream as the response body', async () => {
    const chunks = ['{"status":"pulling manifest"}\n', '{"status":"success"}\n'];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    fetchMock.mockResolvedValue({ ok: true, body: stream });

    const { POST } = await import('@/app/api/settings/ollama/models/pull/route');
    const res = await POST(req({ model: 'llama3-groq-tool-use:8b' }));
    const text = await res.text();
    expect(text).toBe(chunks.join(''));
  });

  it('500s with a clear error when Ollama itself rejects the pull', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => 'model not found' });
    const { POST } = await import('@/app/api/settings/ollama/models/pull/route');
    const res = await POST(req({ model: 'does-not-exist' }));
    expect(res.status).toBe(500);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/ollamaModelPullRoute.test.ts`
Expected: FAIL — the route doesn't exist yet.

- [ ] **Step 3: Create `app/api/settings/ollama/models/pull/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { settingsService } from '@/lib/services/SettingsService';
import { getCurrentUser } from '@/lib/utils/session';
import { OLLAMA_HOST_SETTING_KEY, DEFAULT_OLLAMA_HOST } from '@/lib/config';

export const dynamic = 'force-dynamic';

// Multi-GB downloads are slow -- generous on purpose, not the 60-120s used
// for an actual generation call. Combined with the incoming request's own
// signal so navigating away on the client cancels the upstream pull too;
// Ollama resumes a partial pull on the next attempt, so a timeout here
// isn't destructive.
const PULL_TIMEOUT_MS = 5 * 60_000;

const PullSchema = z.object({ model: z.string().min(1) });

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
  }

  const parsed = PullSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'model is required' }, { status: 400 });
  }

  const host = (await settingsService.get(OLLAMA_HOST_SETTING_KEY)) ?? DEFAULT_OLLAMA_HOST;

  try {
    const upstream = await fetch(`${host}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: parsed.data.model, stream: true }),
      signal: AbortSignal.any([AbortSignal.timeout(PULL_TIMEOUT_MS), req.signal]),
    });

    if (!upstream.ok || !upstream.body) {
      const body = await upstream.text?.().catch(() => '') ?? '';
      return NextResponse.json({ success: false, error: `Ollama rejected the pull (${upstream.status}): ${body}` }, { status: 500 });
    }

    return new NextResponse(upstream.body, { headers: { 'content-type': 'application/x-ndjson' } });
  } catch (error: any) {
    console.error(`Failed to pull Ollama model ${parsed.data.model}:`, error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/ollamaModelPullRoute.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS / clean

- [ ] **Step 6: Commit**

```bash
git add app/api/settings/ollama/models/pull/route.ts test/ollamaModelPullRoute.test.ts
git commit -m "feat: add a streaming proxy route for one-click Ollama model pulls"
```

---

## Task 8: Settings page UI

**Files:**
- Create: `app/dashboard/settings/ollama/page.tsx`

**Interfaces:**
- Consumes: `GET/PUT /api/settings/ollama`, `POST /api/settings/ollama/test-connection`, `GET /api/settings/ollama/models`, `POST /api/settings/ollama/models/pull` (Tasks 5-7).

No automated test for this file — this codebase has no automated tests for dashboard pages (established convention; see the audit-fixes plan's Part D, which ends its UI tasks in manual dev-server verification instead). Manual verification is this task's own Step 4.

- [ ] **Step 1: Read the existing Aseprite settings page for the pattern to match**

Open `app/dashboard/settings/aseprite/page.tsx` and note its structure: a form with a text field + save button, a saved-confirmation message, loading/error states via `useState` + a mount `useEffect`. This task follows the same shape, extended with the connection-test button, installed-models list, and recommended-models pull buttons this feature needs beyond that simpler page.

- [ ] **Step 2: Write the page**

```typescript
// app/dashboard/settings/ollama/page.tsx
'use client';

import { useEffect, useState } from 'react';

const RECOMMENDED_MODELS = [
  {
    name: 'llama3-groq-tool-use:8b',
    note: 'Recommended -- the only model in our own testing with real published benchmark evidence for tool-calling reliability.',
  },
] as const;

export default function OllamaSettingsPage() {
  const [host, setHost] = useState('');
  const [savedHost, setSavedHost] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [installedModels, setInstalledModels] = useState<string[]>([]);
  const [pulling, setPulling] = useState<string | null>(null);
  const [pullStatus, setPullStatus] = useState<string>('');
  const [pullError, setPullError] = useState<string | null>(null);

  async function refreshModels() {
    try {
      const res = await fetch('/api/settings/ollama/models');
      const body = await res.json();
      if (body.success) setInstalledModels(body.data.models);
    } catch {
      // Non-fatal -- the installed-models list just stays whatever it last was.
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/settings/ollama');
        const body = await res.json();
        if (body.success) {
          setHost(body.data.host);
          setSavedHost(body.data.host);
        } else {
          setError(body.error ?? 'Could not load settings.');
        }
      } catch {
        setError('Could not reach the server.');
      } finally {
        setLoading(false);
      }
    })();
    refreshModels();
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/settings/ollama', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Could not save.');
      } else {
        setSavedHost(body.data.host);
        setReachable(null);
        refreshModels();
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    if (testing) return;
    setTesting(true);
    setReachable(null);
    try {
      const res = await fetch('/api/settings/ollama/test-connection', { method: 'POST' });
      const body = await res.json();
      setReachable(body.success ? body.data.reachable : false);
    } catch {
      setReachable(false);
    } finally {
      setTesting(false);
    }
  }

  async function handlePull(model: string) {
    if (pulling) return;
    setPulling(model);
    setPullStatus('Starting…');
    setPullError(null);
    try {
      const res = await fetch('/api/settings/ollama/models/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Pull failed.');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const update = JSON.parse(line) as { status: string; total?: number; completed?: number };
          if (update.status === 'success') {
            setPullStatus('Installed');
          } else if (typeof update.total === 'number' && typeof update.completed === 'number' && update.total > 0) {
            setPullStatus(`${update.status} — ${Math.round((update.completed / update.total) * 100)}%`);
          } else {
            setPullStatus(update.status);
          }
        }
      }
      await refreshModels();
    } catch (e: any) {
      setPullError(e.message ?? 'Pull failed.');
    } finally {
      setPulling(null);
    }
  }

  if (loading) return <p className="page-subtitle">Loading…</p>;

  return (
    <>
      <h1 className="page-title">Ollama</h1>
      <p className="page-subtitle">
        Use a local Ollama model instead of Claude for theme, component, and page-layout generation. Ollama has
        no built-in authentication — pointing this at a non-localhost host is your own trust decision.
      </p>

      <form className="card" onSubmit={handleSave} style={{ marginBottom: 24, maxWidth: 480 }}>
        <div className="field">
          <label htmlFor="host">Host</label>
          <input id="host" value={host} onChange={e => setHost(e.target.value)} placeholder="http://localhost:11434" />
        </div>
        {error && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" type="submit" disabled={saving || !host.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button className="btn" type="button" disabled={testing} onClick={handleTestConnection}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
        </div>
        {reachable !== null && (
          <p style={{ fontSize: 13, marginTop: 8, color: reachable ? 'var(--ink-dim)' : 'var(--reject)' }}>
            {reachable ? `Reachable at ${savedHost}.` : `Could not reach ${savedHost}.`}
          </p>
        )}
      </form>

      <h2 className="frame-label" style={{ marginBottom: 12, fontSize: 12 }}>Installed models</h2>
      {installedModels.length === 0 ? (
        <p className="page-subtitle" style={{ marginBottom: 24 }}>None found — pull a recommended model below, or check your connection above.</p>
      ) : (
        <ul style={{ marginBottom: 24 }}>
          {installedModels.map(m => <li key={m}>{m}</li>)}
        </ul>
      )}

      <h2 className="frame-label" style={{ marginBottom: 12, fontSize: 12 }}>Recommended models</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {RECOMMENDED_MODELS.map(({ name, note }) => {
          const installed = installedModels.includes(name);
          return (
            <div key={name} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <div style={{ fontSize: 14 }}>{name}</div>
                <div style={{ fontSize: 12, color: 'var(--ink-dim)' }}>{note}</div>
              </div>
              {installed ? (
                <span className="badge">Installed</span>
              ) : (
                <button className="btn" disabled={pulling !== null} onClick={() => handlePull(name)}>
                  {pulling === name ? pullStatus : 'Pull this model'}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {pullError && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 12 }}>{pullError}</p>}
    </>
  );
}
```

- [ ] **Step 3: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS / clean (this task adds no tests of its own, but must not break anything else)

- [ ] **Step 4: Manual verification**

Start the dev server (`npm run dev`), navigate to `/dashboard/settings/ollama`, and confirm: the page loads with the default host pre-filled; Save persists a changed host (reload the page to confirm it stuck); Test connection reports a clear result either way (works without a real Ollama running — it should just report "not reachable"); the recommended model shows a "Pull this model" button.

- [ ] **Step 5: Commit**

```bash
git add app/dashboard/settings/ollama/page.tsx
git commit -m "feat: add the Ollama settings page (connection, installed models, one-click pull)"
```

---

## Task 9: Per-generation provider picker (Themes and Components pages)

Same shape applied to 2 pages — batched into one task per this project's "batch small same-shape work" convention.

**Files:**
- Create: `lib/hooks/useOllamaModels.ts`
- Modify: `app/dashboard/themes/page.tsx`
- Modify: `app/dashboard/components/page.tsx`

**Interfaces:**
- Consumes: `GET /api/settings/ollama/models -> { models: string[]; host: string }` (Task 6).
- Produces: `useOllamaModels(): { models: string[]; host: string }`.

No automated test for this task — same established convention as Task 8 (no automated tests for dashboard pages/hooks in this codebase). Manual verification is this task's own final step.

- [ ] **Step 1: Create `lib/hooks/useOllamaModels.ts`**

```typescript
'use client';

import { useEffect, useState } from 'react';

/**
 * The installed Ollama models plus the host they came from, for the
 * per-generation provider picker. Fetched once on mount -- the list only
 * matters at the moment you're about to generate, no polling needed.
 * `host` is returned alongside `models` (not hardcoded by the caller) so a
 * generation request always targets whatever host is actually configured
 * in Settings, even after the user changes it away from the default.
 */
export function useOllamaModels(): { models: string[]; host: string } {
  const [models, setModels] = useState<string[]>([]);
  const [host, setHost] = useState('');

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await fetch('/api/settings/ollama/models');
        const body = await res.json();
        if (!ignore && body.success) {
          setModels(body.data.models);
          setHost(body.data.host);
        }
      } catch {
        // Non-fatal -- the picker just shows no local models.
      }
    })();
    return () => { ignore = true; };
  }, []);

  return { models, host };
}
```

- [ ] **Step 2: Modify `app/dashboard/themes/page.tsx`**

Add the import and state:

```typescript
import { useOllamaModels } from '@/lib/hooks/useOllamaModels';
```

```typescript
const { models: ollamaModels, host: ollamaHost } = useOllamaModels();
const [provider, setProvider] = useState<'claude' | string>('claude'); // 'claude' or an ollama model name
```

Add the picker field in the form, right after the reference-image field (disabled/reset whenever a reference image is attached, matching the spec's scope boundary):

```tsx
<div className="field">
  <label htmlFor="provider">Model</label>
  <select
    id="provider"
    value={referenceImage ? 'claude' : provider}
    disabled={!!referenceImage}
    onChange={e => setProvider(e.target.value)}
  >
    <option value="claude">Claude</option>
    {ollamaModels.map(m => <option key={m} value={m}>{m} (local)</option>)}
  </select>
  {referenceImage && <p style={{ fontSize: 12, color: 'var(--ink-dim)', marginTop: 4 }}>Ollama isn't available with a reference image attached.</p>}
</div>
```

Update `handleSubmit`'s request body to thread the choice through:

```typescript
body: JSON.stringify({
  styleId: activeStyleId,
  assetType: 'theme',
  prompt: prompt.trim(),
  outputKind: 'theme',
  candidateCount,
  ...(referenceImage ? { referenceImage } : {}),
  ...(provider !== 'claude' && !referenceImage
    ? { provider: 'ollama', model: provider, ollamaHost: ollamaHost }
    : {}),
}),
```

`ollamaHost` comes from `useOllamaModels()` (Step 1 above), which reads it from `GET /api/settings/ollama/models` — the actually-configured host, not a hardcoded default, so generation still targets the right place after the user changes it in Settings.

- [ ] **Step 3: Modify `app/dashboard/components/page.tsx`**

This page's form has the identical shape (same reference-image field, same `/api/generate` POST). Add the same import and state:

```typescript
import { useOllamaModels } from '@/lib/hooks/useOllamaModels';
```

```typescript
const { models: ollamaModels, host: ollamaHost } = useOllamaModels();
const [provider, setProvider] = useState<'claude' | string>('claude');
```

Add the picker field right after the existing reference-image field (between it and the `error &&` block):

```tsx
<div className="field">
  <label htmlFor="provider">Model</label>
  <select
    id="provider"
    value={referenceImage ? 'claude' : provider}
    disabled={!!referenceImage}
    onChange={e => setProvider(e.target.value)}
  >
    <option value="claude">Claude</option>
    {ollamaModels.map(m => <option key={m} value={m}>{m} (local)</option>)}
  </select>
  {referenceImage && <p style={{ fontSize: 12, color: 'var(--ink-dim)', marginTop: 4 }}>Ollama isn't available with a reference image attached.</p>}
</div>
```

Update `handleSubmit`'s request body:

```typescript
body: JSON.stringify({
  styleId: activeStyleId,
  assetType: 'component',
  prompt: `${componentType}: ${prompt.trim()}`,
  outputKind: 'component',
  ...(referenceImage ? { referenceImage } : {}),
  ...(provider !== 'claude' && !referenceImage
    ? { provider: 'ollama', model: provider, ollamaHost: ollamaHost }
    : {}),
}),
```

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS / clean

- [ ] **Step 5: Manual verification**

Start the dev server, open the Themes page: confirm the Model dropdown defaults to Claude, lists no local models yet (none installed in a fresh dev environment), and disables itself with an explanatory note when a reference image is attached. Repeat on the Components page.

- [ ] **Step 6: Commit**

```bash
git add lib/hooks/useOllamaModels.ts app/dashboard/themes/page.tsx app/dashboard/components/page.tsx
git commit -m "feat: add a per-generation Claude/Ollama model picker to Themes and Components"
```

---

## Task 10: "Retry with correction"

**Files:**
- Create: `app/api/jobs/retry-with-correction/route.ts`
- Create: `test/jobRetryWithCorrection.test.ts`
- Modify: `app/components/JobCard.tsx`
- Modify: the page(s) rendering `<JobCard>` for themes/components (`app/dashboard/themes/page.tsx`, `app/dashboard/components/page.tsx`) to wire the new handler through

**Interfaces:**
- Consumes: `OLLAMA_NO_TOOL_CALL_ERROR_PREFIX` (Task 1), `buildOllamaOverride` reading `options.ollamaCorrectionRequested` (Task 3's `worker.ts` already reads `options.ollamaCorrectionRequested` into `providerOverride.correctionRequested` — this task is what actually sets that flag).

- [ ] **Step 1: Write the failing tests**

```typescript
// test/jobRetryWithCorrection.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { seedSession } from '@/test/helpers/testSession';
import { OLLAMA_NO_TOOL_CALL_ERROR_PREFIX } from '@/lib/services/ollamaToolCall';

let tempRoot: string;
let userId: string;
let cookieHeader: string;
const STYLE_ID = '11111111-1111-1111-1111-111111111111';

function insertJob(id: string, status: string, errorMessage: string | null, options: Record<string, unknown>) {
  const db = DatabaseConnection.getInstance();
  db.prepare(`
    INSERT INTO jobs (id, style_id, created_by, asset_type, prompt, output_kind, status, error_message, options, created_at, updated_at)
    VALUES (?, ?, ?, 'theme', 'warm', 'theme', ?, ?, ?, 1000, 1000)
  `).run(id, STYLE_ID, userId, status, errorMessage, JSON.stringify(options));
}

function req(jobId: string): NextRequest {
  return new NextRequest('http://localhost/api/jobs/retry-with-correction', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({ jobId }),
  });
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-retrycorrection-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  const db = DatabaseConnection.getInstance();
  db.prepare(`INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at) VALUES (?, 'style', 'someone', '{}', 0, 1000, 1000)`).run(STYLE_ID);
  ({ userId, cookieHeader } = await seedSession());
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

// The route's schema requires jobId to be a real UUID (z.string().uuid(), matching the sibling
// /api/jobs/retry/route.ts and how JobService.create() actually generates ids via
// crypto.randomUUID()) -- a non-UUID literal like 'job-1' fails Zod validation and returns a
// generic 400 before any of the route's own business-logic checks run. Found during this task's
// own implementation: with non-UUID literals, 2 of these 4 tests failed outright on the wrong
// status code, and a 3rd "passed" for the wrong reason (it expects 400 and got one, but from Zod
// rejecting the malformed id, not from the business-logic branch its name claims to exercise).
const JOB_ID_1 = '00000000-0000-0000-0000-000000000001';
const JOB_ID_2 = '00000000-0000-0000-0000-000000000002';
const JOB_ID_3 = '00000000-0000-0000-0000-000000000003';
const JOB_ID_4 = '00000000-0000-0000-0000-000000000004';

describe('POST /api/jobs/retry-with-correction', () => {
  it('401s when not logged in', async () => {
    insertJob(JOB_ID_1, 'failed', OLLAMA_NO_TOOL_CALL_ERROR_PREFIX, { provider: 'ollama' });
    const { POST } = await import('@/app/api/jobs/retry-with-correction/route');
    const res = await POST(new NextRequest('http://localhost/api/jobs/retry-with-correction', { method: 'POST', body: JSON.stringify({ jobId: JOB_ID_1 }) }));
    expect(res.status).toBe(401);
  });

  it('rejects a job that did not fail with the ollama-no-tool-call error', async () => {
    insertJob(JOB_ID_2, 'failed', 'some other network error', { provider: 'ollama' });
    const { POST } = await import('@/app/api/jobs/retry-with-correction/route');
    const res = await POST(req(JOB_ID_2));
    expect(res.status).toBe(400);
  });

  it('rejects a job that is not failed', async () => {
    insertJob(JOB_ID_3, 'complete', null, { provider: 'ollama' });
    const { POST } = await import('@/app/api/jobs/retry-with-correction/route');
    const res = await POST(req(JOB_ID_3));
    expect(res.status).toBe(409);
  });

  it('resets the job to pending with ollamaCorrectionRequested set, preserving the rest of options', async () => {
    insertJob(JOB_ID_4, 'failed', `${OLLAMA_NO_TOOL_CALL_ERROR_PREFIX} for emit_theme`, { provider: 'ollama', model: 'llama3-groq-tool-use:8b', ollamaHost: 'http://localhost:11434' });
    const { POST } = await import('@/app/api/jobs/retry-with-correction/route');
    const res = await POST(req(JOB_ID_4));
    expect(res.status).toBe(200);

    const db = DatabaseConnection.getInstance();
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(JOB_ID_4) as any;
    expect(row.status).toBe('pending');
    expect(row.error_message).toBeNull();
    const options = JSON.parse(row.options);
    expect(options.ollamaCorrectionRequested).toBe(true);
    expect(options.model).toBe('llama3-groq-tool-use:8b'); // unrelated fields preserved
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/jobRetryWithCorrection.test.ts`
Expected: FAIL — the route doesn't exist yet.

- [ ] **Step 3: Create `app/api/jobs/retry-with-correction/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { jobService } from '@/lib/services/JobService';
import { DatabaseConnection } from '@/lib/database';
import { getCurrentUser } from '@/lib/utils/session';
import { OLLAMA_NO_TOOL_CALL_ERROR_PREFIX } from '@/lib/services/ollamaToolCall';

export const dynamic = 'force-dynamic';

const RetryWithCorrectionSchema = z.object({ jobId: z.string().uuid() });

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { jobId } = RetryWithCorrectionSchema.parse(await req.json());

    const job = await jobService.getById(jobId);
    if (!job) return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 });
    if (job.created_by !== user.id && !user.is_admin) {
      return NextResponse.json({ success: false, error: 'Only the creator can retry this job.' }, { status: 403 });
    }
    if (job.status !== 'failed') {
      return NextResponse.json({ success: false, error: 'Only a failed job can be retried with a correction.' }, { status: 409 });
    }
    if (!job.error_message?.startsWith(OLLAMA_NO_TOOL_CALL_ERROR_PREFIX)) {
      return NextResponse.json({
        success: false,
        error: 'This job did not fail in a way that supports retry-with-correction.',
      }, { status: 400 });
    }

    // Distinct from the generic /api/jobs/retry route: this one ALSO flags
    // the job's options so the worker injects a corrective instruction,
    // rather than just re-running the identical request that already
    // failed once.
    const options = JSON.parse(job.options);
    options.ollamaCorrectionRequested = true;
    DatabaseConnection.getInstance().prepare('UPDATE jobs SET options = ? WHERE id = ?').run(JSON.stringify(options), jobId);

    const updated = await jobService.resetForRetry(jobId);
    return NextResponse.json({ success: true, data: updated });
  } catch (error: any) {
    if (error instanceof ZodError) {
      return NextResponse.json({
        success: false,
        error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
      }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/jobRetryWithCorrection.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Modify `app/components/JobCard.tsx`**

Add the new optional prop and a conditional button, distinct from the existing generic `onRetry`:

```typescript
import { OLLAMA_NO_TOOL_CALL_ERROR_PREFIX } from '@/lib/services/ollamaToolCall';

interface JobCardProps {
  job: Job;
  onPromote?: (jobId: string) => void;
  onDiscard?: (jobId: string) => void;
  onRetry?: (jobId: string) => void;
  onRetryWithCorrection?: (jobId: string) => void;
  busy?: boolean;
}

export function JobCard({ job, onPromote, onDiscard, onRetry, onRetryWithCorrection, busy }: JobCardProps) {
```

In the failure-message block, add the distinct correction action right below the error text (not next to the generic Retry button in the action row, so the two aren't visually interchangeable):

```tsx
{job.status === 'failed' && job.error_message && (
  <div style={{ fontSize: 12, color: 'var(--reject)', marginBottom: 12 }}>
    {job.error_message}
    {onRetryWithCorrection && job.error_message.startsWith(OLLAMA_NO_TOOL_CALL_ERROR_PREFIX) && (
      <div style={{ marginTop: 6 }}>
        <button className="btn" disabled={busy} onClick={() => onRetryWithCorrection(job.id)}>
          Retry with correction
        </button>
      </div>
    )}
  </div>
)}
```

- [ ] **Step 6: Wire `onRetryWithCorrection` into the Themes and Components pages**

Neither page currently passes `onPromote`/`onDiscard`/`onRetry` to `<JobCard>` at all (both just render `<JobCard key={job.id} job={job} />` in their live-queue list) — this step adds only the new handler, nothing else. In each page (`app/dashboard/themes/page.tsx`, `app/dashboard/components/page.tsx`), add the handler (placed near `handleSubmit`) and pass it to `<JobCard>`:

```typescript
async function handleRetryWithCorrection(jobId: string) {
  try {
    const res = await fetch('/api/jobs/retry-with-correction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    });
    const body = await res.json();
    if (body.success) refreshActive();
  } catch {
    // Best-effort -- the job card's own error message is still visible either way.
  }
}
```

```tsx
<JobCard key={job.id} job={job} onRetryWithCorrection={handleRetryWithCorrection} />
```

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS / clean

- [ ] **Step 8: Manual verification**

Since this path only triggers on a real Ollama no-tool-call failure (not something CI can produce), verify it by temporarily pointing a theme generation at a deliberately-wrong host (e.g. `http://localhost:1`) to force a failure, confirming: a normal connection failure does NOT show the "Retry with correction" button (it only appears for the specific `OLLAMA_NO_TOOL_CALL_ERROR_PREFIX` failure), and the generic Retry button still works for any failure. Full confidence in the correction path itself requires a real Ollama instance and a marginal model — out of scope for this step, covered by the manual model-validation work already planned before the recommended list ships.

- [ ] **Step 9: Commit**

```bash
git add app/api/jobs/retry-with-correction/route.ts test/jobRetryWithCorrection.test.ts app/components/JobCard.tsx app/dashboard/themes/page.tsx app/dashboard/components/page.tsx
git commit -m "feat: add a manual Retry-with-correction action for Ollama no-tool-call failures"
```
