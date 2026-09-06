import { z } from 'zod';
import { ThemeTokensSchema } from '@/lib/services/ThemeGenerator';
import { getFontPairing } from '@/lib/services/seedThemes/fontPairings';
import { normalizeCssLength } from '@/lib/services/seedThemes/normalizeCssLength';
import type { SeedTheme } from '@/lib/services/seedThemes/types';

const BOOTSWATCH_API_URL = 'https://bootswatch.com/api/5.json';
const REQUEST_TIMEOUT_MS = 30_000;

const BootswatchApiResponseSchema = z.object({
  themes: z.array(z.object({ name: z.string(), cssMin: z.string().url() })),
});

function extractRootCustomProperty(css: string, propName: string): string | null {
  // Match all :root blocks (including :root,[data-bs-theme=light] variants), collect their bodies
  const rootBlocks = [...css.matchAll(/:root[^{]*\{([^}]*)\}/g)].map(m => m[1]);
  const combined = rootBlocks.join(';');

  // Search for the property in the combined text, preferring the last occurrence (CSS cascade)
  const re = new RegExp(`${propName}:\\s*([^;]+);?`, 'g');
  const matches = [...combined.matchAll(re)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1].trim();
}

export function parseBootswatchTheme(name: string, compiledCss: string): SeedTheme | null {
  try {
    const colorBackground = extractRootCustomProperty(compiledCss, '--bs-body-bg');
    const colorForeground = extractRootCustomProperty(compiledCss, '--bs-body-color');
    const colorAccent = extractRootCustomProperty(compiledCss, '--bs-primary');
    const colorBorder = extractRootCustomProperty(compiledCss, '--bs-border-color');
    const rawRadiusBase = extractRootCustomProperty(compiledCss, '--bs-border-radius');

    if (!colorBackground || !colorForeground || !colorAccent || !colorBorder || !rawRadiusBase) {
      console.error(`Skipping Bootswatch theme "${name}": missing one or more required custom properties (--bs-body-bg/--bs-body-color/--bs-primary/--bs-border-color/--bs-border-radius).`);
      return null;
    }

    const radiusBase = normalizeCssLength(rawRadiusBase);
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
  } catch (error) {
    console.error(`Skipping Bootswatch theme "${name}": ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function fetchBootswatchThemes(): Promise<SeedTheme[]> {
  const apiRes = await fetch(BOOTSWATCH_API_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!apiRes.ok) {
    throw new Error(`Failed to fetch Bootswatch theme list (${apiRes.status}): ${apiRes.statusText}`);
  }
  const apiData = BootswatchApiResponseSchema.parse(await apiRes.json());

  const themes: SeedTheme[] = [];
  for (const { name, cssMin } of apiData.themes) {
    if (!cssMin.startsWith('https://bootswatch.com/')) {
      console.error(`Skipping Bootswatch theme "${name}": cssMin URL is not from bootswatch.com: ${cssMin}`);
      continue;
    }
    const cssRes = await fetch(cssMin, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
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
