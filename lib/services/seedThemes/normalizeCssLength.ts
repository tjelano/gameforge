// Normalizes CSS length notations that are valid CSS but not accepted by the
// shared CSS_LENGTH_RE regex in ThemeGenerator.ts (bare unitless `0`, and
// leading-dot decimals like `.125rem`) into an equivalent form that regex
// does accept. Value-preserving — never changes what the length means.
export function normalizeCssLength(raw: string): string {
  const v = raw.trim();
  if (v === '0') return '0px';
  if (v.startsWith('.')) return '0' + v;
  return v;
}
