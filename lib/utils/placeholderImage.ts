import zlib from 'zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
 * an empty/broken image.
 */
export function createPlaceholderPng(size: number, fill: [number, number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

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
