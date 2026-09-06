# Seed Theme Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single "Import Seed Themes" button that pulls ~58 ready-made themes from DaisyUI (32 themes) and Bootswatch (26 themes) and lands each as an already-active Style Bible + theme asset pair, with zero AI generation cost.

**Architecture:** Two independent source mappers (`daisyUiMapper.ts`, `bootswatchMapper.ts`) each turn one external, public, unauthenticated data source into `ThemeTokens` objects that pass through the existing, unmodified `ThemeTokensSchema`. DaisyUI's colors are bare OKLCh triples and need a new, from-scratch OKLCH→sRGB-hex conversion (`oklch.ts`) — the one genuinely new piece of correctness-critical math in this feature. Bootswatch's compiled CSS is already plain hex/rem, no conversion needed. A thin orchestrator (`SeedThemeImporter.ts`) calls both mappers, checks name-based idempotency against existing Style Bibles, and creates a Style Bible + asset pair per new theme via the existing `StyleService`/`AssetService`. A Settings-page button triggers it through one new API route.

**Tech Stack:** Next.js API route (existing pattern), Vitest (existing pattern: temp SQLite via `setProjectRootForTests`, `fetch` mocked via `vi.stubGlobal`), Zod (existing `ThemeTokensSchema`, unmodified).

**Spec:** `docs/superpowers/specs/2026-09-06-seed-theme-library-design.md`

## Global Constraints

- No new database tables or columns — reuse `styles`/`assets` exactly as they exist today.
- Reuse `ThemeTokensSchema.parse()`/`tokensToCss()` from `lib/services/ThemeGenerator.ts` **unmodified** — every mapped theme must pass through them exactly as AI-generated themes do.
- Style Bible naming is exactly `"DaisyUI: <ThemeName>"` or `"Bootswatch: <ThemeName>"` — this is both the attribution string and the idempotency key (checked verbatim before creating).
- `created_by` on both the seeded `styles` and `assets` rows is the fixed constant `'system-seed'`.
- Seed assets are inserted already active: `is_deleted = 0`, no corresponding `jobs` row (they are not AI output — nothing to review or promote).
- One Style Bible + one asset per seed theme — never grouped under one shared Style Bible.
- `spaceUnit` is always `'8px'` for every seed theme (neither source defines a per-theme spacing scale).
- No new secrets or API keys — both fetch targets (`unpkg.com`, `bootswatch.com`) are public and unauthenticated.
- A fetch failure on one source must not block the other source's import (per-source isolation).
- A single theme failing `ThemeTokensSchema` validation is skipped and logged — it must never abort the whole batch.
- Out of scope (do not build): raw color-scale sources (Tailwind/Open Color/Radix), custom/generated seed themes, a background job watching upstream for new themes, a UI for browsing/filtering the two sources separately before import.

---

## Context for the implementer

This codebase forbids wrapper classes, factory patterns, DTOs, and utility libraries (see `AGENTS.md` at the repo root) — write flat, direct, procedural code. Every file write must be wrapped in `try/catch` with `console.error` logging, preceded by `fs.mkdir(dir, { recursive: true })`. All physical paths go through `path.join(getProjectRoot(), ...)`.

The existing `StyleService.create()` signature (`lib/services/StyleService.ts:25`):
```typescript
async create(input: { name: string; createdBy: string; parameters: string; forkedFrom?: string | null }): Promise<Style>
```

The existing `AssetService.create()` signature (`lib/services/AssetService.ts:10`):
```typescript
async create(input: {
  styleId: string;
  createdBy: string;
  assetType: string;
  prompt: string;
  imagePath: string | null;
  sourceJobId?: string | null;
  outputKind?: 'image' | 'theme';
}): Promise<Asset>
```

The existing `ThemeTokensSchema`/`tokensToCss` (`lib/services/ThemeGenerator.ts`) — reused unmodified:
```typescript
export const ThemeTokensSchema = z.object({
  colorBackground: z.string().regex(CSS_COLOR_RE, ...),
  colorForeground: z.string().regex(CSS_COLOR_RE, ...),
  colorAccent: z.string().regex(CSS_COLOR_RE, ...),
  colorBorder: z.string().regex(CSS_COLOR_RE, ...),
  fontHeading: z.string().regex(CSS_FONT_RE, ...),
  fontBody: z.string().regex(CSS_FONT_RE, ...),
  spaceUnit: z.string().regex(CSS_LENGTH_RE, ...),
  radiusBase: z.string().regex(CSS_LENGTH_RE, ...),
});
export type ThemeTokens = z.infer<typeof ThemeTokensSchema>;
export function tokensToCss(tokens: ThemeTokens): string { /* :root { --color-bg: ...; } */ }
```
`CSS_COLOR_RE` accepts `#rgb`/`#rrggbb`/`#rrggbbaa` (3–8 hex digits), `rgb()`/`rgba()`, `hsl()`/`hsla()`, and bare named colors — **not** `oklch()`. `CSS_LENGTH_RE` accepts a 1–3 digit number (optional decimal) followed by `px`, `rem`, or `em`.

**The verified OKLCH→hex math** (this is new to the codebase — no prior color-space conversion exists here). Confirmed against two independent primary sources during planning, not approximated from memory:

1. **OKLCH → Oklab** (polar → Cartesian), from the CSS Color 4 spec's own reference conversion code (`w3c/csswg-drafts` `css-color-4/conversions.js`):
   ```
   a = C * cos(H * π / 180)
   b = C * sin(H * π / 180)
   ```
   (L carries through unchanged; H is in degrees and must be converted to radians.)

2. **Oklab → linear sRGB**, the verbatim reference implementation from Björn Ottosson's own page (`bottosson.github.io/posts/oklab/`), the original author of the OKLab color space:
   ```
   l_ = L + 0.3963377774*a + 0.2158037573*b
   m_ = L - 0.1055613458*a - 0.0638541728*b
   s_ = L - 0.0894841775*a - 1.2914855480*b
   l = l_³,  m = m_³,  s = s_³
   R = +4.0767416621*l - 3.3077115913*m + 0.2309699292*s
   G = -1.2684380046*l + 2.6097574011*m - 0.3413193965*s
   B = -0.0041960863*l - 0.7034186147*m + 1.7076147010*s
   ```
   Note: `R`, `G`, `B` here can be negative or exceed 1 for a chromatic color that's out of the sRGB gamut (very common with real OKLCH design-token values) — this must be clamped to `[0, 1]` before gamma encoding, not after.

3. **Linear sRGB → gamma-encoded sRGB**, also from the CSS Color 4 spec's reference code:
   ```
   if (linear <= 0.0031308) srgb = linear * 12.92
   else                     srgb = 1.055 * linear^(1/2.4) - 0.055
   ```
   Then `byte = round(srgb * 255)`, clamped to `[0, 255]`.

Two properties of this pipeline are **algebraically provable**, not just empirically observed, and anchor the test suite in Task 1:
- At `C = 0` (any hue, any lightness), `a = b = 0`, so `l_ = m_ = s_ = L` exactly, and each of the three output-matrix rows sums to exactly `1.0` (e.g. `4.0767416621 - 3.3077115913 + 0.2309699292 = 1.0000000000`) — meaning **any zero-chroma OKLCH value produces a perfectly neutral R=G=B gray**, for every lightness, not just white/black.
- At `L = 1, C = 0`: linear RGB = `(1,1,1)` exactly → gamma-encoded = `(1,1,1)` → `#ffffff`.
- At `L = 0, C = 0`: linear RGB = `(0,0,0)` exactly → `#000000`.

For a **real, non-trivial cross-check**, DaisyUI's actual `light` theme's `--a` (accent) property is the verbatim value `76.76% 0.184 183.61` (confirmed by direct fetch of `unpkg.com/daisyui@4.9.0/dist/themes.css` during planning). Hand-deriving this through the pipeline above (L=0.7676, C=0.184, H=183.61°) gives a cyan-teal color with a clamped-to-zero red channel (an out-of-gamut case) — approximately `#00d7c0`. **This hand derivation has not been machine-verified** — Task 1 requires the implementer to cross-check it against a live OKLCH→sRGB converter (e.g. `https://oklch.com`, entering `oklch(76.76% 0.184 183.61)`) and use whatever that tool reports as the test's expected value instead, if it disagrees with `#00d7c0`. Do not skip this cross-check — this is the one piece of new math in the whole feature that could silently produce wrong colors.

**Real DaisyUI CSS structure** (confirmed by direct fetch during planning, `unpkg.com/daisyui@4.9.0/dist/themes.css`, v4.9.0): the file contains, for **every one of 32 real theme names**, a rule with selector exactly `[data-theme=<name>]` — e.g. `[data-theme=light]{...}`, `[data-theme=synthwave]{...}`. It ALSO contains, for every one of those same 32 themes, a second, duplicate-content rule with selector `:root:has(input.theme-controller[value=<name>]:checked)` (daisyUI's own `<input>`-based theme-switcher component) — this must be **excluded**, not treated as a second theme. There is also one bare `:root{...}` block (the default, pre-`[data-theme]` fallback) and one `@media (prefers-color-scheme: dark){...}` block — both must also be excluded. **Only match literal `[data-theme=NAME]{...}` selectors.**

The verbatim real `light` and `synthwave` blocks (confirmed by direct fetch, pretty-printed here for readability — the actual distributed file is minified with no whitespace, so the parser must not assume any particular spacing):
```
[data-theme=light] {
    --p: 49.12% 0.3096 275.75;
    --a: 76.76% 0.184 183.61;
    --n: 32.1785% 0.02476 255.701624;
    --b1: 100% 0 0;
    --bc: 27.8078% 0.029596 256.847952;
    --rounded-btn: 0.5rem;
}
[data-theme=synthwave] {
    --a: 88.04% 0.206 93.72;
    --n: 25.5554% 0.103537 286.507967;
    --b1: 21.8216% 0.081948 287.835609;
    --bc: 97.9365% 0.00819 301.358346;
    --rounded-btn: 0.5rem;
}
```

The full list of 32 real DaisyUI v4.9.0 theme names (confirmed by direct fetch — used for Task 2's font-pairing table and Task 3's fixtures): `light, dark, cupcake, bumblebee, emerald, corporate, synthwave, retro, cyberpunk, valentine, halloween, garden, forest, aqua, lofi, pastel, fantasy, wireframe, black, luxury, dracula, cmyk, autumn, business, acid, lemonade, night, coffee, winter, dim, nord, sunset`.

**Real Bootswatch structure** (confirmed by direct fetch during planning): `https://bootswatch.com/api/5.json` returns `{ themes: [{ name: "Flatly", cssMin: "https://bootswatch.com/5/flatly/bootstrap.min.css", ... }, ...] }` — 26 themes total. Each `cssMin` URL serves compiled Bootstrap CSS whose `:root{...}` block contains plain, already-resolved custom properties: `--bs-body-bg`, `--bs-body-color`, `--bs-primary`, `--bs-border-color`, `--bs-border-radius` — confirmed real values from Flatly: `--bs-body-bg: #fff`, `--bs-body-color: #212529`, `--bs-primary: #2c3e50`, `--bs-border-color: #dee2e6`, `--bs-border-radius: 0.375rem`. All already valid against `CSS_COLOR_RE`/`CSS_LENGTH_RE` — no conversion needed for this source.

The full list of 26 real Bootswatch theme names (confirmed by direct fetch — used for Task 2's font-pairing table): `Brite, Cerulean, Cosmo, Cyborg, Darkly, Flatly, Journal, Litera, Lumen, Lux, Materia, Minty, Morph, Pulse, Quartz, Sandstone, Simplex, Sketchy, Slate, Solar, Spacelab, Superhero, United, Vapor, Yeti, Zephyr`.

---

### Task 1: OKLCH → sRGB hex conversion

**Files:**
- Create: `lib/services/seedThemes/types.ts`
- Create: `lib/services/seedThemes/oklch.ts`
- Test: `test/oklch.test.ts`

**Interfaces:**
- Consumes: nothing (pure math, no dependencies on other tasks).
- Produces: `oklchToHex(lightnessPercent: number, chroma: number, hueDegrees: number): string` and `parseOklchTriple(value: string): [number, number, number]` from `lib/services/seedThemes/oklch.ts`; `export interface SeedTheme { name: string; tokens: ThemeTokens }` from `lib/services/seedThemes/types.ts`. Tasks 3, 4, and 5 import these.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/oklch.test.ts
import { describe, it, expect } from 'vitest';
import { oklchToHex, parseOklchTriple } from '@/lib/services/seedThemes/oklch';

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

describe('oklchToHex', () => {
  it('converts OKLCH white (L=100%, C=0) to pure white', () => {
    expect(oklchToHex(100, 0, 0)).toBe('#ffffff');
  });

  it('converts OKLCH black (L=0%, C=0) to pure black', () => {
    expect(oklchToHex(0, 0, 0)).toBe('#000000');
  });

  it('produces a neutral R=G=B gray for any zero-chroma value, regardless of hue', () => {
    const [r1, g1, b1] = hexToRgb(oklchToHex(50, 0, 0));
    expect(r1).toBe(g1);
    expect(g1).toBe(b1);

    const [r2, g2, b2] = hexToRgb(oklchToHex(50, 0, 271));
    expect(r2).toBe(g2);
    expect(g2).toBe(b2);
    // Hue is irrelevant when chroma is 0 — same lightness must produce the same gray.
    expect(r1).toBe(r2);
  });

  it('converts a real DaisyUI OKLCH value (light theme accent) to a plausible cyan-teal hex', () => {
    // L=76.76%, C=0.184, H=183.61 — DaisyUI v4.9.0 light theme's --a (accent).
    // Hand-derived expected value; cross-checked against https://oklch.com during
    // implementation (entering oklch(76.76% 0.184 183.61)) — replace this literal
    // if that check disagrees. Out-of-gamut clamping (negative linear R) is expected here.
    const hex = oklchToHex(76.76, 0.184, 183.61);
    const [r, g, b] = hexToRgb(hex);
    expect(r).toBe(0); // clamped — out of sRGB gamut on the red channel
    expect(g).toBeGreaterThan(180);
    expect(b).toBeGreaterThan(150);
  });

  it('clamps out-of-gamut linear values instead of producing invalid output', () => {
    // High chroma at a mid lightness routinely goes out of gamut on at least one channel.
    const hex = oklchToHex(50, 0.3, 30);
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('parseOklchTriple', () => {
  it('parses a real DaisyUI-format triple string', () => {
    expect(parseOklchTriple('76.76% 0.184 183.61')).toEqual([76.76, 0.184, 183.61]);
  });

  it('parses a triple with extra internal whitespace', () => {
    expect(parseOklchTriple('32.1785%   0.02476  255.701624')).toEqual([32.1785, 0.02476, 255.701624]);
  });

  it('throws on a malformed triple', () => {
    expect(() => parseOklchTriple('not a triple')).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- oklch.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/seedThemes/oklch'`

- [ ] **Step 3: Write the type file**

```typescript
// lib/services/seedThemes/types.ts
import type { ThemeTokens } from '@/lib/services/ThemeGenerator';

export interface SeedTheme {
  name: string;
  tokens: ThemeTokens;
}
```

- [ ] **Step 4: Write the conversion implementation**

```typescript
// lib/services/seedThemes/oklch.ts

// Verified against two independent primary sources (see the plan's Context
// section for the full derivation): OKLCH->Oklab from the CSS Color 4 spec's
// own reference conversions.js, Oklab->linear-sRGB from Bjorn Ottosson's
// canonical oklab.js page, linear-sRGB->sRGB gamma encoding from the CSS
// Color 4 spec. Real OKLCH design-token values routinely fall outside the
// sRGB gamut (a negative or >1 linear channel) — this is expected, not a
// bug, and is clamped rather than rejected.

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function linearChannelToSrgbByte(linear: number): number {
  const clamped = clamp01(linear);
  const encoded = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  return Math.round(clamp01(encoded) * 255);
}

function byteToHexPair(byte: number): string {
  return byte.toString(16).padStart(2, '0');
}

export function oklchToHex(lightnessPercent: number, chroma: number, hueDegrees: number): string {
  const l = lightnessPercent / 100;
  const hueRadians = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hueRadians);
  const b = chroma * Math.sin(hueRadians);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;

  const lCubed = l_ * l_ * l_;
  const mCubed = m_ * m_ * m_;
  const sCubed = s_ * s_ * s_;

  const linearR = 4.0767416621 * lCubed - 3.3077115913 * mCubed + 0.2309699292 * sCubed;
  const linearG = -1.2684380046 * lCubed + 2.6097574011 * mCubed - 0.3413193965 * sCubed;
  const linearB = -0.0041960863 * lCubed - 0.7034186147 * mCubed + 1.7076147010 * sCubed;

  return `#${byteToHexPair(linearChannelToSrgbByte(linearR))}${byteToHexPair(linearChannelToSrgbByte(linearG))}${byteToHexPair(linearChannelToSrgbByte(linearB))}`;
}

/** Parses a DaisyUI-format bare OKLCh triple string, e.g. "76.76% 0.184 183.61". */
export function parseOklchTriple(value: string): [number, number, number] {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 3) {
    throw new Error(`Expected an OKLCH triple "L% C H", got "${value}"`);
  }
  const [lightnessPercent, chroma, hueDegrees] = parts.map(parseFloat);
  if ([lightnessPercent, chroma, hueDegrees].some(Number.isNaN)) {
    throw new Error(`Could not parse OKLCH triple "${value}"`);
  }
  return [lightnessPercent, chroma, hueDegrees];
}
```

- [ ] **Step 5: Cross-check the non-trivial reference value against a live converter**

Before running the tests, open `https://oklch.com`, enter `oklch(76.76% 0.184 183.61)`, and read off its hex output. If it differs from `#00d7c0` (this plan's hand-derived value), update the `toBeGreaterThan` thresholds in the "real DaisyUI OKLCH value" test in Step 1 to match what the tool reports (keep the assertions as tolerant range checks, not exact hex equality, since browser color tools can round slightly differently). Record what the tool actually reported in your task report.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- oklch.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 7: Commit**

```bash
git add lib/services/seedThemes/types.ts lib/services/seedThemes/oklch.ts test/oklch.test.ts
git commit -m "feat: add OKLCH to sRGB hex conversion for seed theme import"
```

---

### Task 2: Font-pairing lookup table

**Files:**
- Create: `lib/services/seedThemes/fontPairings.ts`
- Test: `test/fontPairings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DAISYUI_THEME_NAMES: readonly string[]`, `BOOTSWATCH_THEME_NAMES: readonly string[]`, `interface FontPairing { fontHeading: string; fontBody: string }`, `getFontPairing(themeName: string): FontPairing` — Tasks 3 and 4 call `getFontPairing` and import both name lists for their own fixtures/tests.

- [ ] **Step 1: Write the failing test**

```typescript
// test/fontPairings.test.ts
import { describe, it, expect } from 'vitest';
import { DAISYUI_THEME_NAMES, BOOTSWATCH_THEME_NAMES, getFontPairing } from '@/lib/services/seedThemes/fontPairings';

describe('getFontPairing', () => {
  it('has a font pairing for every real DaisyUI theme name', () => {
    for (const name of DAISYUI_THEME_NAMES) {
      const pairing = getFontPairing(name);
      expect(pairing.fontHeading.length).toBeGreaterThan(0);
      expect(pairing.fontBody.length).toBeGreaterThan(0);
    }
  });

  it('has a font pairing for every real Bootswatch theme name', () => {
    for (const name of BOOTSWATCH_THEME_NAMES) {
      const pairing = getFontPairing(name);
      expect(pairing.fontHeading.length).toBeGreaterThan(0);
      expect(pairing.fontBody.length).toBeGreaterThan(0);
    }
  });

  it('throws a clear error for an unknown theme name', () => {
    expect(() => getFontPairing('not-a-real-theme')).toThrow(/not-a-real-theme/);
  });

  it('lists exactly 32 DaisyUI names and 26 Bootswatch names', () => {
    expect(DAISYUI_THEME_NAMES.length).toBe(32);
    expect(BOOTSWATCH_THEME_NAMES.length).toBe(26);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- fontPairings.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/seedThemes/fontPairings'`

- [ ] **Step 3: Write the implementation**

```typescript
// lib/services/seedThemes/fontPairings.ts

export const DAISYUI_THEME_NAMES = [
  'light', 'dark', 'cupcake', 'bumblebee', 'emerald', 'corporate', 'synthwave', 'retro',
  'cyberpunk', 'valentine', 'halloween', 'garden', 'forest', 'aqua', 'lofi', 'pastel',
  'fantasy', 'wireframe', 'black', 'luxury', 'dracula', 'cmyk', 'autumn', 'business',
  'acid', 'lemonade', 'night', 'coffee', 'winter', 'dim', 'nord', 'sunset',
] as const;

export const BOOTSWATCH_THEME_NAMES = [
  'Brite', 'Cerulean', 'Cosmo', 'Cyborg', 'Darkly', 'Flatly', 'Journal', 'Litera', 'Lumen',
  'Lux', 'Materia', 'Minty', 'Morph', 'Pulse', 'Quartz', 'Sandstone', 'Simplex', 'Sketchy',
  'Slate', 'Solar', 'Spacelab', 'Superhero', 'United', 'Vapor', 'Yeti', 'Zephyr',
] as const;

export interface FontPairing {
  fontHeading: string;
  fontBody: string;
}

const INTER: FontPairing = { fontHeading: "'Inter', sans-serif", fontBody: "'Inter', sans-serif" };
const ROUNDED_PLAYFUL: FontPairing = { fontHeading: "'Baloo 2', sans-serif", fontBody: "'Nunito', sans-serif" };
const ELEGANT_SERIF: FontPairing = { fontHeading: "'Playfair Display', serif", fontBody: "'Lora', serif" };
const NEON_TECH: FontPairing = { fontHeading: "'Orbitron', sans-serif", fontBody: "'Rajdhani', sans-serif" };
const FORMAL_SANS: FontPairing = { fontHeading: "'Source Sans Pro', sans-serif", fontBody: "'Source Sans Pro', sans-serif" };
const EARTHY_SERIF: FontPairing = { fontHeading: "'Merriweather', serif", fontBody: "'Lora', serif" };
const NATURE_SANS: FontPairing = { fontHeading: "'Poppins', sans-serif", fontBody: "'Karla', sans-serif" };
const VINTAGE_MONO: FontPairing = { fontHeading: "'Special Elite', cursive", fontBody: "'Courier New', monospace" };
const LUXURY_SERIF: FontPairing = { fontHeading: "'Cormorant Garamond', serif", fontBody: "'EB Garamond', serif" };
const GOTHIC_SERIF: FontPairing = { fontHeading: "'Cinzel', serif", fontBody: "'EB Garamond', serif" };
const LOUD_DISPLAY: FontPairing = { fontHeading: "'Bungee', cursive", fontBody: "'Share Tech Mono', monospace" };
const EDITORIAL_SERIF: FontPairing = { fontHeading: "'Merriweather', serif", fontBody: "'PT Serif', serif" };
const MATERIAL_SANS: FontPairing = { fontHeading: "'Roboto', sans-serif", fontBody: "'Roboto', sans-serif" };
const CLEAN_LATO: FontPairing = { fontHeading: "'Lato', sans-serif", fontBody: "'Lato', sans-serif" };
const HAND_DRAWN: FontPairing = { fontHeading: "'Neucha', cursive", fontBody: "'Architects Daughter', cursive" };
const BOLD_DARK: FontPairing = { fontHeading: "'Oswald', sans-serif", fontBody: "'Roboto', sans-serif" };
const BRANDED_UBUNTU: FontPairing = { fontHeading: "'Ubuntu', sans-serif", fontBody: "'Ubuntu', sans-serif" };

const FONT_PAIRINGS: Record<string, FontPairing> = {
  // DaisyUI (32)
  light: INTER,
  dark: INTER,
  cupcake: ROUNDED_PLAYFUL,
  bumblebee: ROUNDED_PLAYFUL,
  emerald: NATURE_SANS,
  corporate: FORMAL_SANS,
  synthwave: NEON_TECH,
  retro: VINTAGE_MONO,
  cyberpunk: { fontHeading: "'Rajdhani', sans-serif", fontBody: "'Share Tech Mono', monospace" },
  valentine: ELEGANT_SERIF,
  halloween: { fontHeading: "'Creepster', cursive", fontBody: "'Special Elite', cursive" },
  garden: { fontHeading: "'Quicksand', sans-serif", fontBody: "'Karla', sans-serif" },
  forest: EARTHY_SERIF,
  aqua: NATURE_SANS,
  lofi: INTER,
  pastel: ROUNDED_PLAYFUL,
  fantasy: { fontHeading: "'Cinzel Decorative', serif", fontBody: "'EB Garamond', serif" },
  wireframe: { fontHeading: "'Courier New', monospace", fontBody: "'Courier New', monospace" },
  black: INTER,
  luxury: LUXURY_SERIF,
  dracula: GOTHIC_SERIF,
  cmyk: { fontHeading: "'Bebas Neue', sans-serif", fontBody: "'Roboto Condensed', sans-serif" },
  autumn: EARTHY_SERIF,
  business: FORMAL_SANS,
  acid: LOUD_DISPLAY,
  lemonade: ROUNDED_PLAYFUL,
  night: NEON_TECH,
  coffee: EARTHY_SERIF,
  winter: INTER,
  dim: INTER,
  nord: NATURE_SANS,
  sunset: ROUNDED_PLAYFUL,
  // Bootswatch (26)
  Brite: NATURE_SANS,
  Cerulean: FORMAL_SANS,
  Cosmo: FORMAL_SANS,
  Cyborg: { fontHeading: "'Rajdhani', sans-serif", fontBody: "'Share Tech Mono', monospace" },
  Darkly: INTER,
  Flatly: CLEAN_LATO,
  Journal: EDITORIAL_SERIF,
  Litera: EDITORIAL_SERIF,
  Lumen: FORMAL_SANS,
  Lux: { fontHeading: "'Playfair Display', serif", fontBody: "'Lato', sans-serif" },
  Materia: MATERIAL_SANS,
  Minty: NATURE_SANS,
  Morph: NATURE_SANS,
  Pulse: NATURE_SANS,
  Quartz: NATURE_SANS,
  Sandstone: CLEAN_LATO,
  Simplex: FORMAL_SANS,
  Sketchy: HAND_DRAWN,
  Slate: FORMAL_SANS,
  Solar: EDITORIAL_SERIF,
  Spacelab: MATERIAL_SANS,
  Superhero: BOLD_DARK,
  United: BRANDED_UBUNTU,
  Vapor: NEON_TECH,
  Yeti: FORMAL_SANS,
  Zephyr: NATURE_SANS,
};

export function getFontPairing(themeName: string): FontPairing {
  const pairing = FONT_PAIRINGS[themeName];
  if (!pairing) {
    throw new Error(`No font pairing defined for theme "${themeName}" — add one to FONT_PAIRINGS in lib/services/seedThemes/fontPairings.ts.`);
  }
  return pairing;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- fontPairings.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/services/seedThemes/fontPairings.ts test/fontPairings.test.ts
git commit -m "feat: add font-pairing table for seed themes"
```

---

### Task 3: DaisyUI mapper

**Files:**
- Create: `lib/services/seedThemes/daisyUiMapper.ts`
- Test: `test/daisyUiMapper.test.ts`

**Interfaces:**
- Consumes: `oklchToHex`, `parseOklchTriple` from `lib/services/seedThemes/oklch.ts` (Task 1); `SeedTheme` from `lib/services/seedThemes/types.ts` (Task 1); `getFontPairing` from `lib/services/seedThemes/fontPairings.ts` (Task 2); `ThemeTokensSchema` from `lib/services/ThemeGenerator.ts` (existing).
- Produces: `parseDaisyUiThemes(css: string): SeedTheme[]` (pure, testable without network) and `fetchDaisyUiThemes(): Promise<SeedTheme[]>` (network wrapper) — Task 5 calls `fetchDaisyUiThemes`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/daisyUiMapper.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseDaisyUiThemes, fetchDaisyUiThemes } from '@/lib/services/seedThemes/daisyUiMapper';
import { oklchToHex } from '@/lib/services/seedThemes/oklch';
import { getFontPairing } from '@/lib/services/seedThemes/fontPairings';

// Real, verbatim DaisyUI v4.9.0 property values (confirmed by direct fetch during
// planning) for the `light` and `synthwave` themes, condensed to only the
// properties this mapper reads, and minified (matching the real distributed
// file's format — no whitespace between declarations).
const REAL_LIGHT_BLOCK = '--p:49.12% 0.3096 275.75;--a:76.76% 0.184 183.61;--n:32.1785% 0.02476 255.701624;--b1:100% 0 0;--bc:27.8078% 0.029596 256.847952;--rounded-btn:0.5rem';
const REAL_SYNTHWAVE_BLOCK = '--a:88.04% 0.206 93.72;--n:25.5554% 0.103537 286.507967;--b1:21.8216% 0.081948 287.835609;--bc:97.9365% 0.00819 301.358346;--rounded-btn:0.5rem';

const FIXTURE_CSS = [
  `:root{--rounded-btn:0.5rem}`,
  `@media (prefers-color-scheme: dark){:root{--b1:0% 0 0}}`,
  `[data-theme=light]{color-scheme:light;${REAL_LIGHT_BLOCK}}`,
  `:root:has(input.theme-controller[value=light]:checked){color-scheme:light;${REAL_LIGHT_BLOCK}}`,
  `[data-theme=synthwave]{color-scheme:dark;${REAL_SYNTHWAVE_BLOCK}}`,
  `:root:has(input.theme-controller[value=synthwave]:checked){color-scheme:dark;${REAL_SYNTHWAVE_BLOCK}}`,
].join('\n');

const FIXTURE_WITH_MISSING_PROPERTY = FIXTURE_CSS + `\n[data-theme=broken]{color-scheme:light;--a:50% 0.1 0;--rounded-btn:0.5rem}`;

describe('parseDaisyUiThemes', () => {
  it('extracts exactly the two real named themes, excluding :root, @media, and :has() duplicates', () => {
    const themes = parseDaisyUiThemes(FIXTURE_CSS);
    expect(themes.map(t => t.name).sort()).toEqual(['light', 'synthwave']);
  });

  it('maps --b1/--bc/--a/--n through the OKLCH conversion and --rounded-btn through unconverted', () => {
    const themes = parseDaisyUiThemes(FIXTURE_CSS);
    const light = themes.find(t => t.name === 'light')!;

    expect(light.tokens.colorBackground).toBe(oklchToHex(100, 0, 0));
    expect(light.tokens.colorForeground).toBe(oklchToHex(27.8078, 0.029596, 256.847952));
    expect(light.tokens.colorAccent).toBe(oklchToHex(76.76, 0.184, 183.61));
    expect(light.tokens.colorBorder).toBe(oklchToHex(32.1785, 0.02476, 255.701624));
    expect(light.tokens.radiusBase).toBe('0.5rem');
  });

  it('assigns the font pairing and fixed space unit for each theme', () => {
    const themes = parseDaisyUiThemes(FIXTURE_CSS);
    const light = themes.find(t => t.name === 'light')!;
    expect(light.tokens.fontHeading).toBe(getFontPairing('light').fontHeading);
    expect(light.tokens.fontBody).toBe(getFontPairing('light').fontBody);
    expect(light.tokens.spaceUnit).toBe('8px');
  });

  it('skips a theme block missing a required property, without dropping the others', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const themes = parseDaisyUiThemes(FIXTURE_WITH_MISSING_PROPERTY);
    expect(themes.map(t => t.name).sort()).toEqual(['light', 'synthwave']);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('broken'));
    consoleErrorSpy.mockRestore();
  });
});

describe('fetchDaisyUiThemes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the real DaisyUI CSS URL and parses the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(FIXTURE_CSS, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const themes = await fetchDaisyUiThemes();

    expect(fetchMock).toHaveBeenCalledWith('https://unpkg.com/daisyui@4.9.0/dist/themes.css');
    expect(themes.map(t => t.name).sort()).toEqual(['light', 'synthwave']);
  });

  it('throws a clear error when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503, statusText: 'Service Unavailable' })));
    await expect(fetchDaisyUiThemes()).rejects.toThrow(/503/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- daisyUiMapper.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/seedThemes/daisyUiMapper'`

- [ ] **Step 3: Write the implementation**

```typescript
// lib/services/seedThemes/daisyUiMapper.ts
import { ThemeTokensSchema } from '@/lib/services/ThemeGenerator';
import { oklchToHex, parseOklchTriple } from '@/lib/services/seedThemes/oklch';
import { getFontPairing } from '@/lib/services/seedThemes/fontPairings';
import type { SeedTheme } from '@/lib/services/seedThemes/types';

const DAISYUI_THEMES_URL = 'https://unpkg.com/daisyui@4.9.0/dist/themes.css';

function extractThemeBlocks(css: string): Map<string, string> {
  const blocks = new Map<string, string>();
  // Matches only a literal `[data-theme=NAME]{...}` selector — deliberately
  // does NOT match daisyUI's duplicate `:root:has(input.theme-controller...)`
  // switcher-component blocks, nor the bare `:root`/`@media` default blocks,
  // since none of those contain the literal "[data-theme=" substring.
  const ruleRe = /\[data-theme=([a-zA-Z0-9_-]+)\]\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRe.exec(css)) !== null) {
    blocks.set(match[1], match[2]);
  }
  return blocks;
}

function extractCustomProperty(block: string, propName: string): string | null {
  const re = new RegExp(`${propName}:\\s*([^;]+);?`);
  const match = block.match(re);
  return match ? match[1].trim() : null;
}

function oklchPropertyToHex(block: string, propName: string): string | null {
  const raw = extractCustomProperty(block, propName);
  if (!raw) return null;
  const [l, c, h] = parseOklchTriple(raw);
  return oklchToHex(l, c, h);
}

export function parseDaisyUiThemes(css: string): SeedTheme[] {
  const blocks = extractThemeBlocks(css);
  const themes: SeedTheme[] = [];

  for (const [name, block] of blocks) {
    const colorBackground = oklchPropertyToHex(block, '--b1');
    const colorForeground = oklchPropertyToHex(block, '--bc');
    const colorAccent = oklchPropertyToHex(block, '--a');
    const colorBorder = oklchPropertyToHex(block, '--n');
    const radiusBase = extractCustomProperty(block, '--rounded-btn');

    if (!colorBackground || !colorForeground || !colorAccent || !colorBorder || !radiusBase) {
      console.error(`Skipping DaisyUI theme "${name}": missing one or more required custom properties (--b1/--bc/--a/--n/--rounded-btn).`);
      continue;
    }

    const { fontHeading, fontBody } = getFontPairing(name);
    const parsed = ThemeTokensSchema.safeParse({
      colorBackground, colorForeground, colorAccent, colorBorder,
      fontHeading, fontBody, spaceUnit: '8px', radiusBase,
    });
    if (!parsed.success) {
      console.error(`Skipping DaisyUI theme "${name}": failed ThemeTokensSchema validation — ${parsed.error.message}`);
      continue;
    }

    themes.push({ name, tokens: parsed.data });
  }

  return themes;
}

export async function fetchDaisyUiThemes(): Promise<SeedTheme[]> {
  const res = await fetch(DAISYUI_THEMES_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch DaisyUI themes.css (${res.status}): ${res.statusText}`);
  }
  const css = await res.text();
  return parseDaisyUiThemes(css);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- daisyUiMapper.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/services/seedThemes/daisyUiMapper.ts test/daisyUiMapper.test.ts
git commit -m "feat: add DaisyUI theme CSS mapper"
```

---

### Task 4: Bootswatch mapper

**Files:**
- Create: `lib/services/seedThemes/bootswatchMapper.ts`
- Test: `test/bootswatchMapper.test.ts`

**Interfaces:**
- Consumes: `SeedTheme` from `lib/services/seedThemes/types.ts` (Task 1); `getFontPairing` from `lib/services/seedThemes/fontPairings.ts` (Task 2); `ThemeTokensSchema` from `lib/services/ThemeGenerator.ts` (existing).
- Produces: `parseBootswatchTheme(name: string, compiledCss: string): SeedTheme | null` (pure) and `fetchBootswatchThemes(): Promise<SeedTheme[]>` (network wrapper) — Task 5 calls `fetchBootswatchThemes`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/bootswatchMapper.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseBootswatchTheme, fetchBootswatchThemes } from '@/lib/services/seedThemes/bootswatchMapper';
import { getFontPairing } from '@/lib/services/seedThemes/fontPairings';

// Real, confirmed compiled-CSS values for Bootswatch's Flatly theme (confirmed
// by direct fetch of its cssMin URL during planning), condensed to only the
// custom properties this mapper reads.
const FLATLY_ROOT_CSS = ':root{--bs-blue:#0d6efd;--bs-body-bg:#fff;--bs-body-color:#212529;--bs-primary:#2c3e50;--bs-border-color:#dee2e6;--bs-border-radius:0.375rem}';

describe('parseBootswatchTheme', () => {
  it('maps the real Bootswatch custom properties directly (no color conversion needed)', () => {
    const theme = parseBootswatchTheme('Flatly', FLATLY_ROOT_CSS);
    expect(theme).not.toBeNull();
    expect(theme!.tokens.colorBackground).toBe('#fff');
    expect(theme!.tokens.colorForeground).toBe('#212529');
    expect(theme!.tokens.colorAccent).toBe('#2c3e50');
    expect(theme!.tokens.colorBorder).toBe('#dee2e6');
    expect(theme!.tokens.radiusBase).toBe('0.375rem');
  });

  it('assigns the font pairing and fixed space unit', () => {
    const theme = parseBootswatchTheme('Flatly', FLATLY_ROOT_CSS)!;
    expect(theme.tokens.fontHeading).toBe(getFontPairing('Flatly').fontHeading);
    expect(theme.tokens.fontBody).toBe(getFontPairing('Flatly').fontBody);
    expect(theme.tokens.spaceUnit).toBe('8px');
  });

  it('returns null and logs when a required property is missing', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const theme = parseBootswatchTheme('Broken', ':root{--bs-body-bg:#fff}');
    expect(theme).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Broken'));
    consoleErrorSpy.mockRestore();
  });
});

describe('fetchBootswatchThemes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the API list then each theme\'s compiled CSS', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://bootswatch.com/api/5.json') {
        return new Response(JSON.stringify({
          themes: [{ name: 'Flatly', cssMin: 'https://bootswatch.com/5/flatly/bootstrap.min.css' }],
        }), { status: 200 });
      }
      if (url === 'https://bootswatch.com/5/flatly/bootstrap.min.css') {
        return new Response(FLATLY_ROOT_CSS, { status: 200 });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const themes = await fetchBootswatchThemes();

    expect(themes).toHaveLength(1);
    expect(themes[0].name).toBe('Flatly');
    expect(themes[0].tokens.colorBackground).toBe('#fff');
  });

  it('throws a clear error when the API list fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500, statusText: 'Internal Server Error' })));
    await expect(fetchBootswatchThemes()).rejects.toThrow(/500/);
  });

  it('skips one theme whose compiled-CSS fetch fails, without aborting the batch', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://bootswatch.com/api/5.json') {
        return new Response(JSON.stringify({
          themes: [
            { name: 'Flatly', cssMin: 'https://bootswatch.com/5/flatly/bootstrap.min.css' },
            { name: 'BrokenTheme', cssMin: 'https://bootswatch.com/5/broken/bootstrap.min.css' },
          ],
        }), { status: 200 });
      }
      if (url === 'https://bootswatch.com/5/flatly/bootstrap.min.css') {
        return new Response(FLATLY_ROOT_CSS, { status: 200 });
      }
      if (url === 'https://bootswatch.com/5/broken/bootstrap.min.css') {
        return new Response('', { status: 404, statusText: 'Not Found' });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const themes = await fetchBootswatchThemes();

    expect(themes.map(t => t.name)).toEqual(['Flatly']);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('BrokenTheme'));
    consoleErrorSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- bootswatchMapper.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/seedThemes/bootswatchMapper'`

- [ ] **Step 3: Write the implementation**

```typescript
// lib/services/seedThemes/bootswatchMapper.ts
import { ThemeTokensSchema } from '@/lib/services/ThemeGenerator';
import { getFontPairing } from '@/lib/services/seedThemes/fontPairings';
import type { SeedTheme } from '@/lib/services/seedThemes/types';

const BOOTSWATCH_API_URL = 'https://bootswatch.com/api/5.json';

interface BootswatchApiResponse {
  themes: Array<{ name: string; cssMin: string }>;
}

function extractRootCustomProperty(css: string, propName: string): string | null {
  const rootMatch = css.match(/:root\s*\{([^}]*)\}/);
  if (!rootMatch) return null;
  const re = new RegExp(`${propName}:\\s*([^;]+);?`);
  const propMatch = rootMatch[1].match(re);
  return propMatch ? propMatch[1].trim() : null;
}

export function parseBootswatchTheme(name: string, compiledCss: string): SeedTheme | null {
  const colorBackground = extractRootCustomProperty(compiledCss, '--bs-body-bg');
  const colorForeground = extractRootCustomProperty(compiledCss, '--bs-body-color');
  const colorAccent = extractRootCustomProperty(compiledCss, '--bs-primary');
  const colorBorder = extractRootCustomProperty(compiledCss, '--bs-border-color');
  const radiusBase = extractRootCustomProperty(compiledCss, '--bs-border-radius');

  if (!colorBackground || !colorForeground || !colorAccent || !colorBorder || !radiusBase) {
    console.error(`Skipping Bootswatch theme "${name}": missing one or more required custom properties (--bs-body-bg/--bs-body-color/--bs-primary/--bs-border-color/--bs-border-radius).`);
    return null;
  }

  const { fontHeading, fontBody } = getFontPairing(name);
  const parsed = ThemeTokensSchema.safeParse({
    colorBackground, colorForeground, colorAccent, colorBorder,
    fontHeading, fontBody, spaceUnit: '8px', radiusBase,
  });
  if (!parsed.success) {
    console.error(`Skipping Bootswatch theme "${name}": failed ThemeTokensSchema validation — ${parsed.error.message}`);
    return null;
  }

  return { name, tokens: parsed.data };
}

export async function fetchBootswatchThemes(): Promise<SeedTheme[]> {
  const apiRes = await fetch(BOOTSWATCH_API_URL);
  if (!apiRes.ok) {
    throw new Error(`Failed to fetch Bootswatch theme list (${apiRes.status}): ${apiRes.statusText}`);
  }
  const apiData = (await apiRes.json()) as BootswatchApiResponse;

  const themes: SeedTheme[] = [];
  for (const { name, cssMin } of apiData.themes) {
    const cssRes = await fetch(cssMin);
    if (!cssRes.ok) {
      console.error(`Skipping Bootswatch theme "${name}": failed to fetch compiled CSS (${cssRes.status}).`);
      continue;
    }
    const css = await cssRes.text();
    const theme = parseBootswatchTheme(name, css);
    if (theme) themes.push(theme);
  }
  return themes;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- bootswatchMapper.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/services/seedThemes/bootswatchMapper.ts test/bootswatchMapper.test.ts
git commit -m "feat: add Bootswatch theme mapper"
```

---

### Task 5: SeedThemeImporter orchestrator

**Files:**
- Create: `lib/services/SeedThemeImporter.ts`
- Test: `test/seedThemeImporter.test.ts`

**Interfaces:**
- Consumes: `fetchDaisyUiThemes` (Task 3), `fetchBootswatchThemes` (Task 4), `SeedTheme` (Task 1), existing `styleService`/`assetService`/`tokensToCss`/`getProjectRoot`.
- Produces: `importSeedThemes(): Promise<SeedImportResult>` where `interface SeedImportResult { imported: number; skipped: number; errors: string[] }` — Task 6's API route calls this directly.

- [ ] **Step 1: Write the failing test**

```typescript
// test/seedThemeImporter.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { importSeedThemes } from '@/lib/services/SeedThemeImporter';

let tempRoot: string;

const DAISYUI_CSS = '[data-theme=light]{color-scheme:light;--a:76.76% 0.184 183.61;--n:32.1785% 0.02476 255.701624;--b1:100% 0 0;--bc:27.8078% 0.029596 256.847952;--rounded-btn:0.5rem}';
const BOOTSWATCH_API_JSON = JSON.stringify({
  themes: [{ name: 'Flatly', cssMin: 'https://bootswatch.com/5/flatly/bootstrap.min.css' }],
});
const FLATLY_CSS = ':root{--bs-body-bg:#fff;--bs-body-color:#212529;--bs-primary:#2c3e50;--bs-border-color:#dee2e6;--bs-border-radius:0.375rem}';

function stubFetchWithBothSources() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === 'https://unpkg.com/daisyui@4.9.0/dist/themes.css') return new Response(DAISYUI_CSS, { status: 200 });
    if (url === 'https://bootswatch.com/api/5.json') return new Response(BOOTSWATCH_API_JSON, { status: 200 });
    if (url === 'https://bootswatch.com/5/flatly/bootstrap.min.css') return new Response(FLATLY_CSS, { status: 200 });
    throw new Error(`Unexpected fetch to ${url}`);
  }));
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-seedtheme-'));
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
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  vi.unstubAllGlobals();
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('importSeedThemes', () => {
  it('creates a Style Bible + theme asset for each theme from both sources', async () => {
    stubFetchWithBothSources();

    const result = await importSeedThemes();

    expect(result).toEqual({ imported: 2, skipped: 0, errors: [] });

    const styles = await styleService.getAll();
    const names = styles.map(s => s.name).sort();
    expect(names).toEqual(['Bootswatch: Flatly', 'DaisyUI: light']);
    for (const style of styles) {
      expect(style.created_by).toBe('system-seed');
    }

    const assets = await assetService.getAll();
    expect(assets).toHaveLength(2);
    for (const asset of assets) {
      expect(asset.output_kind).toBe('theme');
      expect(asset.created_by).toBe('system-seed');
      expect(asset.is_deleted).toBe(0);
    }
  });

  it('is idempotent — a second run imports nothing new', async () => {
    stubFetchWithBothSources();
    await importSeedThemes();

    stubFetchWithBothSources();
    const secondResult = await importSeedThemes();

    expect(secondResult).toEqual({ imported: 0, skipped: 2, errors: [] });
    const styles = await styleService.getAll();
    expect(styles).toHaveLength(2);
  });

  it('isolates a DaisyUI fetch failure — Bootswatch still imports', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://unpkg.com/daisyui@4.9.0/dist/themes.css') return new Response('', { status: 503, statusText: 'Service Unavailable' });
      if (url === 'https://bootswatch.com/api/5.json') return new Response(BOOTSWATCH_API_JSON, { status: 200 });
      if (url === 'https://bootswatch.com/5/flatly/bootstrap.min.css') return new Response(FLATLY_CSS, { status: 200 });
      throw new Error(`Unexpected fetch to ${url}`);
    }));

    const result = await importSeedThemes();

    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/DaisyUI/);
    const styles = await styleService.getAll();
    expect(styles.map(s => s.name)).toEqual(['Bootswatch: Flatly']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- seedThemeImporter.test.ts`
Expected: FAIL — `Cannot find module '@/lib/services/SeedThemeImporter'`

- [ ] **Step 3: Write the implementation**

```typescript
// lib/services/SeedThemeImporter.ts
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { tokensToCss } from '@/lib/services/ThemeGenerator';
import { fetchDaisyUiThemes } from '@/lib/services/seedThemes/daisyUiMapper';
import { fetchBootswatchThemes } from '@/lib/services/seedThemes/bootswatchMapper';
import type { SeedTheme } from '@/lib/services/seedThemes/types';

const SEED_CREATED_BY = 'system-seed';

export interface SeedImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

async function createSeedTheme(styleName: string, theme: SeedTheme): Promise<void> {
  const style = await styleService.create({
    name: styleName,
    createdBy: SEED_CREATED_BY,
    parameters: JSON.stringify(theme.tokens),
  });

  const filename = `seed-${crypto.randomUUID()}.css`;
  const themesDir = path.join(getProjectRoot(), 'storage', 'themes');
  try {
    await fsPromises.mkdir(themesDir, { recursive: true });
    await fsPromises.writeFile(path.join(themesDir, filename), tokensToCss(theme.tokens));
  } catch (e) {
    console.error(`Failed to write seed theme file ${filename}:`, e);
    throw e;
  }

  await assetService.create({
    styleId: style.id,
    createdBy: SEED_CREATED_BY,
    assetType: 'theme',
    prompt: `Seeded from ${styleName}`,
    imagePath: filename,
    outputKind: 'theme',
  });
}

async function importFromSource(
  attributionPrefix: string,
  fetchThemes: () => Promise<SeedTheme[]>,
  existingNames: Set<string>,
  errors: string[]
): Promise<{ imported: number; skipped: number }> {
  let themes: SeedTheme[];
  try {
    themes = await fetchThemes();
  } catch (e: any) {
    errors.push(`${attributionPrefix}: ${e.message}`);
    return { imported: 0, skipped: 0 };
  }

  let imported = 0;
  let skipped = 0;
  for (const theme of themes) {
    const styleName = `${attributionPrefix}: ${theme.name}`;
    if (existingNames.has(styleName)) {
      skipped++;
      continue;
    }
    await createSeedTheme(styleName, theme);
    existingNames.add(styleName);
    imported++;
  }
  return { imported, skipped };
}

export async function importSeedThemes(): Promise<SeedImportResult> {
  const existingStyles = await styleService.getAll();
  const existingNames = new Set(existingStyles.map(s => s.name));
  const errors: string[] = [];

  const daisyResult = await importFromSource('DaisyUI', fetchDaisyUiThemes, existingNames, errors);
  const bootswatchResult = await importFromSource('Bootswatch', fetchBootswatchThemes, existingNames, errors);

  return {
    imported: daisyResult.imported + bootswatchResult.imported,
    skipped: daisyResult.skipped + bootswatchResult.skipped,
    errors,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- seedThemeImporter.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/services/SeedThemeImporter.ts test/seedThemeImporter.test.ts
git commit -m "feat: add SeedThemeImporter orchestrator with idempotent import"
```

---

### Task 6: Settings page, API route, and nav entry

**Files:**
- Create: `app/api/settings/seed-themes/import/route.ts`
- Create: `app/dashboard/settings/seed-themes/page.tsx`
- Modify: `app/components/NavRail.tsx:14-16`

**Interfaces:**
- Consumes: `importSeedThemes` from `lib/services/SeedThemeImporter.ts` (Task 5).
- Produces: nothing consumed by later tasks — this is the final task.

This task has no automated test (matches the existing convention: `app/api/storage/cleanup/route.ts` and its Settings page, `test/cleanupOrphanedImages.test.ts`, test the service function directly and leave the thin route/UI layer manually verified). Verify manually per Step 4 below.

- [ ] **Step 1: Write the API route**

```typescript
// app/api/settings/seed-themes/import/route.ts
import { NextResponse } from 'next/server';
import { importSeedThemes } from '@/lib/services/SeedThemeImporter';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const result = await importSeedThemes();
    return NextResponse.json({ success: true, data: result });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 2: Write the Settings page**

```typescript
// app/dashboard/settings/seed-themes/page.tsx
'use client';

import { useState } from 'react';

export default function SeedThemesSettingsPage() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function handleImport() {
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch('/api/settings/seed-themes/import', { method: 'POST' });
      const body = await res.json();
      if (!body.success) {
        setResult(body.error ?? 'Import failed.');
        return;
      }
      const { imported, skipped, errors } = body.data;
      let message = `Imported ${imported} theme${imported === 1 ? '' : 's'}, skipped ${skipped} already present.`;
      if (errors.length > 0) {
        message += ` Errors: ${errors.join('; ')}`;
      }
      setResult(message);
    } catch {
      setResult('Could not reach the server.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <h1 className="page-title">Seed Themes</h1>
      <p className="page-subtitle">
        Populate your Style Bibles with ~58 ready-made themes pulled from DaisyUI and Bootswatch — real,
        open-source, human-designed color and typography combinations, at zero generation cost. Safe to
        run again later: themes already imported are skipped, never duplicated.
      </p>

      <div className="card" style={{ maxWidth: 480 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Import Seed Themes</div>
        <p style={{ color: 'var(--ink-dim)', fontSize: 13, marginBottom: 16 }}>
          Fetches both sources and creates a Style Bible + theme asset for each one that isn&apos;t already
          in your library.
        </p>
        <button className="btn btn-primary" onClick={handleImport} disabled={running}>
          {running ? 'Importing…' : 'Import Seed Themes'}
        </button>
        {result && <p style={{ marginTop: 14, fontSize: 13, color: 'var(--ink-dim)' }}>{result}</p>}
      </div>
    </>
  );
}
```

- [ ] **Step 3: Add the nav entry**

In `app/components/NavRail.tsx`, find:
```typescript
  { href: '/dashboard/settings/storage', label: 'Storage' },
  { href: '/dashboard/settings/aseprite', label: 'Aseprite' },
];
```
Replace with:
```typescript
  { href: '/dashboard/settings/storage', label: 'Storage' },
  { href: '/dashboard/settings/aseprite', label: 'Aseprite' },
  { href: '/dashboard/settings/seed-themes', label: 'Seed Themes' },
];
```

- [ ] **Step 4: Manually verify the golden path**

1. Run `npm run dev` (or confirm the dev server is already running).
2. Navigate to `/dashboard/settings/seed-themes`.
3. Click "Import Seed Themes" and wait for it to finish (real network calls to `unpkg.com` and `bootswatch.com` — this requires internet access and may take a few seconds for ~58 sequential Bootswatch CSS fetches).
4. Confirm the result message reports a plausible import count (around 58 on a fresh database) with `skipped: 0` and no errors.
5. Navigate to `/dashboard/styles` and confirm Style Bibles named `"DaisyUI: <name>"` and `"Bootswatch: <name>"` now appear.
6. Navigate to `/dashboard/assets` and confirm the corresponding theme assets appear and preview correctly (the existing theme-preview iframe, unchanged by this feature, should render each seeded theme's colors/fonts).
7. Click "Import Seed Themes" a second time and confirm the result reports `imported: 0` and `skipped` equal to the first run's `imported` count — proving idempotency end-to-end, not just in the unit tests.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS (all prior tests plus this feature's new tests, no regressions)

- [ ] **Step 6: Commit**

```bash
git add app/api/settings/seed-themes/import/route.ts app/dashboard/settings/seed-themes/page.tsx app/components/NavRail.tsx
git commit -m "feat: add Import Seed Themes settings page and API route"
```
