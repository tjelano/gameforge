import { describe, it, expect } from 'vitest';
import { sanitizeComponentHtml, sanitizeComponentCss } from '@/lib/services/componentSanitize';

describe('sanitizeComponentHtml', () => {
  it('strips a <script> tag entirely', () => {
    const dirty = '<div>Hello<script>alert(1)</script></div>';
    const clean = sanitizeComponentHtml(dirty);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('alert(1)');
  });

  it('strips an onclick attribute but keeps the element', () => {
    const dirty = '<button onclick="alert(1)">Click me</button>';
    const clean = sanitizeComponentHtml(dirty);
    expect(clean).not.toContain('onclick');
    expect(clean).toContain('<button');
    expect(clean).toContain('Click me');
  });

  it('strips a javascript: href', () => {
    const dirty = '<a href="javascript:alert(1)">link</a>';
    const clean = sanitizeComponentHtml(dirty);
    expect(clean).not.toContain('javascript:');
  });

  it('passes a realistic, legitimate component through with its structure intact', () => {
    const clean = '<button class="btn-primary">Buy now</button>';
    const result = sanitizeComponentHtml(clean);
    expect(result).toContain('<button');
    expect(result).toContain('class="btn-primary"');
    expect(result).toContain('Buy now');
  });
});

describe('sanitizeComponentCss', () => {
  it('rejects CSS containing url( in a background property', () => {
    expect(() => sanitizeComponentCss('.btn { background: url(https://evil.example/track.gif); }')).toThrow();
  });

  it('rejects CSS containing an @import with url(', () => {
    expect(() => sanitizeComponentCss("@import url('https://evil.example/style.css');")).toThrow();
  });

  it('rejects CSS with mixed-case URL(', () => {
    expect(() => sanitizeComponentCss('.btn { background: URL(https://evil.example/x.png); }')).toThrow();
  });

  it('passes through legitimate CSS with no url() references unchanged', () => {
    const css = '.btn { background: var(--color-accent); color: var(--color-bg); padding: calc(var(--space-unit) * 2); border-radius: var(--radius-base); }';
    expect(sanitizeComponentCss(css)).toBe(css);
  });
});
