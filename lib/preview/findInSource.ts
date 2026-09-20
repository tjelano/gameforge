export interface SourceMatch {
  start: number;
  end: number;
}

export interface SourceTarget {
  html: SourceMatch | null;
  css: SourceMatch | null;
}

function findRange(haystack: string, needle: string): SourceMatch | null {
  const idx = haystack.indexOf(needle);
  if (idx === -1) return null;
  return { start: idx, end: idx + needle.length };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `dataGfId` is attacker/AI-influenced content (digits only in practice, per assignElementIds,
// but not type-guaranteed) — always escaped before entering a RegExp source string. A trailing
// lookahead (not a consuming boundary group) keeps `.gf-3` from matching inside `.gf-31` — no
// leading boundary is needed: the needle's own literal `.` already keeps it from matching inside
// `prefix-gf-3` (which has no `.` before `gf-3` at all), and a leading boundary would wrongly
// reject legitimate compound selectors like `p.gf-3` or `.card.gf-3`.
function findCssRuleRange(css: string, dataGfId: string): SourceMatch | null {
  // Escaped once, as a single already-literal `.gf-<id>` string — escaping dataGfId on its own
  // first and then escaping that result again would double-escape any regex-special character in
  // a hypothetical non-digit id, producing a pattern that could never match real CSS.
  const re = new RegExp(`${escapeRegExp(`.gf-${dataGfId}`)}(?![-\\w])`);
  const m = re.exec(css);
  if (!m) return null;
  return { start: m.index, end: m.index + m[0].length };
}

/**
 * Resolves a clicked element's data-gf-id to its location in the raw HTML/CSS source, for
 * "jump to source" on the edit-component page. Most elements have no per-element CSS rule (only
 * ones touched by element-specific patching get a .gf-<id> class/rule) — a null css match is the
 * expected common case, not a failure.
 */
export function resolveSourceTarget(dataGfId: string | null, html: string, css: string): SourceTarget {
  if (!dataGfId) return { html: null, css: null };
  return {
    html: findRange(html, `data-gf-id="${dataGfId}"`),
    css: findCssRuleRange(css, dataGfId),
  };
}
