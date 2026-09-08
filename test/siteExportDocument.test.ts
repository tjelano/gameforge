import { describe, it, expect } from 'vitest';
import { htmlToJsx } from '@/lib/services/siteExportDocument';

describe('htmlToJsx', () => {
  it('converts a simple element with a class attribute to className referencing styles[...]', () => {
    const result = htmlToJsx('<button class="btn-primary">Buy now</button>');
    expect(result).toBe('<button className={styles[\'btn-primary\']}>Buy now</button>');
  });

  it('rewrites multiple space-separated classes into a template literal of styles[...] lookups', () => {
    const result = htmlToJsx('<div class="card shadow">Hi</div>');
    expect(result).toBe('<div className={`${styles[\'card\']} ${styles[\'shadow\']}`}>Hi</div>');
  });

  it('maps the "for" attribute to htmlFor', () => {
    const result = htmlToJsx('<label for="email">Email</label>');
    expect(result).toBe('<label htmlFor={"email"}>Email</label>');
  });

  it('emits a bare boolean attribute shorthand for an empty-string attribute value', () => {
    const result = htmlToJsx('<button disabled>Wait</button>');
    expect(result).toBe('<button disabled>Wait</button>');
  });

  it('self-closes void elements', () => {
    expect(htmlToJsx('<br>')).toBe('<br />');
    expect(htmlToJsx('<hr>')).toBe('<hr />');
    expect(htmlToJsx('<input type="text">')).toBe('<input type={"text"} />');
  });

  it('does not re-encode already-decoded HTML entities in text content', () => {
    const result = htmlToJsx('<p>Save &amp; enjoy</p>');
    expect(result).toBe('<p>Save & enjoy</p>');
  });

  it('escapes literal curly braces in text content so they are not read as a JSX expression', () => {
    const result = htmlToJsx('<p>Buy {now}</p>');
    expect(result).toBe('<p>{"Buy {now}"}</p>');
  });

  it('renders nested elements and preserves attributes on each level', () => {
    const result = htmlToJsx('<nav class="nav"><a href="/" class="link">Home</a></nav>');
    expect(result).toBe('<nav className={styles[\'nav\']}><a href={"/"} className={styles[\'link\']}>Home</a></nav>');
  });

  it('renders multiple top-level sibling nodes joined with no separator', () => {
    const result = htmlToJsx('<span>A</span><span>B</span>');
    expect(result).toBe('<span>A</span><span>B</span>');
  });

  it('regular (non-class, non-boolean) attribute values are wrapped as a JS string expression, not a bare quoted literal', () => {
    // JSX plain double-quoted attribute values do not follow JS string
    // escaping rules the way {"..."} does - wrapping every non-class,
    // non-boolean attribute as a JS expression container guarantees
    // correct escaping regardless of the value's content (e.g. an
    // embedded double quote), rather than relying on JSX's own,
    // less-well-specified plain-attribute-string parsing.
    const result = htmlToJsx('<a href="/a&quot;b">x</a>');
    expect(result).toBe('<a href={"/a\\"b"}>x</a>');
  });
});
