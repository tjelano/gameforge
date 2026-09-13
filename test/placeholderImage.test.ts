import { describe, it, expect } from 'vitest';
import { createPlaceholderPng } from '@/lib/utils/placeholderImage';

describe('createPlaceholderPng', () => {
  it('draws a valid PNG with only a size argument — the fill color was always the same literal at both call sites', () => {
    const png = createPlaceholderPng(4);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
});
