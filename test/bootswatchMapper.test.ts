import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseBootswatchTheme, fetchBootswatchThemes } from '@/lib/services/seedThemes/bootswatchMapper';
import { getFontPairing } from '@/lib/services/seedThemes/fontPairings';

// Real, confirmed compiled-CSS values for Bootswatch's Flatly theme (confirmed
// by direct fetch of its cssMin URL during planning), condensed to only the
// custom properties this mapper reads. Real Bootstrap 5.3 CSS uses a
// comma-separated compound selector (`:root,[data-bs-theme=light]{...}`) for
// the properties block, not a second plain `:root{...}` block.
const FLATLY_ROOT_CSS = ':root{scroll-behavior:smooth}:root,[data-bs-theme=light]{--bs-blue:#0d6efd;--bs-body-bg:#fff;--bs-body-color:#212529;--bs-primary:#2c3e50;--bs-border-color:#dee2e6;--bs-border-radius:0.375rem}';

// Proves dark-mode override blocks (scoped to [data-bs-theme=dark], not :root)
// don't leak into the extracted values.
const FLATLY_ROOT_CSS_WITH_DARK_OVERRIDE = FLATLY_ROOT_CSS + '[data-bs-theme=dark]{--bs-body-bg:#000;--bs-body-color:#fff}';

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

  it('returns null and logs when theme name is not in FONT_PAIRINGS', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const theme = parseBootswatchTheme('NotARealBootswatchTheme', FLATLY_ROOT_CSS);
    expect(theme).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('NotARealBootswatchTheme'));
    consoleErrorSpy.mockRestore();
  });

  it('does not pick up a [data-bs-theme=dark] override block for the light theme values', () => {
    const theme = parseBootswatchTheme('Flatly', FLATLY_ROOT_CSS_WITH_DARK_OVERRIDE);
    expect(theme).not.toBeNull();
    expect(theme!.tokens.colorBackground).toBe('#fff');
    expect(theme!.tokens.colorForeground).toBe('#212529');
  });

  it('imports a theme with --bs-border-radius:0 instead of skipping it', () => {
    const css = FLATLY_ROOT_CSS.replace('--bs-border-radius:0.375rem', '--bs-border-radius:0');
    const theme = parseBootswatchTheme('Flatly', css);
    expect(theme).not.toBeNull();
    expect(theme!.tokens.radiusBase).toBe('0px');
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

  it('rejects when the API response is malformed (themes missing)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ notThemes: [] }), { status: 200 })));
    await expect(fetchBootswatchThemes()).rejects.toThrow();
  });

  it('rejects when the API response has themes that is not an array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ themes: 'nope' }), { status: 200 })));
    await expect(fetchBootswatchThemes()).rejects.toThrow();
  });

  it('skips a theme whose cssMin URL is not on bootswatch.com, without fetching it', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://bootswatch.com/api/5.json') {
        return new Response(JSON.stringify({
          themes: [{ name: 'Evil', cssMin: 'https://evil.example.com/bootstrap.min.css' }],
        }), { status: 200 });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const themes = await fetchBootswatchThemes();

    expect(themes).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the API list, never the off-host cssMin
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('evil.example.com'));
    consoleErrorSpy.mockRestore();
  });
});
