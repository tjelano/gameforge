import { ThemeTokensSchema, type ThemeTokens } from '@/lib/services/themeTokens';

// No real W3C tokens file nests anywhere close to this deep - this exists
// purely as a DoS guard. Without it, an adversarial (but validly-parsed)
// deeply-nested JSON document overflows the call stack: verified a ~30KB
// payload nesting ~5,000 levels crashes collectTokens's naive recursion
// with an uncaught RangeError, which the route would then report as a 500
// instead of the 400 this is actually is.
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
  if (!value || typeof value !== 'object') return null;
  const v = value as { components?: unknown; alpha?: unknown };
  if (!Array.isArray(v.components) || v.components.length !== 3) return null;
  const [r, g, b] = v.components.map(c => Math.round(Math.max(0, Math.min(1, Number(c))) * 255));
  const alpha = typeof v.alpha === 'number' ? v.alpha : 1;
  return alpha === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function fontFamilyTokenToCss(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
    return value.map(name => (name.includes(' ') ? `'${name}'` : name)).join(', ');
  }
  return null;
}

function dimensionTokenToCss(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { value?: unknown; unit?: unknown };
  if (typeof v.value !== 'number' || typeof v.unit !== 'string') return null;
  return `${v.value}${v.unit}`;
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
    const candidate = found.find(t => t.type === type && aliases.includes(t.key));
    if (!candidate) {
      missing.push(role);
      continue;
    }
    const css = CONVERTERS[type](candidate.value);
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
