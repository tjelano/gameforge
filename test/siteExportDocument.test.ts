import { describe, it, expect } from 'vitest';
import { htmlToJsx } from '@/lib/services/siteExportDocument';

describe('htmlToJsx', () => {
  it('converts a simple element with a class attribute to className referencing styles[...]', () => {
    const result = htmlToJsx('<button class="btn-primary">Buy now</button>');
    // The styles[...] key comes from JSON.stringify, which always produces
    // double-quoted output - this is the ONLY safe choice (see the
    // "class name containing a quote" test below for why single-quoting
    // by hand is unsafe).
    expect(result).toBe('<button className={styles["btn-primary"]}>Buy now</button>');
  });

  it('rewrites multiple space-separated classes into a template literal of styles[...] lookups', () => {
    const result = htmlToJsx('<div class="card shadow">Hi</div>');
    expect(result).toBe('<div className={`${styles["card"]} ${styles["shadow"]}`}>Hi</div>');
  });

  it('escapes a quote character inside a class name via JSON.stringify, not raw interpolation', () => {
    // AI-generated component HTML is untrusted-shaped content -
    // sanitizeComponentHtml allowlists attribute NAMES, not value
    // content, so a quote character inside a class name is a real,
    // reachable case, not hypothetical. Raw string interpolation here
    // would let the value break out of the generated .tsx file's string
    // literal boundary - JSON.stringify is the only safe choice.
    const result = htmlToJsx(`<div class="foo'bar">x</div>`);
    expect(result).toBe(`<div className={styles["foo'bar"]}>x</div>`);
  });

  it('maps the "for" attribute to htmlFor', () => {
    const result = htmlToJsx('<label for="email">Email</label>');
    expect(result).toBe('<label htmlFor={"email"}>Email</label>');
  });

  it('emits a bare boolean attribute shorthand only for genuine HTML boolean attributes', () => {
    const result = htmlToJsx('<button disabled>Wait</button>');
    expect(result).toBe('<button disabled>Wait</button>');
  });

  it('does NOT treat an empty-string value on a non-boolean attribute as boolean shorthand', () => {
    // <option value=""> is the standard "please select" placeholder
    // pattern, and <input placeholder=""> is a real, reachable case -
    // an empty-string VALUE is not the same thing as a boolean
    // attribute's mere presence. Only genuine HTML boolean attributes
    // (disabled, required, in this allowlist) get the bare shorthand.
    expect(htmlToJsx('<option value="">Please select</option>')).toBe('<option value={""}>Please select</option>');
    expect(htmlToJsx('<input placeholder="">')).toBe('<input placeholder={""} />');
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

  it('escapes literal angle brackets in text content, which are otherwise invalid inside JSX text', () => {
    // Confirmed by actually compiling equivalent raw JSX with tsc
    // (--jsx react-jsx): an unescaped "<" produces TS1003 (Identifier
    // expected) and an unescaped ">" produces TS1382 - text content is
    // NOT restricted by sanitizeComponentHtml (only tags/attributes
    // are), so LLM-generated component copy containing "<"/">" (e.g.
    // "Price < $10", "See > for details") is a real, reachable case
    // that would otherwise break the exported project's build.
    expect(htmlToJsx('<p>Price is < 10 dollars</p>')).toBe('<p>{"Price is < 10 dollars"}</p>');
    expect(htmlToJsx('<p>See > for details</p>')).toBe('<p>{"See > for details"}</p>');
  });

  it('renders nested elements and preserves attributes on each level', () => {
    const result = htmlToJsx('<nav class="nav"><a href="/" class="link">Home</a></nav>');
    expect(result).toBe('<nav className={styles["nav"]}><a href={"/"} className={styles["link"]}>Home</a></nav>');
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

  it('emits the bare boolean shorthand for disabled/required regardless of their string value, not just an empty string', () => {
    // sanitizeHtml does NOT normalize disabled="disabled" to an empty
    // value (confirmed by actually running it) - this XHTML-style form
    // is common LLM output and must be treated identically to a bare
    // `disabled`, since real HTML boolean-attribute semantics are
    // presence-based, not value-based.
    expect(htmlToJsx('<button disabled="disabled">Wait</button>')).toBe('<button disabled>Wait</button>');
    expect(htmlToJsx('<input required="required">')).toBe('<input required />');
  });

  it('coerces rows/cols to a JSX number expression, never a string', () => {
    // React types textarea's rows/cols as `number` - confirmed with a
    // real tsc compile that rows={"4"} (a string) produces TS2322.
    expect(htmlToJsx('<textarea rows="4" cols="30"></textarea>')).toBe('<textarea rows={4} cols={30}></textarea>');
  });

  it('falls back to a safe positive integer for a non-numeric rows/cols value', () => {
    expect(htmlToJsx('<textarea rows="abc"></textarea>')).toBe('<textarea rows={1}></textarea>');
  });
});
