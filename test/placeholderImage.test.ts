import { describe, it, expect } from 'vitest';
import { createPlaceholderPng } from '@/lib/utils/placeholderImage';

describe('createPlaceholderPng', () => {
  it('draws a valid PNG with only a size argument — the fill color was always the same literal at both call sites', () => {
    const png = createPlaceholderPng(4);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('produces visibly different output for different seeds — this is the actual fix: a mock generation used to be pixel-identical regardless of prompt', () => {
    const a = createPlaceholderPng(16, 'a red potion bottle');
    const b = createPlaceholderPng(16, 'a blue crystal shard');
    expect(a.equals(b)).toBe(false);
  });

  it('is deterministic — the same seed always produces the same image', () => {
    const a = createPlaceholderPng(16, 'a goblin scout');
    const b = createPlaceholderPng(16, 'a goblin scout');
    expect(a.equals(b)).toBe(true);
  });

  it('falls back to the fixed default color when no seed is given', () => {
    const a = createPlaceholderPng(16);
    const b = createPlaceholderPng(16);
    expect(a.equals(b)).toBe(true);
  });
});
