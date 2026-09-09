// lib/services/themeTokens.ts
//
// Split out of ThemeGenerator.ts: this file holds only the pure token
// schema/serialization logic, with no Node-only imports (no fs, no
// crypto, no DB service). ThemeGenerator.ts re-exports everything here
// for existing server-side callers, but a 'use client' component (the
// theme edit page) imports directly from this file — importing
// parseThemeCss from ThemeGenerator.ts itself would pull its
// ClaudeApiThemeGenerator -> AssetService -> lib/database ->
// better-sqlite3/fs import chain into the browser bundle and fail to
// compile. Confirmed by actually loading the edit page in a browser,
// not just by reading the import graph.
import { z } from 'zod';

// Deliberately an allowlist grammar per token type, not a full CSS value
// parser — these values are interpolated directly into a real CSS file
// that renders in a browser (see tokensToCss below), so ".min(1)" alone
// would let a value close the custom-property declaration early and
// inject arbitrary rules (e.g. a url(...) background making a network
// request). Common, real CSS values for each type all still match.
// The hex branch only allows the 4 valid CSS hex lengths (#rgb, #rgba,
// #rrggbb, #rrggbbaa) - 5 and 7 hex digits parse to nothing in real CSS.
const CSS_COLOR_RE = /^(#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+)\s*\)|hsl\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*\)|hsla\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*,\s*(0|1|0?\.\d+)\s*\)|[a-zA-Z]{3,20})$/;
const CSS_FONT_RE = /^[a-zA-Z0-9\s,'"-]{1,120}$/;
// Exported so producers that build a candidate CSS length string before
// this schema sees it (e.g. the W3C tokens importer) can reject an
// out-of-range candidate immediately, rather than staking a role on a
// value that's guaranteed to fail validation here later.
export const CSS_LENGTH_RE = /^\d{1,3}(\.\d+)?(px|rem|em)$/;

export const ThemeTokensSchema = z.object({
  colorBackground: z.string().regex(CSS_COLOR_RE, 'must be a plain CSS color (hex, rgb(a), hsl(a), or a named color)'),
  colorForeground: z.string().regex(CSS_COLOR_RE, 'must be a plain CSS color (hex, rgb(a), hsl(a), or a named color)'),
  colorAccent: z.string().regex(CSS_COLOR_RE, 'must be a plain CSS color (hex, rgb(a), hsl(a), or a named color)'),
  colorBorder: z.string().regex(CSS_COLOR_RE, 'must be a plain CSS color (hex, rgb(a), hsl(a), or a named color)'),
  fontHeading: z.string().regex(CSS_FONT_RE, 'must be a plain font-family value'),
  fontBody: z.string().regex(CSS_FONT_RE, 'must be a plain font-family value'),
  spaceUnit: z.string().regex(CSS_LENGTH_RE, 'must be a CSS length in px, rem, or em'),
  radiusBase: z.string().regex(CSS_LENGTH_RE, 'must be a CSS length in px, rem, or em'),
});
export type ThemeTokens = z.infer<typeof ThemeTokensSchema>;

export function tokensToCss(tokens: ThemeTokens): string {
  return `:root {
  --color-bg: ${tokens.colorBackground};
  --color-fg: ${tokens.colorForeground};
  --color-accent: ${tokens.colorAccent};
  --color-border: ${tokens.colorBorder};
  --font-heading: ${tokens.fontHeading};
  --font-body: ${tokens.fontBody};
  --space-unit: ${tokens.spaceUnit};
  --radius-base: ${tokens.radiusBase};
}
`;
}

export function parseThemeCss(css: string): ThemeTokens {
  function extract(varName: string): string {
    const match = css.match(new RegExp(`--${varName}:\\s*([^;]+);`));
    if (!match) {
      throw new Error(`Theme CSS is missing required custom property --${varName}`);
    }
    return match[1].trim();
  }

  return ThemeTokensSchema.parse({
    colorBackground: extract('color-bg'),
    colorForeground: extract('color-fg'),
    colorAccent: extract('color-accent'),
    colorBorder: extract('color-border'),
    fontHeading: extract('font-heading'),
    fontBody: extract('font-body'),
    spaceUnit: extract('space-unit'),
    radiusBase: extract('radius-base'),
  });
}
