import zlib from 'zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// GameForge's own --accent amber -- the default fill when no seed is given,
// so a mock placeholder still reads as "this is a stand-in," not a
// broken/empty image.
const DEFAULT_FILL: [number, number, number, number] = [0xe8, 0xa3, 0x3d, 0xff];

// A mock generation used to always produce this exact fill color regardless
// of prompt -- every mock sprite looked pixel-identical, which read as a
// real bug ("previews don't reflect the asset") rather than an obvious
// placeholder. Deriving a color from the prompt instead means different
// prompts produce visibly different placeholders, while the same prompt
// stays reproducible.
function hashToHue(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] =
    h < 60 ? [c, x, 0] :
    h < 120 ? [x, c, 0] :
    h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] :
    h < 300 ? [x, 0, c] :
    [c, 0, x];
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

function fillForSeed(seed: string): [number, number, number, number] {
  const [r, g, b] = hslToRgb(hashToHue(seed), 0.55, 0.55);
  return [r, g, b, 0xff];
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Hand-rolled minimal PNG encoder (signature + IHDR + IDAT + IEND) —
 * no image library needed for a solid-color placeholder. Draws a
 * bordered square so a mock generation is visibly a placeholder, not
 * an empty/broken image. `seed` (typically the generation prompt) picks
 * the fill color deterministically -- same seed always gives the same
 * color, different seeds give visibly different ones. Omit it for the
 * fixed default amber (used by call sites with no natural seed, e.g. a
 * UI-sheet composite with no single description).
 */
export function createPlaceholderPng(size: number, seed?: string): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const fill = seed ? fillForSeed(seed) : DEFAULT_FILL;
  const border = [0x3c, 0x35, 0x2a, 0xff]; // matches the app's --border token
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const onEdge = x === 0 || y === 0 || x === size - 1 || y === size - 1;
      const px = onEdge ? border : fill;
      const offset = rowStart + 1 + x * 4;
      raw[offset] = px[0];
      raw[offset + 1] = px[1];
      raw[offset + 2] = px[2];
      raw[offset + 3] = px[3];
    }
  }

  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
