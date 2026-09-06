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
