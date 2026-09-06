// Verified against two independent primary sources (see the plan's Context
// section for the full derivation): OKLCH->Oklab from the CSS Color 4 spec's
// own reference conversions.js, Oklab->linear-sRGB from Bjorn Ottosson's
// canonical oklab.js page, linear-sRGB->sRGB gamma encoding from the CSS
// Color 4 spec. Real OKLCH design-token values routinely fall outside the
// sRGB gamut (a negative or >1 linear channel) — this is expected, not a
// bug, and is clamped rather than rejected.

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function linearChannelToSrgbByte(linear: number): number {
  const clamped = clamp01(linear);
  const encoded = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  return Math.round(clamp01(encoded) * 255);
}

function byteToHexPair(byte: number): string {
  return byte.toString(16).padStart(2, '0');
}

export function oklchToHex(lightnessPercent: number, chroma: number, hueDegrees: number): string {
  const l = lightnessPercent / 100;
  const hueRadians = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hueRadians);
  const b = chroma * Math.sin(hueRadians);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;

  const lCubed = l_ * l_ * l_;
  const mCubed = m_ * m_ * m_;
  const sCubed = s_ * s_ * s_;

  const linearR = 4.0767416621 * lCubed - 3.3077115913 * mCubed + 0.2309699292 * sCubed;
  const linearG = -1.2684380046 * lCubed + 2.6097574011 * mCubed - 0.3413193965 * sCubed;
  const linearB = -0.0041960863 * lCubed - 0.7034186147 * mCubed + 1.7076147010 * sCubed;

  return `#${byteToHexPair(linearChannelToSrgbByte(linearR))}${byteToHexPair(linearChannelToSrgbByte(linearG))}${byteToHexPair(linearChannelToSrgbByte(linearB))}`;
}

/** Parses a DaisyUI-format bare OKLCh triple string, e.g. "76.76% 0.184 183.61". */
export function parseOklchTriple(value: string): [number, number, number] {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 3) {
    throw new Error(`Expected an OKLCH triple "L% C H", got "${value}"`);
  }
  const [lightnessPercent, chroma, hueDegrees] = parts.map(parseFloat);
  if ([lightnessPercent, chroma, hueDegrees].some(Number.isNaN)) {
    throw new Error(`Could not parse OKLCH triple "${value}"`);
  }
  return [lightnessPercent, chroma, hueDegrees];
}
