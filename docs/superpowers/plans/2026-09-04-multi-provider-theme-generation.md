# Multi-Provider Theme Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Note (added during a later audit):** kie.ai support described below was never shipped — the final implementation only has `anthropic`/`cheaperinference` (see `lib/services/claudeApiProviders.ts`). This section is historical, not a guide to current behavior.

**Goal:** Let GameForge's website-theme generation call cheaperinference.com or kie.ai (in addition to the official Anthropic API), selected by one env var, with no behavior change when that var is left unset.

**Architecture:** Extract the three per-vendor differences (request URL, auth header shape, model name) into a plain `ClaudeApiProvider` profile object. Rename the existing `AnthropicThemeGenerator` to `ClaudeApiThemeGenerator` and parameterize it by a profile instead of hardcoding Anthropic's own values — every other line of that class (request building, timeout, `ThemeTokensSchema` validation, CSS writing, error diagnosis) stays exactly as it is today, since it's the same underlying Messages API shape regardless of which host answers it. `getThemeGenerator()` gains a new `THEME_API_PROVIDER` env var to pick which profile is active; unset behaves identically to today.

**Tech Stack:** TypeScript, Zod, Vitest with mocked `fetch` (the established pattern for this exact class — no other real behavior needs mocking).

**Spec:** docs/superpowers/specs/2026-09-04-multi-provider-theme-generation-design.md

## Global Constraints

- No fallback chain and no per-job provider picker — one provider is active app-wide at a time, chosen by `THEME_API_PROVIDER`. Both were explicitly rejected during brainstorming.
- `THEME_API_PROVIDER` unset (or `'anthropic'`) must behave **exactly** as today: `ANTHROPIC_API_KEY` present → real generation via the official API; absent → `MockThemeGenerator`. This is additive — existing deployments must see zero behavior change.
- An explicitly-selected provider (`cheaperinference` or `kieai`) whose key env var is missing must throw a clear, specific error — never silently fall back to the mock. The user opted into a real provider; a missing key is a misconfiguration to surface, not paper over.
- An unrecognized `THEME_API_PROVIDER` value must also throw a clear error rather than silently behaving like `'anthropic'`.
- Every thrown error from the generator names which provider was active, since there are now three possible ones and a bare message would leave "which one failed" ambiguous in the worker log.
- No `@anthropic-ai/sdk` or any other new dependency — direct `fetch`, matching this project's established convention.
- No wrapper classes, no factories (AGENTS.md hard rules) — provider differences live in plain data objects, not a class hierarchy. Safety-critical logic (regex validation, timeout, response parsing) stays in exactly one place, per AGENTS.md's "extract shared helpers for safety-critical logic on sight" rule.
- Neither third-party provider's forced-`tool_choice` behavior has been confirmed by a real call — nothing in this plan can fix that; the design only ensures a mismatch fails loudly instead of silently.

---

## File Map

| File | Responsibility |
|---|---|
| `lib/services/claudeApiProviders.ts` | `ClaudeApiProvider` interface + the three profile constants |
| `lib/services/ClaudeApiThemeGenerator.ts` | Renamed from `AnthropicThemeGenerator.ts`; takes a profile instead of hardcoding Anthropic's values |
| `lib/services/ThemeGenerator.ts` | `getThemeGenerator()` gains 3-way provider selection |
| `.env.local.example`, `README.md` | Document the two new provider options |
| `test/claudeApiProviders.test.ts` | Tests for the profile objects |
| `test/themeGenerator.test.ts` | Existing `AnthropicThemeGenerator` tests updated for the renamed, profile-parameterized class |
| `test/getThemeGeneratorSelection.test.ts` | Tests for `getThemeGenerator()`'s 3-way selection logic |

---

### Task 1: Provider profiles

**Files:**
- Create: `lib/services/claudeApiProviders.ts`
- Test: `test/claudeApiProviders.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  interface ClaudeApiProvider {
    name: 'anthropic' | 'cheaperinference' | 'kieai';
    requestUrl: string;
    model: string;
    buildAuthHeaders(apiKey: string): Record<string, string>;
    apiKeyEnvVar: string;
  }
  const ANTHROPIC_PROVIDER: ClaudeApiProvider;
  const CHEAPERINFERENCE_PROVIDER: ClaudeApiProvider;
  const KIEAI_PROVIDER: ClaudeApiProvider;
  ```
  Consumed by Task 2 (`ClaudeApiThemeGenerator`) and Task 3 (`getThemeGenerator()`).

- [ ] **Step 1: Write the failing test**

```typescript
// test/claudeApiProviders.test.ts
import { describe, it, expect } from 'vitest';
import { ANTHROPIC_PROVIDER, CHEAPERINFERENCE_PROVIDER, KIEAI_PROVIDER } from '@/lib/services/claudeApiProviders';

describe('ANTHROPIC_PROVIDER', () => {
  it('points at the official Anthropic Messages endpoint with an x-api-key header', () => {
    expect(ANTHROPIC_PROVIDER.name).toBe('anthropic');
    expect(ANTHROPIC_PROVIDER.requestUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(ANTHROPIC_PROVIDER.model).toBe('claude-sonnet-5');
    expect(ANTHROPIC_PROVIDER.apiKeyEnvVar).toBe('ANTHROPIC_API_KEY');
    expect(ANTHROPIC_PROVIDER.buildAuthHeaders('fake-key')).toEqual({ 'x-api-key': 'fake-key' });
  });
});

describe('CHEAPERINFERENCE_PROVIDER', () => {
  it('points at cheaperinference.com\'s Anthropic-compatible endpoint with an X-Api-Key header', () => {
    expect(CHEAPERINFERENCE_PROVIDER.name).toBe('cheaperinference');
    expect(CHEAPERINFERENCE_PROVIDER.requestUrl).toBe('https://api.cheaperinference.com/v1/messages');
    expect(CHEAPERINFERENCE_PROVIDER.apiKeyEnvVar).toBe('CHEAPERINFERENCE_API_KEY');
    expect(CHEAPERINFERENCE_PROVIDER.buildAuthHeaders('fake-key')).toEqual({ 'X-Api-Key': 'fake-key' });
  });
});

describe('KIEAI_PROVIDER', () => {
  it('points at kie.ai\'s Claude proxy with an ANTHROPIC_AUTH_TOKEN header', () => {
    expect(KIEAI_PROVIDER.name).toBe('kieai');
    expect(KIEAI_PROVIDER.requestUrl).toBe('https://api.kie.ai/claude/v1/messages');
    expect(KIEAI_PROVIDER.apiKeyEnvVar).toBe('KIEAI_API_KEY');
    expect(KIEAI_PROVIDER.buildAuthHeaders('fake-key')).toEqual({ ANTHROPIC_AUTH_TOKEN: 'fake-key' });
  });
});

describe('every provider', () => {
  it('has a distinct name, requestUrl, and apiKeyEnvVar (no accidental duplication)', () => {
    const providers = [ANTHROPIC_PROVIDER, CHEAPERINFERENCE_PROVIDER, KIEAI_PROVIDER];
    expect(new Set(providers.map(p => p.name)).size).toBe(3);
    expect(new Set(providers.map(p => p.requestUrl)).size).toBe(3);
    expect(new Set(providers.map(p => p.apiKeyEnvVar)).size).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/claudeApiProviders.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the provider profiles**

```typescript
// lib/services/claudeApiProviders.ts

/**
 * The three vendor-specific differences between otherwise-identical
 * Anthropic-Messages-API-shaped hosts: where to send the request, how
 * to authenticate, and which model name that host expects. Everything
 * else (request body shape, forced tool_choice, response parsing,
 * error handling) lives once in ClaudeApiThemeGenerator and is shared
 * across all three — see that file's own comment for why this is a
 * plain profile object rather than a class per vendor.
 */
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
  buildAuthHeaders: (apiKey) => ({ 'x-api-key': apiKey }),
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
  // kie.ai's model catalog page did not fetch cleanly during research —
  // this model name matches their own naming for the official Anthropic
  // model, but is UNCONFIRMED against a real key. A wrong value here
  // fails cleanly (a real, diagnosable API error), not silently.
  model: 'claude-sonnet-5',
  requestUrl: 'https://api.kie.ai/claude/v1/messages',
  buildAuthHeaders: (apiKey) => ({ ANTHROPIC_AUTH_TOKEN: apiKey }),
  apiKeyEnvVar: 'KIEAI_API_KEY',
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/claudeApiProviders.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full suite, typecheck, lint**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: everything green.

- [ ] **Step 6: Commit**

```bash
git add lib/services/claudeApiProviders.ts test/claudeApiProviders.test.ts
git commit -m "Add Claude API provider profiles for Anthropic, cheaperinference.com, and kie.ai"
```

---

### Task 2: Rename and parameterize the generator by provider

**Files:**
- Create: `lib/services/ClaudeApiThemeGenerator.ts`
- Modify: `test/themeGenerator.test.ts`

**Note on `lib/services/AnthropicThemeGenerator.ts`:** this task does
**not** delete it yet, even though `ClaudeApiThemeGenerator.ts` fully
replaces it — `lib/services/ThemeGenerator.ts` still imports the old
file, and deleting it here would leave the build broken until Task 3
runs, which fails this plan's own "every task ends green" rule. The old
file sits unused-but-present for one commit; Task 3 both fixes
`ThemeGenerator.ts`'s import and deletes the old file in the same step,
since that's the exact point it becomes truly dead code.

**Interfaces:**
- Consumes: `ClaudeApiProvider`, `ANTHROPIC_PROVIDER` (Task 1).
- Produces:
  ```typescript
  class ClaudeApiThemeGenerator implements ThemeGenerator {
    constructor(apiKey: string, provider: ClaudeApiProvider);
    generate(prompt: string, styleId: string): Promise<GeneratedTheme>;
  }
  ```
  Consumed by Task 3 (`getThemeGenerator()`).

The current `lib/services/AnthropicThemeGenerator.ts` (unchanged since it
shipped) reads in full:

```typescript
// lib/services/AnthropicThemeGenerator.ts
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { styleService } from '@/lib/services/StyleService';
import {
  ThemeTokensSchema,
  tokensToCss,
  buildThemePrompt,
  type ThemeGenerator,
  type GeneratedTheme,
} from '@/lib/services/ThemeGenerator';

const API_BASE = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-sonnet-5';
const REQUEST_TIMEOUT_MS = 60_000;

const TOOL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    colorBackground: { type: 'string', description: 'Primary page background color as a hex code, e.g. "#1a1420".' },
    colorForeground: { type: 'string', description: 'Primary text color as a hex code, readable against colorBackground.' },
    colorAccent: { type: 'string', description: 'Accent color for buttons, links, highlights, as a hex code.' },
    colorBorder: { type: 'string', description: 'Border/divider color as a hex code.' },
    fontHeading: { type: 'string', description: 'A CSS font-family value for headings, e.g. "\'Cinzel\', serif".' },
    fontBody: { type: 'string', description: 'A CSS font-family value for body text.' },
    spaceUnit: { type: 'string', description: 'Base spacing unit as a CSS length in px, rem, or em, e.g. "8px".' },
    radiusBase: { type: 'string', description: 'Base border-radius as a CSS length in px, rem, or em, e.g. "4px".' },
  },
  required: ['colorBackground', 'colorForeground', 'colorAccent', 'colorBorder', 'fontHeading', 'fontBody', 'spaceUnit', 'radiusBase'],
};

type ToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
};

interface AnthropicMessageResponse {
  content: Array<{ type: string } & Record<string, unknown>>;
  stop_reason: string;
}

/**
 * Real Anthropic Messages API, called directly via fetch (no
 * @anthropic-ai/sdk dependency — matches PixellabGenerator's own
 * direct-fetch convention). Forces a single tool call so the response
 * is reliably structured, rather than asking for JSON in prose.
 */
export class AnthropicThemeGenerator implements ThemeGenerator {
  constructor(private apiKey: string) {}

  async generate(prompt: string, styleId: string): Promise<GeneratedTheme> {
    const style = await styleService.getById(styleId);
    const fullPrompt = buildThemePrompt(style?.parameters ?? '{}', prompt);

    const res = await fetch(API_BASE, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        tools: [
          {
            name: 'emit_theme',
            description: 'Emit a website design token set matching the requested aesthetic.',
            input_schema: TOOL_INPUT_SCHEMA,
          },
        ],
        tool_choice: { type: 'tool', name: 'emit_theme' },
        messages: [{ role: 'user', content: fullPrompt }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic theme generation failed (${res.status}): ${body || res.statusText}`);
    }

    const data = (await res.json()) as AnthropicMessageResponse;
    if (data.stop_reason === 'max_tokens') {
      throw new Error(
        'Anthropic response was truncated (stop_reason: max_tokens) before completing the tool call — the theme could not be generated.'
      );
    }
    const toolUse = data.content.find((block): block is ToolUseBlock => block.type === 'tool_use');
    if (!toolUse) {
      throw new Error('Anthropic response contained no tool_use block for emit_theme.');
    }

    const tokens = ThemeTokensSchema.parse(toolUse.input);
    const filename = `theme-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.css`;

    const themesDir = path.join(getProjectRoot(), 'storage', 'themes');
    try {
      await fsPromises.mkdir(themesDir, { recursive: true });
      await fsPromises.writeFile(path.join(themesDir, filename), tokensToCss(tokens));
    } catch (e) {
      console.error(`Failed to write theme file ${filename}:`, e);
      throw e;
    }

    return { path: filename, prompt };
  }
}
```

- [ ] **Step 1: Write the failing test**

Update `test/themeGenerator.test.ts`. The current file's import line:

```typescript
import { AnthropicThemeGenerator } from '@/lib/services/AnthropicThemeGenerator';
```

Replace with:

```typescript
import { ClaudeApiThemeGenerator } from '@/lib/services/ClaudeApiThemeGenerator';
import { ANTHROPIC_PROVIDER } from '@/lib/services/claudeApiProviders';
```

The current file has a `describe('AnthropicThemeGenerator', () => { ... })` block containing 7 `it(...)` tests (includes-style-params, forced-tool-use+timeout+writes-css, throws-no-tool_use, throws-invalid-schema, throws-max_tokens, throws-status-fail, falls-back-missing-style), each with `const gen = new AnthropicThemeGenerator('fake-key');`. Rename the describe block to `'ClaudeApiThemeGenerator'` and change every one of those 7 construction lines to:

```typescript
    const gen = new ClaudeApiThemeGenerator('fake-key', ANTHROPIC_PROVIDER);
```

Every other line in that describe block (the mocked `fetch` responses, the `expect(...)` assertions, including `expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', ...)`) stays **exactly as it is** — the whole point of this task is that the Anthropic path's behavior is unchanged, just reached through the renamed, profile-parameterized class.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/themeGenerator.test.ts`
Expected: FAIL — `lib/services/ClaudeApiThemeGenerator.ts` and `@/lib/services/claudeApiProviders`'s `ANTHROPIC_PROVIDER` import resolve, but `AnthropicThemeGenerator.ts` still exists with the old, unparameterized class, so `ClaudeApiThemeGenerator` doesn't exist yet — a module resolution error.

- [ ] **Step 3: Create the renamed, profile-parameterized generator**

```typescript
// lib/services/ClaudeApiThemeGenerator.ts
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { styleService } from '@/lib/services/StyleService';
import type { ClaudeApiProvider } from '@/lib/services/claudeApiProviders';
import {
  ThemeTokensSchema,
  tokensToCss,
  buildThemePrompt,
  type ThemeGenerator,
  type GeneratedTheme,
} from '@/lib/services/ThemeGenerator';

const ANTHROPIC_VERSION = '2023-06-01';
const REQUEST_TIMEOUT_MS = 60_000;

const TOOL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    colorBackground: { type: 'string', description: 'Primary page background color as a hex code, e.g. "#1a1420".' },
    colorForeground: { type: 'string', description: 'Primary text color as a hex code, readable against colorBackground.' },
    colorAccent: { type: 'string', description: 'Accent color for buttons, links, highlights, as a hex code.' },
    colorBorder: { type: 'string', description: 'Border/divider color as a hex code.' },
    fontHeading: { type: 'string', description: 'A CSS font-family value for headings, e.g. "\'Cinzel\', serif".' },
    fontBody: { type: 'string', description: 'A CSS font-family value for body text.' },
    spaceUnit: { type: 'string', description: 'Base spacing unit as a CSS length in px, rem, or em, e.g. "8px".' },
    radiusBase: { type: 'string', description: 'Base border-radius as a CSS length in px, rem, or em, e.g. "4px".' },
  },
  required: ['colorBackground', 'colorForeground', 'colorAccent', 'colorBorder', 'fontHeading', 'fontBody', 'spaceUnit', 'radiusBase'],
};

type ToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
};

interface AnthropicMessageResponse {
  content: Array<{ type: string } & Record<string, unknown>>;
  stop_reason: string;
}

/**
 * Real Claude Messages API, called directly via fetch (no
 * @anthropic-ai/sdk dependency — matches PixellabGenerator's own
 * direct-fetch convention). Forces a single tool call so the response
 * is reliably structured, rather than asking for JSON in prose.
 *
 * Parameterized by a ClaudeApiProvider profile (see
 * lib/services/claudeApiProviders.ts) rather than hardcoding Anthropic's
 * own host — cheaperinference.com and kie.ai both proxy the same
 * underlying Messages API shape, so everything below this line (request
 * body, forced tool_choice, response parsing, ThemeTokensSchema
 * validation, CSS writing, error diagnosis) is genuinely shared across
 * all three, not just the official API.
 */
export class ClaudeApiThemeGenerator implements ThemeGenerator {
  constructor(private apiKey: string, private provider: ClaudeApiProvider) {}

  async generate(prompt: string, styleId: string): Promise<GeneratedTheme> {
    const style = await styleService.getById(styleId);
    const fullPrompt = buildThemePrompt(style?.parameters ?? '{}', prompt);

    const res = await fetch(this.provider.requestUrl, {
      method: 'POST',
      headers: {
        ...this.provider.buildAuthHeaders(this.apiKey),
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.provider.model,
        max_tokens: 4096,
        tools: [
          {
            name: 'emit_theme',
            description: 'Emit a website design token set matching the requested aesthetic.',
            input_schema: TOOL_INPUT_SCHEMA,
          },
        ],
        tool_choice: { type: 'tool', name: 'emit_theme' },
        messages: [{ role: 'user', content: fullPrompt }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic theme generation failed via ${this.provider.name} (${res.status}): ${body || res.statusText}`);
    }

    const data = (await res.json()) as AnthropicMessageResponse;
    if (data.stop_reason === 'max_tokens') {
      throw new Error(
        `Anthropic response (via ${this.provider.name}) was truncated (stop_reason: max_tokens) before completing the tool call — the theme could not be generated.`
      );
    }
    const toolUse = data.content.find((block): block is ToolUseBlock => block.type === 'tool_use');
    if (!toolUse) {
      throw new Error(`Anthropic response (via ${this.provider.name}) contained no tool_use block for emit_theme.`);
    }

    const tokens = ThemeTokensSchema.parse(toolUse.input);
    const filename = `theme-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.css`;

    const themesDir = path.join(getProjectRoot(), 'storage', 'themes');
    try {
      await fsPromises.mkdir(themesDir, { recursive: true });
      await fsPromises.writeFile(path.join(themesDir, filename), tokensToCss(tokens));
    } catch (e) {
      console.error(`Failed to write theme file ${filename}:`, e);
      throw e;
    }

    return { path: filename, prompt };
  }
}
```

`lib/services/AnthropicThemeGenerator.ts` stays exactly as it is —
do not touch or delete it in this task (see the file-map note above).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/themeGenerator.test.ts`
Expected: PASS (14 tests — same 14 as before this task, unchanged behavior).

- [ ] **Step 5: Run the full suite, typecheck, lint**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: everything green. `lib/services/AnthropicThemeGenerator.ts` still exists and is still imported by `lib/services/ThemeGenerator.ts`, unaffected by this task — its own file is untouched, so nothing here breaks it.

- [ ] **Step 6: Commit**

```bash
git add lib/services/ClaudeApiThemeGenerator.ts test/themeGenerator.test.ts
git commit -m "Add ClaudeApiThemeGenerator, parameterized by provider profile (AnthropicThemeGenerator removed in the next task)"
```

---

### Task 3: Provider selection in `getThemeGenerator()`

**Files:**
- Modify: `lib/services/ThemeGenerator.ts`
- Delete: `lib/services/AnthropicThemeGenerator.ts`
- Modify: `.env.local.example`
- Modify: `README.md`
- Test: `test/getThemeGeneratorSelection.test.ts`

**Interfaces:**
- Consumes: `ClaudeApiThemeGenerator`, `ClaudeApiProvider`, `ANTHROPIC_PROVIDER`, `CHEAPERINFERENCE_PROVIDER`, `KIEAI_PROVIDER` (Tasks 1-2).
- Produces: `getThemeGenerator(): ThemeGenerator` — same public signature as today, now with 3-way selection internally. Nothing later depends on new exports from this task.

The current `lib/services/ThemeGenerator.ts` (full file, unchanged since it
shipped) has this import line and this function at the bottom:

```typescript
import { AnthropicThemeGenerator } from '@/lib/services/AnthropicThemeGenerator';
```

```typescript
// Lazy, mock-vs-real singleton — same reasoning as getImageGenerator():
// ESM import hoisting would otherwise evaluate process.env.ANTHROPIC_API_KEY
// before worker.ts's own env-loading flag has landed it in process.env.
let cachedThemeGenerator: ThemeGenerator | undefined;

export function getThemeGenerator(): ThemeGenerator {
  if (!cachedThemeGenerator) {
    cachedThemeGenerator = process.env.ANTHROPIC_API_KEY
      ? new AnthropicThemeGenerator(process.env.ANTHROPIC_API_KEY)
      : new MockThemeGenerator();
  }
  return cachedThemeGenerator;
}
```

Every other line in this file (the regex constants, `ThemeTokensSchema`,
`GeneratedTheme`, `ThemeGenerator` interface, `tokensToCss`,
`buildThemePrompt`, `FIXED_MOCK_TOKENS`, `MockThemeGenerator`) is
untouched by this task.

- [ ] **Step 1: Write the failing test**

```typescript
// test/getThemeGeneratorSelection.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';

let tempRoot: string;
const STYLE_ID = '88888888-8888-8888-8888-888888888888';

function mockFetchOnce() {
  return vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify({
      content: [{
        type: 'tool_use', id: 'tool_1', name: 'emit_theme',
        input: {
          colorBackground: '#1a1420', colorForeground: '#f0e6d2', colorAccent: '#e8a33d', colorBorder: '#4a3728',
          fontHeading: "'Cinzel', serif", fontBody: "'EB Garamond', serif", spaceUnit: '8px', radiusBase: '4px',
        },
      }],
      stop_reason: 'tool_use',
    }), { status: 200 })
  );
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-themeselect-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'themes'), { recursive: true });

  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }

  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'style', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_ID);

  vi.resetModules();
  vi.unstubAllEnvs();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('getThemeGenerator() provider selection', () => {
  it('defaults to MockThemeGenerator when THEME_API_PROVIDER and ANTHROPIC_API_KEY are both unset', async () => {
    const { getThemeGenerator, MockThemeGenerator } = await import('@/lib/services/ThemeGenerator');
    const gen = getThemeGenerator();
    expect(gen).toBeInstanceOf(MockThemeGenerator);
  });

  it('routes to the official Anthropic endpoint when THEME_API_PROVIDER is unset but ANTHROPIC_API_KEY is set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'fake-anthropic-key');
    const fetchMock = mockFetchOnce();
    vi.stubGlobal('fetch', fetchMock);

    const { getThemeGenerator } = await import('@/lib/services/ThemeGenerator');
    await getThemeGenerator().generate('x', STYLE_ID);

    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', expect.anything());
  });

  it('routes to cheaperinference.com when THEME_API_PROVIDER=cheaperinference and its key is set', async () => {
    vi.stubEnv('THEME_API_PROVIDER', 'cheaperinference');
    vi.stubEnv('CHEAPERINFERENCE_API_KEY', 'fake-ci-key');
    const fetchMock = mockFetchOnce();
    vi.stubGlobal('fetch', fetchMock);

    const { getThemeGenerator } = await import('@/lib/services/ThemeGenerator');
    await getThemeGenerator().generate('x', STYLE_ID);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cheaperinference.com/v1/messages',
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Api-Key': 'fake-ci-key' }) })
    );
  });

  it('routes to kie.ai when THEME_API_PROVIDER=kieai and its key is set', async () => {
    vi.stubEnv('THEME_API_PROVIDER', 'kieai');
    vi.stubEnv('KIEAI_API_KEY', 'fake-kieai-key');
    const fetchMock = mockFetchOnce();
    vi.stubGlobal('fetch', fetchMock);

    const { getThemeGenerator } = await import('@/lib/services/ThemeGenerator');
    await getThemeGenerator().generate('x', STYLE_ID);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.kie.ai/claude/v1/messages',
      expect.objectContaining({ headers: expect.objectContaining({ ANTHROPIC_AUTH_TOKEN: 'fake-kieai-key' }) })
    );
  });

  it('throws a clear error when THEME_API_PROVIDER=cheaperinference but CHEAPERINFERENCE_API_KEY is missing', async () => {
    vi.stubEnv('THEME_API_PROVIDER', 'cheaperinference');
    const { getThemeGenerator } = await import('@/lib/services/ThemeGenerator');
    expect(() => getThemeGenerator()).toThrow(/CHEAPERINFERENCE_API_KEY/);
  });

  it('throws a clear error when THEME_API_PROVIDER=kieai but KIEAI_API_KEY is missing', async () => {
    vi.stubEnv('THEME_API_PROVIDER', 'kieai');
    const { getThemeGenerator } = await import('@/lib/services/ThemeGenerator');
    expect(() => getThemeGenerator()).toThrow(/KIEAI_API_KEY/);
  });

  it('throws a clear error for an unrecognized THEME_API_PROVIDER value', async () => {
    vi.stubEnv('THEME_API_PROVIDER', 'not-a-real-provider');
    const { getThemeGenerator } = await import('@/lib/services/ThemeGenerator');
    expect(() => getThemeGenerator()).toThrow(/not-a-real-provider/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/getThemeGeneratorSelection.test.ts`
Expected: FAIL — 5 of the 7 tests fail. `lib/services/ThemeGenerator.ts` at this point (unchanged since Task 2) has no concept of `THEME_API_PROVIDER` at all, so it ignores that env var entirely and falls back to its old ANTHROPIC_API_KEY-or-mock check. The two tests that don't set `THEME_API_PROVIDER` ("defaults to MockThemeGenerator" and "routes to the official Anthropic endpoint") pass by coincidence, since that default path is genuinely unchanged; the other 5 (cheaperinference routing, kieai routing, both missing-key throws, and the unrecognized-value throw) fail — confirming the missing behavior is real, not a typo in the test.

- [ ] **Step 3: Update `getThemeGenerator()`, and remove the old file**

Replace the import line:

```typescript
import { AnthropicThemeGenerator } from '@/lib/services/AnthropicThemeGenerator';
```

with:

```typescript
import { ClaudeApiThemeGenerator } from '@/lib/services/ClaudeApiThemeGenerator';
import { ANTHROPIC_PROVIDER, CHEAPERINFERENCE_PROVIDER, KIEAI_PROVIDER } from '@/lib/services/claudeApiProviders';
```

Replace the `getThemeGenerator()` function:

```typescript
export function getThemeGenerator(): ThemeGenerator {
  if (!cachedThemeGenerator) {
    cachedThemeGenerator = process.env.ANTHROPIC_API_KEY
      ? new AnthropicThemeGenerator(process.env.ANTHROPIC_API_KEY)
      : new MockThemeGenerator();
  }
  return cachedThemeGenerator;
}
```

with:

```typescript
export function getThemeGenerator(): ThemeGenerator {
  if (!cachedThemeGenerator) {
    const providerName = process.env.THEME_API_PROVIDER;

    if (!providerName || providerName === 'anthropic') {
      cachedThemeGenerator = process.env.ANTHROPIC_API_KEY
        ? new ClaudeApiThemeGenerator(process.env.ANTHROPIC_API_KEY, ANTHROPIC_PROVIDER)
        : new MockThemeGenerator();
    } else if (providerName === 'cheaperinference') {
      const apiKey = process.env.CHEAPERINFERENCE_API_KEY;
      if (!apiKey) {
        throw new Error('THEME_API_PROVIDER is set to "cheaperinference" but CHEAPERINFERENCE_API_KEY is not configured.');
      }
      cachedThemeGenerator = new ClaudeApiThemeGenerator(apiKey, CHEAPERINFERENCE_PROVIDER);
    } else if (providerName === 'kieai') {
      const apiKey = process.env.KIEAI_API_KEY;
      if (!apiKey) {
        throw new Error('THEME_API_PROVIDER is set to "kieai" but KIEAI_API_KEY is not configured.');
      }
      cachedThemeGenerator = new ClaudeApiThemeGenerator(apiKey, KIEAI_PROVIDER);
    } else {
      throw new Error(`Unknown THEME_API_PROVIDER "${providerName}" — expected "anthropic", "cheaperinference", or "kieai".`);
    }
  }
  return cachedThemeGenerator;
}
```

The comment directly above `let cachedThemeGenerator` stays as-is — the
lazy-singleton-for-env-var-timing reasoning still applies identically
with three providers instead of two.

Now that nothing imports it any more, remove the old file:

```bash
git rm lib/services/AnthropicThemeGenerator.ts
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/getThemeGeneratorSelection.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Document the new env vars**

In `.env.local.example`, the current block reads:

```
# Anthropic (enables real website theme generation, replacing MockThemeGenerator)
# ANTHROPIC_API_KEY=
```

Replace with:

```
# Anthropic (enables real website theme generation, replacing MockThemeGenerator)
# ANTHROPIC_API_KEY=

# Alternative Claude API providers for theme generation — set THEME_API_PROVIDER
# to switch which one is active. Leave unset to use ANTHROPIC_API_KEY above (or
# MockThemeGenerator if that's unset too). Only the key matching the selected
# provider needs a real value.
# THEME_API_PROVIDER=cheaperinference
# CHEAPERINFERENCE_API_KEY=
# THEME_API_PROVIDER=kieai
# KIEAI_API_KEY=
```

In `README.md`, the current paragraph reads:

```
Set `ANTHROPIC_API_KEY` in `.env.local` to enable real website theme generation. Without a key, generation
falls back to `MockThemeGenerator`, which writes a fixed token set so the rest of the pipeline stays
exercisable.
```

Add a new paragraph immediately after it:

```
Instead of the official Anthropic API, theme generation can also run through cheaperinference.com or
kie.ai — set `THEME_API_PROVIDER` to `cheaperinference` or `kieai` and provide the matching
`CHEAPERINFERENCE_API_KEY` or `KIEAI_API_KEY`. Leaving `THEME_API_PROVIDER` unset keeps the
`ANTHROPIC_API_KEY`-or-mock behavior above unchanged. An explicitly-selected provider whose key is missing
fails with a clear error rather than silently falling back to the mock.
```

- [ ] **Step 6: Run the full suite, typecheck, lint**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: everything green.

- [ ] **Step 7: Commit**

```bash
git add lib/services/ThemeGenerator.ts .env.local.example README.md test/getThemeGeneratorSelection.test.ts
git add lib/services/AnthropicThemeGenerator.ts
git commit -m "Add THEME_API_PROVIDER selection for cheaperinference.com and kie.ai"
```

(The second `git add` stages the deletion from Step 3 — `git rm` already
removed the file from the working tree; this stages that removal
alongside everything else in one commit.)

---

## Manual verification (once a real key exists for either provider)

Not a task with its own commit — a follow-up check, same discipline as
this feature's own predecessor's Task 8. Neither third-party provider's
forced-`tool_choice` behavior is confirmed; this is the one thing no
automated test in this plan can verify.

1. Set `THEME_API_PROVIDER` and the matching key in `.env.local`.
2. Run `npm run dev:worker`, queue a real theme generation from
   `/dashboard/themes`.
3. If it completes: open the generated `.css` file and confirm it has
   real, sensible token values (not a truncated or malformed file).
4. If it fails: read the worker log's error message — per this plan's
   Global Constraints, it will name which provider was active and
   which specific failure mode occurred (bad status, no tool_use block,
   truncated response, schema validation failure), which is enough to
   tell whether the provider genuinely doesn't support forced
   `tool_choice` the way this code needs, or something more mundane
   (wrong key, wrong model name) is wrong.
