import type { ThemeTokens } from '@/lib/services/ThemeGenerator';

// Token shapes verified directly against the Design Tokens Format Module
// spec (2025.10, designtokens.org) during planning.

function hexToRgbComponents(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const expand = (c: string) => c + c;
  let r: string, g: string, b: string;
  if (clean.length === 3 || clean.length === 4) {
    r = expand(clean[0]);
    g = expand(clean[1]);
    b = expand(clean[2]);
  } else if (clean.length === 6 || clean.length === 8) {
    r = clean.slice(0, 2);
    g = clean.slice(2, 4);
    b = clean.slice(4, 6);
  } else {
    throw new Error(`Cannot export color "${hex}" as a W3C token — unrecognized hex length.`);
  }
  return [parseInt(r, 16) / 255, parseInt(g, 16) / 255, parseInt(b, 16) / 255];
}

function colorToken(value: string) {
  if (!value.startsWith('#')) {
    throw new Error(`Cannot export color "${value}" as a W3C token — only hex colors are supported.`);
  }
  const [r, g, b] = hexToRgbComponents(value);
  return { $type: 'color', $value: { colorSpace: 'srgb', components: [r, g, b], alpha: 1 } };
}

function fontFamilyToken(value: string) {
  const names = value.split(',').map(part => part.trim().replace(/^['"]|['"]$/g, ''));
  return { $type: 'fontFamily', $value: names.length === 1 ? names[0] : names };
}

function dimensionToken(value: string) {
  const match = value.match(/^(\d+(?:\.\d+)?)(px|rem)$/);
  if (!match) {
    throw new Error(`Cannot export dimension "${value}" as a W3C token — only px and rem units are supported.`);
  }
  return { $type: 'dimension', $value: { value: parseFloat(match[1]), unit: match[2] as 'px' | 'rem' } };
}

export function tokensToW3cTokens(tokens: ThemeTokens): string {
  const doc = {
    color: {
      background: colorToken(tokens.colorBackground),
      foreground: colorToken(tokens.colorForeground),
      accent: colorToken(tokens.colorAccent),
      border: colorToken(tokens.colorBorder),
    },
    font: {
      heading: fontFamilyToken(tokens.fontHeading),
      body: fontFamilyToken(tokens.fontBody),
    },
    dimension: {
      'space-unit': dimensionToken(tokens.spaceUnit),
      'radius-base': dimensionToken(tokens.radiusBase),
    },
  };
  return JSON.stringify(doc, null, 2);
}
