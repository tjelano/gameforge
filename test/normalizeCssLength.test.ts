import { describe, it, expect } from 'vitest';
import { normalizeCssLength } from '@/lib/services/seedThemes/normalizeCssLength';

describe('normalizeCssLength', () => {
  it('normalizes bare unitless zero to 0px', () => {
    expect(normalizeCssLength('0')).toBe('0px');
  });

  it('normalizes a leading-dot decimal by prefixing a leading zero', () => {
    expect(normalizeCssLength('.125rem')).toBe('0.125rem');
  });

  it('passes an already-valid CSS length through unchanged', () => {
    expect(normalizeCssLength('0.5rem')).toBe('0.5rem');
  });
});
