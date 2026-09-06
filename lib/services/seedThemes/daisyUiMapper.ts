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
