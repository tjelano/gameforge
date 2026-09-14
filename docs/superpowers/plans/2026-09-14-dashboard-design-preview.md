# Dashboard Design Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in dashboard page where GameForge's own UI tokens (colors, radius, fonts — the
`app/globals.css` `:root` block) can be live-edited and previewed against real component classes, with
a "Copy CSS" button producing ready-to-paste output — no external tooling needed for future visual
design work on the app's own UI.

**Architecture:** A single, fully client-side Next.js page. No new API route, service, or database
table. Previewed tokens are applied as inline CSS custom properties on a wrapper `<div>`; everything
inside that div that reads `var(--bg)` etc. (directly, or transitively through a shared class) sees
the overridden value, while the rest of the real dashboard is untouched — ordinary CSS cascade rules,
no iframe/sandboxing needed (unlike the existing, unrelated game-theme preview tool, which needs an
iframe only because it previews a *different* token namespace that collides with this one).

**Tech Stack:** Next.js App Router, React state (`useState`/`useEffect`), the Clipboard API with a
`<textarea>` fallback. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-14-dashboard-design-preview-design.md` (read this too — it
has the full reasoning, including two things verified directly in a live browser during its DeepSeek
review: custom properties with no nested `var()` preserve their literal authored text when read via
`getComputedStyle`, while custom properties that DO contain a nested `var()` get that reference
substituted — which is why the 3 font tokens are never read via `getComputedStyle`, only the 16 colors
and `--radius` are).

## Global Constraints

- No ORM, no wrapper classes, no new dependencies, no DB table, no new API route — this entire feature
  is one client-side page plus one pure-logic utility module.
- No React component rendering tests anywhere in this codebase (confirmed project-wide: zero
  `@testing-library` usage) — the page component itself is verified manually in a running dev server,
  per this project's established convention. Only the plain-logic utility module gets real unit tests.
- `app/globals.css` is NOT modified by this plan — the page's own layout uses plain inline styles
  (matching the precedent already set by the Overview and NavRail pages for page-specific layout,
  e.g. flex/gap/minWidth), and the mockup reuses existing shared classes (`.card`, `.btn`,
  `.btn-primary`, `.btn-keeper`, `.btn-reject`, `.rail-link`, `.page-title`, `.page-subtitle`,
  `.frame-label`, `.stat-card-label`, `.stat-card-value`, `.settings-item`, `.settings-item-desc`,
  `.activity-row`, `.activity-row-meta`) exactly as they exist today.
- Token count is 20 total: 16 colors + `--radius` + 3 font roles (`--font-display`, `--font-body`,
  `--font-mono`). Serialization order must match `globals.css`'s own `:root` block order exactly:
  `--bg, --surface, --surface-raised, --border, --ink, --ink-dim, --ink-faint, --accent,
  --accent-bright, --accent-dim, --accent-2, --accent-ink, --keeper, --keeper-dim, --reject,
  --reject-dim, --radius, --font-display, --font-body, --font-mono`.
- Font token state holds the full `var(...)` chain string directly (never just a label) — the same
  value drives both the `<select>`'s `value`/`<option value>` and the serializer, with no
  label-to-chain lookup table anywhere.
- An empty/non-numeric radius value serializes to the real default (`7px`), never invalid CSS like
  `--radius: px;`.
- Hex values are normalized to uppercase only at serialize time (in the Copy CSS output) — live state
  keeps whatever case the operator typed or the native color-picker input produced.
- `navigator.clipboard` is only available in a secure context (`localhost`, not a LAN IP) — when
  unavailable, or if the write itself throws, fall back to a visible, selectable `<textarea readOnly>`
  instead of failing silently.

---

### Task 1: Token utility module (pure logic, TDD)

**Files:**
- Create: `lib/utils/designPreviewTokens.ts`
- Test: `test/designPreviewTokens.test.ts`

**Interfaces:**
- Produces: `ColorTokenKey` (union type), `FontTokenKey` (union type), `DesignPreviewTokenState`
  (interface), `COLOR_TOKENS`, `FONT_TOKENS`, `FONT_OPTIONS`, `DEFAULT_RADIUS` (data), `isValidHex`,
  `parseRadiusPx`, `formatRadiusPx`, `normalizeHex`, `serializeTokensToCss` (functions) — Task 3's
  page imports all of these directly, with these exact names and signatures.

- [ ] **Step 1: Write the failing tests**

Create `test/designPreviewTokens.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  COLOR_TOKENS,
  FONT_TOKENS,
  FONT_OPTIONS,
  DEFAULT_RADIUS,
  isValidHex,
  parseRadiusPx,
  formatRadiusPx,
  normalizeHex,
  serializeTokensToCss,
  type DesignPreviewTokenState,
} from '@/lib/utils/designPreviewTokens';

describe('isValidHex', () => {
  it('accepts a 6-digit hex color', () => {
    expect(isValidHex('#0A0A0A')).toBe(true);
    expect(isValidHex('#8ea885')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isValidHex('')).toBe(false);
    expect(isValidHex('#12')).toBe(false);
    expect(isValidHex('not-a-color')).toBe(false);
    expect(isValidHex('rgb(10, 10, 10)')).toBe(false);
  });
});

describe('parseRadiusPx', () => {
  it('parses a computed px string into a number', () => {
    expect(parseRadiusPx('7px')).toBe(7);
    expect(parseRadiusPx('12px')).toBe(12);
  });

  it('falls back to the default for an empty or unparseable value', () => {
    expect(parseRadiusPx('')).toBe(DEFAULT_RADIUS);
    expect(parseRadiusPx('not-a-number')).toBe(DEFAULT_RADIUS);
  });
});

describe('formatRadiusPx', () => {
  it('formats a number as a px string', () => {
    expect(formatRadiusPx(12)).toBe('12px');
  });

  it('formats a numeric string as a px string', () => {
    expect(formatRadiusPx('9')).toBe('9px');
  });

  it('falls back to the default for an empty or non-numeric value', () => {
    expect(formatRadiusPx('')).toBe(`${DEFAULT_RADIUS}px`);
    expect(formatRadiusPx('abc')).toBe(`${DEFAULT_RADIUS}px`);
  });
});

describe('normalizeHex', () => {
  it('uppercases a hex color and trims whitespace', () => {
    expect(normalizeHex('#8ea885')).toBe('#8EA885');
    expect(normalizeHex(' #0a0a0a ')).toBe('#0A0A0A');
  });
});

function makeState(overrides: Partial<DesignPreviewTokenState> = {}): DesignPreviewTokenState {
  const base = {} as DesignPreviewTokenState;
  for (const t of COLOR_TOKENS) base[t.key] = '#000000';
  base.radius = '7';
  base.fontDisplay = FONT_OPTIONS[0].value;
  base.fontBody = FONT_OPTIONS[1].value;
  base.fontMono = FONT_OPTIONS[2].value;
  return { ...base, ...overrides };
}

describe('serializeTokensToCss', () => {
  it('emits all 20 tokens in the same order as globals.css\'s own :root block', () => {
    const css = serializeTokensToCss(makeState());
    const varNames = css.split('\n').slice(1, -1).map(line => line.trim().split(':')[0]);
    expect(varNames).toEqual([
      '--bg', '--surface', '--surface-raised', '--border',
      '--ink', '--ink-dim', '--ink-faint',
      '--accent', '--accent-bright', '--accent-dim', '--accent-2', '--accent-ink',
      '--keeper', '--keeper-dim', '--reject', '--reject-dim',
      '--radius', '--font-display', '--font-body', '--font-mono',
    ]);
  });

  it('normalizes hex color casing on output', () => {
    const css = serializeTokensToCss(makeState({ bg: '#abcdef' }));
    expect(css).toContain('--bg: #ABCDEF;');
  });

  it('serializes font tokens as their literal var() chains, not just a label', () => {
    const css = serializeTokensToCss(makeState());
    expect(css).toContain(`--font-display: ${FONT_OPTIONS[0].value};`);
    expect(css).toContain(`--font-body: ${FONT_OPTIONS[1].value};`);
    expect(css).toContain(`--font-mono: ${FONT_OPTIONS[2].value};`);
  });

  it('falls back to the default radius when the state value is empty', () => {
    const css = serializeTokensToCss(makeState({ radius: '' }));
    expect(css).toContain(`--radius: ${DEFAULT_RADIUS}px;`);
  });

  it('has exactly 16 color tokens and 3 font tokens/options', () => {
    expect(COLOR_TOKENS).toHaveLength(16);
    expect(FONT_TOKENS).toHaveLength(3);
    expect(FONT_OPTIONS).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/designPreviewTokens.test.ts`
Expected: FAIL with "Cannot find module '@/lib/utils/designPreviewTokens'"

- [ ] **Step 3: Write the implementation**

Create `lib/utils/designPreviewTokens.ts`:

```ts
export type ColorTokenKey =
  | 'bg' | 'surface' | 'surfaceRaised' | 'border'
  | 'ink' | 'inkDim' | 'inkFaint'
  | 'accent' | 'accentBright' | 'accentDim' | 'accent2' | 'accentInk'
  | 'keeper' | 'keeperDim' | 'reject' | 'rejectDim';

export type FontTokenKey = 'fontDisplay' | 'fontBody' | 'fontMono';

export interface DesignPreviewTokenState extends Record<ColorTokenKey, string> {
  radius: string;
  fontDisplay: string;
  fontBody: string;
  fontMono: string;
}

export const COLOR_TOKENS: { key: ColorTokenKey; cssVar: string; label: string }[] = [
  { key: 'bg', cssVar: '--bg', label: 'Background' },
  { key: 'surface', cssVar: '--surface', label: 'Surface' },
  { key: 'surfaceRaised', cssVar: '--surface-raised', label: 'Surface (raised)' },
  { key: 'border', cssVar: '--border', label: 'Border' },
  { key: 'ink', cssVar: '--ink', label: 'Ink' },
  { key: 'inkDim', cssVar: '--ink-dim', label: 'Ink (dim)' },
  { key: 'inkFaint', cssVar: '--ink-faint', label: 'Ink (faint)' },
  { key: 'accent', cssVar: '--accent', label: 'Accent' },
  { key: 'accentBright', cssVar: '--accent-bright', label: 'Accent (bright)' },
  { key: 'accentDim', cssVar: '--accent-dim', label: 'Accent (dim)' },
  { key: 'accent2', cssVar: '--accent-2', label: 'Accent 2' },
  { key: 'accentInk', cssVar: '--accent-ink', label: 'Accent ink' },
  { key: 'keeper', cssVar: '--keeper', label: 'Keeper' },
  { key: 'keeperDim', cssVar: '--keeper-dim', label: 'Keeper (dim)' },
  { key: 'reject', cssVar: '--reject', label: 'Reject' },
  { key: 'rejectDim', cssVar: '--reject-dim', label: 'Reject (dim)' },
];

export const FONT_OPTIONS: { value: string; label: string }[] = [
  { value: "var(--font-sentient), Georgia, serif", label: 'Sentient' },
  { value: "var(--font-satoshi), -apple-system, 'Segoe UI', sans-serif", label: 'Satoshi' },
  { value: "var(--font-plex-mono), 'IBM Plex Mono', monospace", label: 'IBM Plex Mono' },
];

export const FONT_TOKENS: { key: FontTokenKey; cssVar: string; label: string; defaultValue: string }[] = [
  { key: 'fontDisplay', cssVar: '--font-display', label: 'Display (headings)', defaultValue: FONT_OPTIONS[0].value },
  { key: 'fontBody', cssVar: '--font-body', label: 'Body', defaultValue: FONT_OPTIONS[1].value },
  { key: 'fontMono', cssVar: '--font-mono', label: 'Mono', defaultValue: FONT_OPTIONS[2].value },
];

export const DEFAULT_RADIUS = 7;

export function isValidHex(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value.trim());
}

export function parseRadiusPx(computed: string): number {
  const n = parseInt(computed, 10);
  return Number.isNaN(n) ? DEFAULT_RADIUS : n;
}

export function formatRadiusPx(value: string | number): string {
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  return `${Number.isNaN(n) ? DEFAULT_RADIUS : n}px`;
}

export function normalizeHex(value: string): string {
  return value.trim().toUpperCase();
}

export function serializeTokensToCss(state: DesignPreviewTokenState): string {
  const lines: string[] = [':root {'];
  for (const t of COLOR_TOKENS) {
    lines.push(`  ${t.cssVar}: ${normalizeHex(state[t.key])};`);
  }
  lines.push(`  --radius: ${formatRadiusPx(state.radius)};`);
  for (const t of FONT_TOKENS) {
    lines.push(`  ${t.cssVar}: ${state[t.key]};`);
  }
  lines.push('}');
  return lines.join('\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/designPreviewTokens.test.ts`
Expected: PASS, 13/13.

- [ ] **Step 5: Run the full test suite, tsc, and eslint**

Run: `npx vitest run && npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add lib/utils/designPreviewTokens.ts test/designPreviewTokens.test.ts
git commit -m "feat: add pure token logic for the dashboard design-preview tool"
```

---

### Task 2: Register the route and add the Settings hub card

**Files:**
- Modify: `lib/dashboardRoutes.ts`
- Modify: `app/dashboard/settings/page.tsx`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: the route `/dashboard/settings/design-preview` as a valid `DASHBOARD_ROUTES` entry
  (so the AI copilot's `navigate_to_page` tool can reach it) and as a 6th Settings hub card. Task 3's
  page file must exist at the exact path this task wires up, or the hub's link and the copilot's tool
  both 404 until Task 3 lands — harmless mid-plan (nothing else links to it yet), resolved by Task 3.

No automated test — matches this file's and the Settings hub page's own established convention (no
test file exists for either today); verified manually alongside Task 3's own manual verification.

- [ ] **Step 1: Add the route to `DASHBOARD_ROUTES`**

In `lib/dashboardRoutes.ts`, add one new entry at the end of the array (after the `Ollama` entry):

```ts
  { href: '/dashboard/settings/design-preview', label: 'Design Preview' },
```

No other change to this file — `NAV_PRIMARY_ROUTES`'s filter already excludes anything starting with
`/dashboard/settings/`, so this new entry is automatically hidden from the visible sidebar and valid
for the copilot's navigation tool, with zero filter changes needed.

- [ ] **Step 2: Add the card to the Settings hub**

In `app/dashboard/settings/page.tsx`, add one new entry to the `SETTINGS_PAGES` array (after the
`Ollama` entry):

```ts
  { href: '/dashboard/settings/design-preview', name: 'Design Preview', description: 'Live-edit GameForge\'s own color and font tokens and preview the result.' },
```

- [ ] **Step 3: Run the full test suite, tsc, and eslint**

Run: `npx vitest run && npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: all clean (this task only adds data, no new logic to break).

- [ ] **Step 4: Commit**

```bash
git add lib/dashboardRoutes.ts app/dashboard/settings/page.tsx
git commit -m "feat: register the design-preview route and its Settings hub card"
```

---

### Task 3: The Design Preview page

**Files:**
- Create: `app/dashboard/settings/design-preview/page.tsx`

**Interfaces:**
- Consumes: everything Task 1 exports from `lib/utils/designPreviewTokens.ts` (`ColorTokenKey`,
  `DesignPreviewTokenState`, `COLOR_TOKENS`, `FONT_TOKENS`, `FONT_OPTIONS`, `DEFAULT_RADIUS`,
  `isValidHex`, `parseRadiusPx`, `formatRadiusPx`, `serializeTokensToCss`).

No automated test for this page component — matches this codebase's established convention (zero
`@testing-library` usage anywhere); verified manually in a running dev server per Step 3 below.

- [ ] **Step 1: Create the page**

Create `app/dashboard/settings/design-preview/page.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  COLOR_TOKENS,
  FONT_TOKENS,
  FONT_OPTIONS,
  DEFAULT_RADIUS,
  isValidHex,
  parseRadiusPx,
  formatRadiusPx,
  serializeTokensToCss,
  type ColorTokenKey,
  type FontTokenKey,
  type DesignPreviewTokenState,
} from '@/lib/utils/designPreviewTokens';

function buildDefaultState(): DesignPreviewTokenState {
  const state = {} as DesignPreviewTokenState;
  for (const t of COLOR_TOKENS) state[t.key] = '';
  state.radius = String(DEFAULT_RADIUS);
  for (const t of FONT_TOKENS) state[t.key] = t.defaultValue;
  return state;
}

export default function DesignPreviewPage() {
  const [tokens, setTokens] = useState<DesignPreviewTokenState>(buildDefaultState);
  const [copied, setCopied] = useState(false);
  const [clipboardUnavailable, setClipboardUnavailable] = useState(false);

  useEffect(() => {
    const cs = getComputedStyle(document.documentElement);
    setTokens(prev => {
      const next = { ...prev };
      for (const t of COLOR_TOKENS) {
        const value = cs.getPropertyValue(t.cssVar).trim();
        if (value) next[t.key] = value;
      }
      next.radius = String(parseRadiusPx(cs.getPropertyValue('--radius')));
      return next;
    });
  }, []);

  function setColor(key: ColorTokenKey, value: string) {
    setTokens(prev => ({ ...prev, [key]: value }));
  }

  function setFont(key: FontTokenKey, value: string) {
    setTokens(prev => ({ ...prev, [key]: value }));
  }

  async function handleCopy() {
    const css = serializeTokensToCss(tokens);
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(css);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        return;
      } catch {
        // Clipboard exists but the write itself failed (permissions, etc.) -- fall through.
      }
    }
    setClipboardUnavailable(true);
  }

  const cssText = serializeTokensToCss(tokens);
  const mockupStyle = {
    '--bg': tokens.bg,
    '--surface': tokens.surface,
    '--surface-raised': tokens.surfaceRaised,
    '--border': tokens.border,
    '--ink': tokens.ink,
    '--ink-dim': tokens.inkDim,
    '--ink-faint': tokens.inkFaint,
    '--accent': tokens.accent,
    '--accent-bright': tokens.accentBright,
    '--accent-dim': tokens.accentDim,
    '--accent-2': tokens.accent2,
    '--accent-ink': tokens.accentInk,
    '--keeper': tokens.keeper,
    '--keeper-dim': tokens.keeperDim,
    '--reject': tokens.reject,
    '--reject-dim': tokens.rejectDim,
    '--radius': formatRadiusPx(tokens.radius),
    '--font-display': tokens.fontDisplay,
    '--font-body': tokens.fontBody,
    '--font-mono': tokens.fontMono,
  } as CSSProperties;

  return (
    <>
      <h1 className="page-title">Design Preview</h1>
      <p className="page-subtitle">
        Live-edit GameForge&apos;s own color and font tokens and see them rendered against real
        dashboard components. Nothing here is saved — copy the CSS below and paste it into
        app/globals.css yourself when you land on something you like.
      </p>

      <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 320px', minWidth: 280 }}>
          <h2 className="frame-label" style={{ marginBottom: 12 }}>Colors</h2>
          {COLOR_TOKENS.map(t => (
            <div key={t.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <input
                type="color"
                value={isValidHex(tokens[t.key]) ? tokens[t.key] : '#000000'}
                onChange={e => setColor(t.key, e.target.value)}
              />
              <input
                key={tokens[t.key]}
                type="text"
                defaultValue={tokens[t.key]}
                onBlur={e => { if (isValidHex(e.target.value)) setColor(t.key, e.target.value); }}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                style={{ width: 90 }}
              />
              <span style={{ fontSize: 12, color: 'var(--ink-dim)' }}>{t.label}</span>
            </div>
          ))}

          <h2 className="frame-label" style={{ marginTop: 24, marginBottom: 12 }}>Shape</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <input
              type="number"
              value={tokens.radius}
              onChange={e => setTokens(prev => ({ ...prev, radius: e.target.value }))}
              style={{ width: 90 }}
            />
            <span style={{ fontSize: 12, color: 'var(--ink-dim)' }}>Radius (px)</span>
          </div>

          <h2 className="frame-label" style={{ marginTop: 24, marginBottom: 12 }}>Typography</h2>
          {FONT_TOKENS.map(t => (
            <div key={t.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <select value={tokens[t.key]} onChange={e => setFont(t.key, e.target.value)}>
                {FONT_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <span style={{ fontSize: 12, color: 'var(--ink-dim)' }}>{t.label}</span>
            </div>
          ))}

          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy CSS'}
          </button>

          {clipboardUnavailable && (
            <div style={{ marginTop: 12 }}>
              <p className="page-subtitle" style={{ margin: '0 0 6px 0' }}>
                Clipboard access isn&apos;t available over this connection — select the text below and
                copy it manually:
              </p>
              <textarea
                readOnly
                value={cssText}
                onFocus={e => e.target.select()}
                style={{ width: '100%', height: 160, fontFamily: 'var(--font-mono)', fontSize: 12 }}
              />
            </div>
          )}
        </div>

        <div
          className="card"
          style={{ flex: '1 1 360px', minWidth: 300, ...mockupStyle } as CSSProperties}
        >
          <div style={{ background: 'var(--bg)', padding: 20, borderRadius: 'var(--radius)' }}>
            <div
              style={{
                display: 'flex',
                gap: 16,
                alignItems: 'center',
                marginBottom: 16,
                paddingBottom: 12,
                borderBottom: '1px solid var(--border)',
              }}
            >
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--ink)' }}>
                Game<span style={{ color: 'var(--accent)' }}>Forge</span>
              </div>
              <a className="rail-link" data-active="true" href="#" onClick={e => e.preventDefault()} style={{ padding: '4px 10px' }}>
                Overview
              </a>
              <a className="rail-link" href="#" onClick={e => e.preventDefault()} style={{ padding: '4px 10px' }}>
                Generate
              </a>
            </div>

            <h1 className="page-title" style={{ fontSize: 22 }}>Preview heading</h1>
            <p className="page-subtitle">A sample paragraph, styled by the tokens on the left.</p>

            <div className="card" style={{ marginBottom: 16 }}>
              <div className="stat-card-label">Active styles</div>
              <div className="stat-card-value">12</div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              <button className="btn btn-primary">Primary</button>
              <button className="btn btn-keeper">Keeper</button>
              <button className="btn btn-reject">Reject</button>
              <button className="btn">Default</button>
            </div>

            <a className="settings-item" href="#" onClick={e => e.preventDefault()} style={{ marginBottom: 16 }}>
              <div>
                <div>Example setting</div>
                <div className="settings-item-desc">A description line, for contrast.</div>
              </div>
              <span style={{ color: 'var(--ink-faint)' }}>&rarr;</span>
            </a>

            <div className="activity-row">
              <div>Promoted &quot;a sample asset&quot;</div>
              <div className="activity-row-meta">just now</div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Run the full test suite, tsc, and eslint**

Run: `npx vitest run && npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: all clean. Pay particular attention to `react/no-unescaped-entities` (the apostrophes in
"GameForge's"/"isn't" and the quote marks around "a sample asset" above already use
`&apos;`/`&quot;` for exactly this reason) and `react-hooks/exhaustive-deps` on the `useEffect` (it has
an empty dependency array and reads no outside state other than `setTokens`'s updater function, which
doesn't need to be listed).

- [ ] **Step 3: Manually verify in a running dev server**

Run: `npm run dev`. Log in, navigate to Settings → Design Preview. Confirm:
- The 16 color rows show real current swatches/hex values (matching `globals.css`), the radius field
  shows `7`, and the 3 font dropdowns show Sentient/Satoshi/IBM Plex Mono respectively (the real
  current assignment).
- Dragging any color picker updates both its own hex text field and the mockup panel live, immediately.
- Typing a new hex value into a text field and pressing Tab/Enter (to blur) updates that field's color
  picker and the mockup; typing an incomplete/invalid hex and blurring leaves the previous valid color
  in place (the picker/mockup don't flash to black).
- Changing the radius field reshapes the mockup's card/button corners live.
- Changing a font dropdown changes the corresponding text in the mockup live (e.g. switching Body to
  "IBM Plex Mono" makes the mockup's paragraph text monospace).
- Clicking "Copy CSS" shows "Copied!" briefly; pasting the clipboard contents somewhere shows a
  `:root { ... }` block with all 20 tokens in the documented order.
- The rest of the real dashboard (the actual sidebar, the actual page chrome outside the mockup panel)
  is completely unaffected by any of the above edits.

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/settings/design-preview/page.tsx
git commit -m "feat: add the dashboard design-preview page"
```
