// lib/services/hexColor.ts
// Shared by contrastChecker.ts and oklabDistance.ts — both convert a CSS
// color into linear-sRGB channels, and both must reject anything that isn't
// 3- or 6-digit hex rather than silently computing NaN. ThemeTokensSchema's
// CSS_COLOR_RE (lib/services/ThemeGenerator.ts) permits hex of any length
// 3-8, rgb()/rgba()/hsl()/hsla(), and bare named colors — none of which
// either caller's math can turn into RGB channels — so a hex string that
// isn't exactly 3 or 6 digits after expansion throws a clear error instead
// of silently producing a wrong or NaN result (NaN would JSON-serialize as
// null and crash a client on e.g. `.toFixed()`). Pulled out once instead of
// duplicated near-verbatim in both files, per AGENTS.md's "extract shared
// helpers for safety-critical logic on sight."

export function linearizeChannel(normalized: number): number {
  return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

// Expands 3-digit shorthand (e.g. '#fff') to 6 digits, then validates the
// result is exactly 6 hex digits. `errorContext` lets each caller keep its
// own error wording (e.g. "Cannot compute contrast for color") while
// sharing the expansion/validation logic itself.
export function normalizeHex6(hex: string, errorContext: string): string {
  let clean = hex.replace('#', '');
  if (clean.length === 3) {
    clean = clean.split('').map((c) => c + c).join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    throw new Error(`${errorContext} "${hex}" — only 3-digit or 6-digit hex colors are supported.`);
  }
  return clean;
}
