import { ThemeTokensSchema, CSS_LENGTH_RE, type ThemeTokens } from '@/lib/services/themeTokens';

// No real W3C tokens file nests anywhere close to this deep - this exists
// purely as a DoS guard. Without it, an adversarial (but validly-parsed)
// deeply-nested JSON document overflows the call stack: verified a ~30KB
// payload nesting ~5,000 levels crashes collectTokens's naive recursion
// with an uncaught RangeError, which the route would then report as a 500
// instead of the 400 this actually is.
const MAX_TREE_DEPTH = 64;

// Aliases matched against a token's own key (last path segment), normalized
// to lowercase-alphanumeric-only so "color-accent", "colorAccent", "Accent"
// all match the same alias. Types are checked separately ($type must match
// too), so e.g. "text" as a fontBody alias never collides with "text" as a
// colorForeground alias - they're drawn from disjoint $type pools.
const ROLE_ALIASES: Record<keyof ThemeTokens, { type: 'color' | 'fontFamily' | 'dimension'; aliases: string[] }> = {
  colorBackground: { type: 'color', aliases: ['background', 'bg', 'surface'] },
  colorForeground: { type: 'color', aliases: ['foreground', 'fg', 'text', 'onbackground'] },
  colorAccent: { type: 'color', aliases: ['accent', 'primary', 'brand'] },
  colorBorder: { type: 'color', aliases: ['border', 'outline', 'divider'] },
  fontHeading: { type: 'fontFamily', aliases: ['heading', 'display', 'title'] },
  fontBody: { type: 'fontFamily', aliases: ['body', 'text', 'base'] },
  spaceUnit: { type: 'dimension', aliases: ['spaceunit', 'spacing', 'space', 'gap'] },
  radiusBase: { type: 'dimension', aliases: ['radiusbase', 'radius', 'borderradius', 'cornerradius'] },
};

interface FoundToken {
  key: string; // normalized: lowercase, alphanumeric only
  type: string;
  value: unknown;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Walks the whole JSON tree collecting every {$type, $value} leaf, regardless of nesting or group names. Stops descending past MAX_TREE_DEPTH rather than recursing unboundedly - see that constant's comment. */
function collectTokens(node: unknown, lastKey: string, out: FoundToken[], depth = 0): void {
  if (!node || typeof node !== 'object') return;
  if (depth > MAX_TREE_DEPTH) return;
  const obj = node as Record<string, unknown>;
  if (typeof obj.$type === 'string' && '$value' in obj) {
    out.push({ key: normalize(lastKey), type: obj.$type, value: obj.$value });
    return; // a token node's own properties (colorSpace etc.) aren't nested tokens
  }
  for (const [key, child] of Object.entries(obj)) {
    if (key.startsWith('$')) continue;
    collectTokens(child, key, out, depth + 1);
  }
}

function colorTokenToCss(value: unknown): string | null {
  // Many real-world exports use a plain hex string for $value even though
  // the current DTCG spec's Color type is the structured
  // {colorSpace, components, alpha} object GameForge's own exporter
  // produces - accept both. ThemeTokensSchema's CSS_COLOR_RE already
  // matches hex directly, so this can pass through unchanged.
  // Only the 4 valid CSS hex lengths (#rgb, #rgba, #rrggbb, #rrggbbaa) -
  // 5 and 7 hex digits parse to nothing in real CSS.
  if (typeof value === 'string' && /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) return value;
  if (!value || typeof value !== 'object') return null;
  const v = value as { components?: unknown; alpha?: unknown };
  if (!Array.isArray(v.components) || v.components.length !== 3) return null;
  // Explicitly type-checked rather than coerced with Number(): a component
  // of null, '', or false would otherwise coerce to a finite 0 via
  // Number(), silently producing an unintended color instead of failing
  // conversion - same reasoning as the alpha check below.
  if (!v.components.every(c => typeof c === 'number' && Number.isFinite(c))) return null;
  const channels = v.components as number[];
  const [r, g, b] = channels.map(c => Math.round(Math.max(0, Math.min(1, c)) * 255));
  // Explicitly type-checked rather than coerced with Number(): v.alpha === null
  // (or false, or '') would otherwise coerce to a finite, in-range 0, silently
  // producing a fully-transparent color instead of failing conversion.
  let alpha = 1;
  if (v.alpha !== undefined) {
    if (typeof v.alpha !== 'number' || !Number.isFinite(v.alpha) || v.alpha < 0 || v.alpha > 1) return null;
    alpha = v.alpha;
  }
  return alpha === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// A bare (unquoted) CSS family-name is only valid as a sequence of plain
// idents - a space-separated multi-word name is fine unquoted ("Times New
// Roman"), but any quote character never is, with or without a space
// ("O'Brien" unquoted is a CSS parse error, not just "Rock'n'Roll One").
// Returns null when the name mixes both quote types, since neither can
// safely wrap it - the caller must treat that as a failed conversion so
// its fallback loop can try a later candidate.
function quoteFontName(name: string): string | null {
  const hasSingleQuote = name.includes("'");
  const hasDoubleQuote = name.includes('"');
  if (!name.includes(' ') && !hasSingleQuote && !hasDoubleQuote) return name;
  if (hasSingleQuote && hasDoubleQuote) return null;
  return hasSingleQuote ? `"${name}"` : `'${name}'`;
}

function fontFamilyTokenToCss(value: unknown): string | null {
  if (typeof value === 'string') return quoteFontName(value);
  if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
    const quoted: string[] = [];
    for (const name of value) {
      const q = quoteFontName(name);
      if (q === null) return null;
      quoted.push(q);
    }
    return quoted.join(', ');
  }
  return null;
}

const ALLOWED_DIMENSION_UNITS = new Set(['px', 'rem', 'em']);

function dimensionTokenToCss(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { value?: unknown; unit?: unknown };
  // An unsupported unit (e.g. "%", "vh") or a non-finite value must fail
  // conversion outright, not return a truthy-but-doomed string - same
  // reasoning as colorTokenToCss: this lets the caller's candidate-
  // fallback loop try a later, valid alias match instead of getting stuck.
  if (typeof v.value !== 'number' || !Number.isFinite(v.value)) return null;
  if (typeof v.unit !== 'string' || !ALLOWED_DIMENSION_UNITS.has(v.unit)) return null;
  const css = `${v.value}${v.unit}`;
  // A negative value, a value >= 1000, or one that renders in exponential
  // notation (e.g. an adversarially large/small number) all produce a
  // truthy string here that CSS_LENGTH_RE - and so ThemeTokensSchema -
  // will still reject. Check it now against the same regex the schema
  // uses, so a doomed candidate fails conversion instead of consuming the
  // role and rejecting the whole import even when a later, valid
  // alias-matching candidate exists.
  return CSS_LENGTH_RE.test(css) ? css : null;
}

const CONVERTERS: Record<string, (value: unknown) => string | null> = {
  color: colorTokenToCss,
  fontFamily: fontFamilyTokenToCss,
  dimension: dimensionTokenToCss,
};

export type ParseW3cTokensResult =
  | { success: true; tokens: ThemeTokens }
  | { success: false; error: string };

export function parseW3cTokensJson(jsonText: string): ParseW3cTokensResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { success: false, error: 'Could not parse the file as JSON.' };
  }

  const found: FoundToken[] = [];
  collectTokens(parsed, '', found);

  const result: Partial<Record<keyof ThemeTokens, string>> = {};
  const missing: string[] = [];

  for (const role of Object.keys(ROLE_ALIASES) as (keyof ThemeTokens)[]) {
    const { type, aliases } = ROLE_ALIASES[role];
    // Try every alias-matching candidate, not just the first structural
    // match - a file can legitimately have more than one token whose key
    // matches an alias (e.g. two different "text" colors in different
    // groups), and the first one found isn't necessarily convertible. Only
    // give up once none of them produce valid CSS.
    let css: string | null = null;
    for (const candidate of found.filter(t => t.type === type && aliases.includes(t.key))) {
      css = CONVERTERS[type](candidate.value);
      if (css) break;
    }
    if (!css) {
      missing.push(role);
      continue;
    }
    result[role] = css;
  }

  if (missing.length > 0) {
    return {
      success: false,
      error: `Could not find a matching token for: ${missing.join(', ')}. Rename the relevant tokens to something recognizable (e.g. "accent", "primary", or "brand" for colorAccent) and try again.`,
    };
  }

  // Every other producer of ThemeTokens in this codebase validates through
  // this same schema before the value is trusted (ClaudeApiThemeGenerator,
  // the theme edit routes, the seed-theme mappers) - tokensToCss() below
  // interpolates these strings directly into a real CSS file, and several
  // read paths for that file (export, contrast) never re-sanitize it,
  // relying on this exact validation having already happened at write
  // time. Skipping it here would let a value like an $value string
  // containing "'; } body { ... }" close the CSS custom-property
  // declaration early and inject an arbitrary rule.
  const validated = ThemeTokensSchema.safeParse(result);
  if (!validated.success) {
    return {
      success: false,
      error: `Found tokens for every role, but some values aren't valid CSS: ${validated.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')}`,
    };
  }

  return { success: true, tokens: validated.data };
}
