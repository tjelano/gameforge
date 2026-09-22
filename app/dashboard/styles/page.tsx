'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { useStyles } from '@/lib/hooks/useStyles';
import { deriveThumbnailUrl, isValidInspoSlug } from '@/lib/services/inspoClient';

interface InspoResultItem {
  slug: string;
  title?: string;
  northstar?: string;
  palette: string[];
  thumbnailUrl: string | null;
}

// Shared shape between search's `results` and recommend's `exemplars` — see
// app/api/inspo/search/route.ts. Anything else on a raw item (autopsy, tags,
// fonts, mode, macro, axes) is real but too verbose/irrelevant for a result
// card, so it's dropped here rather than carried through.
function toInspoResultItem(raw: any, imagesTemplate: unknown): InspoResultItem {
  const slug = typeof raw?.slug === 'string' ? raw.slug : '';
  return {
    slug,
    title: typeof raw?.title === 'string' ? raw.title : undefined,
    northstar: typeof raw?.northstar === 'string' ? raw.northstar : undefined,
    palette: Array.isArray(raw?.palette) ? raw.palette.filter((c: unknown) => typeof c === 'string') : [],
    thumbnailUrl: slug ? deriveThumbnailUrl(imagesTemplate, slug) : null,
  };
}

// Only the four simplest/most useful filters categories — get_filters returns
// 13, the rest (color, pageType, device, componentType, tagComponents,
// paperBand, displayClass, accentHue, macrostructure, macrostructureCoverage)
// are scope creep for a single-select seed-a-Style-Bible search. `mode`'s
// options key is Inspo's own field name; `screenMode` is the search request's
// field name for it (renamed there since `mode` is the schema's discriminator).
const INSPO_FILTER_CATEGORIES: { optionsKey: 'style' | 'industry' | 'mode' | 'vibe'; selectedKey: 'style' | 'industry' | 'screenMode' | 'vibe'; label: string }[] = [
  { optionsKey: 'style', selectedKey: 'style', label: 'Style' },
  { optionsKey: 'industry', selectedKey: 'industry', label: 'Industry' },
  { optionsKey: 'mode', selectedKey: 'screenMode', label: 'Mode' },
  { optionsKey: 'vibe', selectedKey: 'vibe', label: 'Vibe' },
];

function InspoResultCard({ result, onClick }: { result: InspoResultItem; onClick: () => void }) {
  return (
    <button
      type="button"
      className="btn"
      onClick={onClick}
      style={{ textAlign: 'left', display: 'flex', gap: 10, alignItems: 'center', width: '100%' }}
    >
      {result.thumbnailUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={result.thumbnailUrl}
          alt={result.title ?? result.slug}
          style={{ width: 48, height: 36, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--border)', flexShrink: 0 }}
          onError={e => { e.currentTarget.style.display = 'none'; }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{result.title ?? result.slug}</div>
        {result.northstar && (
          <div style={{ fontSize: 12, color: 'var(--ink-dim)', marginTop: 2 }}>{result.northstar}</div>
        )}
        {result.palette.length > 0 && (
          <div style={{ display: 'flex', gap: 3, marginTop: 4 }}>
            {result.palette.slice(0, 5).map((color, i) => (
              <div key={i} style={{ width: 14, height: 14, borderRadius: 3, border: '1px solid var(--border)', background: color }} />
            ))}
          </div>
        )}
      </div>
    </button>
  );
}

export default function StylesPage() {
  const { styles, loading, error: stylesError, refresh } = useStyles();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [forkingId, setForkingId] = useState<string | null>(null);
  const [forkError, setForkError] = useState<string | null>(null);
  const [importName, setImportName] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const [inspoMode, setInspoMode] = useState<'search' | 'recommend'>('search');

  const [inspoFilterOptions, setInspoFilterOptions] = useState<{ style: string[]; industry: string[]; mode: string[]; vibe: string[] } | null>(null);
  const [inspoSelectedFilters, setInspoSelectedFilters] = useState<{ style: string | null; industry: string | null; screenMode: string | null; vibe: string | null }>({
    style: null,
    industry: null,
    screenMode: null,
    vibe: null,
  });

  const [inspoQuery, setInspoQuery] = useState('');
  const [inspoResults, setInspoResults] = useState<InspoResultItem[]>([]);
  const [inspoSearching, setInspoSearching] = useState(false);
  const [inspoSearchError, setInspoSearchError] = useState<string | null>(null);

  const [inspoBrief, setInspoBrief] = useState('');
  const [inspoRecommending, setInspoRecommending] = useState(false);
  const [inspoRecommendError, setInspoRecommendError] = useState<string | null>(null);
  const [inspoRecommendPick, setInspoRecommendPick] = useState<{ label: string; rationale: string } | null>(null);
  const [inspoExemplars, setInspoExemplars] = useState<InspoResultItem[]>([]);

  const [inspoSelectedSlug, setInspoSelectedSlug] = useState<string | null>(null);
  const [inspoPreview, setInspoPreview] = useState<{ tokens: Record<string, string>; provenance: Record<string, string>; lowConfidence: boolean } | null>(null);
  const [inspoPreviewLoading, setInspoPreviewLoading] = useState(false);
  const [inspoPreviewError, setInspoPreviewError] = useState<string | null>(null);
  const [inspoImportName, setInspoImportName] = useState('');
  const [inspoImporting, setInspoImporting] = useState(false);
  const [inspoImportError, setInspoImportError] = useState<string | null>(null);
  // Guard against out-of-order preview responses. A monotonic id per request, not the slug
  // value: comparing by slug alone lets a stale response win when the SAME slug is clicked
  // twice in a row (double-click / click-away-and-back) and the first request resolves last.
  const requestIdRef = useRef(0);
  // Separate counter for recommend calls — a user can re-submit a brief before the previous
  // one resolves. Kept independent from requestIdRef so a recommend call in flight can't
  // invalidate an unrelated, still-pending preview request (and vice versa).
  const inspoRecommendRequestIdRef = useRef(0);

  // One-time fetch on mount to populate the filter chip categories. No stale-response guard
  // needed (unlike search/preview/recommend, this fires exactly once and is never re-triggered
  // by user action) — just a mount-guard so an unmounted component doesn't get a late setState.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/inspo/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'filters' }),
        });
        const body = await res.json();
        if (cancelled || !body.success) return;
        setInspoFilterOptions({
          style: Array.isArray(body.data?.style) ? body.data.style.filter((v: unknown) => typeof v === 'string') : [],
          industry: Array.isArray(body.data?.industry) ? body.data.industry.filter((v: unknown) => typeof v === 'string') : [],
          mode: Array.isArray(body.data?.mode) ? body.data.mode.filter((v: unknown) => typeof v === 'string') : [],
          vibe: Array.isArray(body.data?.vibe) ? body.data.vibe.filter((v: unknown) => typeof v === 'string') : [],
        });
      } catch {
        // Filter chips are a progressive enhancement — silently degrade to no chips.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch('/api/styles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const body = await res.json();
      if (!body.success) {
        setCreateError(body.error ?? 'Could not create Style Bible.');
        return;
      }
      setName('');
      await refresh();
    } catch {
      setCreateError('Could not reach the server.');
    } finally {
      setCreating(false);
    }
  }

  function handleImportFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setImportFile(e.target.files?.[0] ?? null);
    setImportError(null);
  }

  async function handleImport(e: React.FormEvent) {
    e.preventDefault();
    if (!importName.trim() || !importFile || importing) return;
    setImporting(true);
    setImportError(null);
    try {
      const tokensJson = await importFile.text();
      const res = await fetch('/api/styles/import-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: importName.trim(), tokensJson }),
      });
      const body = await res.json();
      if (!body.success) {
        setImportError(body.error ?? 'Import failed.');
        return;
      }
      setImportName('');
      setImportFile(null);
      await refresh();
    } catch {
      setImportError('Could not reach the server.');
    } finally {
      setImporting(false);
    }
  }

  async function handleFork(styleId: string) {
    setForkingId(styleId);
    setForkError(null);
    try {
      const res = await fetch(`/api/styles/${styleId}/fork`, { method: 'POST' });
      const body = await res.json();
      if (!body.success) {
        setForkError(body.error ?? 'Could not fork this Style Bible.');
        return;
      }
      await refresh();
    } catch {
      setForkError('Could not reach the server.');
    } finally {
      setForkingId(null);
    }
  }

  async function handleInspoSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!inspoQuery.trim() || inspoSearching) return;
    setInspoSearching(true);
    setInspoSearchError(null);
    setInspoResults([]);
    try {
      const res = await fetch('/api/inspo/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'search',
          query: inspoQuery.trim(),
          ...(inspoSelectedFilters.style ? { style: inspoSelectedFilters.style } : {}),
          ...(inspoSelectedFilters.industry ? { industry: inspoSelectedFilters.industry } : {}),
          ...(inspoSelectedFilters.screenMode ? { screenMode: inspoSelectedFilters.screenMode } : {}),
          ...(inspoSelectedFilters.vibe ? { vibe: inspoSelectedFilters.vibe } : {}),
        }),
      });
      const body = await res.json();
      if (!body.success) {
        setInspoSearchError(body.error ?? 'Search failed.');
        return;
      }
      const rawResults = Array.isArray(body.data?.results) ? body.data.results : [];
      setInspoResults(
        rawResults
          .map((r: any) => toInspoResultItem(r, body.data?.images))
          .filter((item: InspoResultItem) => isValidInspoSlug(item.slug))
      );
    } catch {
      setInspoSearchError('Could not reach the server.');
    } finally {
      setInspoSearching(false);
    }
  }

  async function handleInspoRecommend(e: React.FormEvent) {
    e.preventDefault();
    if (!inspoBrief.trim() || inspoRecommending) return;
    const myRequestId = ++inspoRecommendRequestIdRef.current;
    setInspoRecommending(true);
    setInspoRecommendError(null);
    setInspoRecommendPick(null);
    setInspoExemplars([]);
    try {
      const res = await fetch('/api/inspo/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'recommend', brief: inspoBrief.trim() }),
      });
      const body = await res.json();
      if (!body.success) {
        setInspoRecommendError(body.error ?? 'Recommend failed.');
        return;
      }
      // Same out-of-order guard as handleInspoPreview: only apply if this is still the
      // most recent recommend request (the user can re-submit a brief before this resolves).
      if (myRequestId === inspoRecommendRequestIdRef.current) {
        const pick = body.data?.pick;
        const label = pick?.macrostructure?.label;
        setInspoRecommendPick(
          typeof label === 'string'
            ? { label, rationale: typeof pick?.rationale === 'string' ? pick.rationale : '' }
            : null
        );
        const rawExemplars = Array.isArray(body.data?.exemplars) ? body.data.exemplars : [];
        setInspoExemplars(
          rawExemplars
            .map((r: any) => toInspoResultItem(r, body.data?.images))
            .filter((item: InspoResultItem) => isValidInspoSlug(item.slug))
        );
      }
    } catch {
      if (myRequestId === inspoRecommendRequestIdRef.current) {
        setInspoRecommendError('Could not reach the server.');
      }
    } finally {
      if (myRequestId === inspoRecommendRequestIdRef.current) {
        setInspoRecommending(false);
      }
    }
  }

  async function handleInspoPreview(slug: string) {
    const myRequestId = ++requestIdRef.current;
    setInspoSelectedSlug(slug);
    setInspoPreview(null);
    setInspoPreviewError(null);
    setInspoPreviewLoading(true);
    try {
      const res = await fetch('/api/inspo/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const body = await res.json();
      if (!body.success) {
        setInspoPreviewError(body.error ?? 'Preview failed.');
        return;
      }
      // Guard against out-of-order responses: only apply if this is still the most recent
      // request. Comparing by request id (not slug) also catches a same-slug double-click —
      // the slug alone wouldn't change between the two requests, but the id does.
      if (myRequestId === requestIdRef.current) {
        setInspoPreview(body.data);
        setInspoImportName(slug);
      }
    } catch {
      // Same out-of-order guard as the success path: an older, slower
      // request's failure shouldn't show an error for the current selection.
      if (myRequestId === requestIdRef.current) {
        setInspoPreviewError('Could not reach the server.');
      }
    } finally {
      // Same guard: don't let a stale request clear the loading flag while a
      // newer request is still genuinely pending.
      if (myRequestId === requestIdRef.current) {
        setInspoPreviewLoading(false);
      }
    }
  }

  async function handleInspoImport(e: React.FormEvent) {
    e.preventDefault();
    if (!inspoImportName.trim() || !inspoPreview || !inspoSelectedSlug || inspoImporting) return;
    setInspoImporting(true);
    setInspoImportError(null);
    try {
      const res = await fetch('/api/styles/import-inspo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: inspoImportName.trim(),
          slug: inspoSelectedSlug,
          tokens: inspoPreview.tokens,
          provenance: inspoPreview.provenance,
          lowConfidence: inspoPreview.lowConfidence,
        }),
      });
      const body = await res.json();
      if (!body.success) {
        setInspoImportError(body.error ?? 'Import failed.');
        return;
      }
      setInspoPreview(null);
      setInspoSelectedSlug(null);
      setInspoResults([]);
      setInspoExemplars([]);
      setInspoQuery('');
      setInspoBrief('');
      setInspoImportName('');
      // Invalidate any recommend request still in flight, same as requestIdRef guards
      // preview — otherwise its late response could repopulate the pick/exemplars right
      // after the user just completed an import and the panel was supposed to be clean.
      ++inspoRecommendRequestIdRef.current;
      setInspoRecommendPick(null);
      setInspoRecommendError(null);
      await refresh();
    } catch {
      setInspoImportError('Could not reach the server.');
    } finally {
      setInspoImporting(false);
    }
  }

  return (
    <>
      <h1 className="page-title">Style Bibles</h1>
      <p className="page-subtitle">
        A Style Bible is the visual language every generation in it shares. Only its creator can edit one —
        anyone else forks it into their own independent copy.
      </p>

      <form className="card" onSubmit={handleCreate} style={{ marginBottom: 32, maxWidth: 420, display: 'flex', gap: 10 }}>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="New Style Bible name"
          style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '9px 11px' }}
        />
        <button className="btn btn-primary" type="submit" disabled={creating || !name.trim()}>
          {creating ? 'Creating…' : 'Create'}
        </button>
      </form>
      {createError && (
        <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: -16, marginBottom: 16 }}>
          {createError} {createError === 'Not logged in' && <Link href="/login?reason=expired">Log in again</Link>}
        </p>
      )}

      <form className="card" onSubmit={handleImport} style={{ marginBottom: 32, maxWidth: 420 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Import from design tokens</div>
        <p style={{ color: 'var(--ink-dim)', fontSize: 13, marginBottom: 12 }}>
          Upload a W3C Design Tokens JSON file (the format most Figma-to-code plugins export) to seed a new
          Style Bible from an existing design system.
        </p>
        <div className="field">
          <label htmlFor="importName">New Style Bible name</label>
          <input id="importName" value={importName} onChange={e => setImportName(e.target.value)} placeholder="Imported design" />
        </div>
        <div className="field">
          <label htmlFor="importFile">Tokens JSON file</label>
          <input id="importFile" type="file" accept="application/json,.json" onChange={handleImportFileChange} />
        </div>
        {importError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{importError}</p>}
        <button className="btn btn-primary" type="submit" disabled={importing || !importName.trim() || !importFile}>
          {importing ? 'Importing…' : 'Import'}
        </button>
      </form>

      <div className="card" style={{ marginBottom: 32, maxWidth: 480 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Import from Inspo</div>
        <p style={{ color: 'var(--ink-dim)', fontSize: 13, marginBottom: 12 }}>
          Search 832 real production sites and seed a new Style Bible from one of their extracted
          design tokens.
        </p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button type="button" className={inspoMode === 'search' ? 'btn btn-primary' : 'btn'} onClick={() => setInspoMode('search')}>
            Search
          </button>
          <button type="button" className={inspoMode === 'recommend' ? 'btn btn-primary' : 'btn'} onClick={() => setInspoMode('recommend')}>
            Describe what you want
          </button>
        </div>

        {inspoMode === 'search' && inspoFilterOptions && (
          <div style={{ marginBottom: 12 }}>
            {INSPO_FILTER_CATEGORIES.map(({ optionsKey, selectedKey, label }) => (
              <div key={optionsKey} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginBottom: 4 }}>{label}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {inspoFilterOptions[optionsKey].map(value => (
                    <button
                      key={value}
                      type="button"
                      className={inspoSelectedFilters[selectedKey] === value ? 'btn btn-primary' : 'btn'}
                      style={{ padding: '4px 10px', fontSize: 12 }}
                      onClick={() => setInspoSelectedFilters(prev => ({
                        ...prev,
                        [selectedKey]: prev[selectedKey] === value ? null : value,
                      }))}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {inspoMode === 'search' ? (
          <>
            <form onSubmit={handleInspoSearch} style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
              <input
                value={inspoQuery}
                onChange={e => setInspoQuery(e.target.value)}
                placeholder="e.g. warm editorial SaaS"
                style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '9px 11px' }}
              />
              <button className="btn btn-primary" type="submit" disabled={inspoSearching || !inspoQuery.trim()}>
                {inspoSearching ? 'Searching…' : 'Search'}
              </button>
            </form>
            {inspoSearchError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{inspoSearchError}</p>}

            {inspoResults.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                {inspoResults.map(r => (
                  <InspoResultCard key={r.slug} result={r} onClick={() => handleInspoPreview(r.slug)} />
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <form onSubmit={handleInspoRecommend} style={{ marginBottom: 12 }}>
              <div className="field">
                <label htmlFor="inspoBrief">Describe what you want</label>
                <textarea
                  id="inspoBrief"
                  value={inspoBrief}
                  onChange={e => setInspoBrief(e.target.value)}
                  placeholder="e.g. a calm, trustworthy banking landing page hero"
                  rows={3}
                  maxLength={5000}
                />
              </div>
              <button className="btn btn-primary" type="submit" disabled={inspoRecommending || !inspoBrief.trim()}>
                {inspoRecommending ? 'Thinking…' : 'Get recommendation'}
              </button>
            </form>
            {inspoRecommendError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{inspoRecommendError}</p>}

            {inspoRecommendPick && (
              <p style={{ fontSize: 13, marginBottom: 8 }}>
                <strong>{inspoRecommendPick.label}</strong>
                {inspoRecommendPick.rationale ? ` — ${inspoRecommendPick.rationale}` : ''}
              </p>
            )}

            {inspoExemplars.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                {inspoExemplars.map(r => (
                  <InspoResultCard key={r.slug} result={r} onClick={() => handleInspoPreview(r.slug)} />
                ))}
              </div>
            )}
          </>
        )}

        {inspoPreviewLoading && <p style={{ fontSize: 13, color: 'var(--ink-dim)' }}>Loading preview…</p>}
        {inspoPreviewError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{inspoPreviewError}</p>}

        {inspoPreview && (
          <div style={{ marginTop: 8 }}>
            {inspoPreview.lowConfidence && (
              <p style={{ color: 'var(--reject)', fontSize: 12, marginBottom: 8 }}>
                Low-confidence import — most fields fell back to defaults. Check the swatches below.
              </p>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              {Object.entries(inspoPreview.tokens).map(([field, value]) => (
                <div key={field} style={{ fontSize: 11 }}>
                  <div
                    style={{
                      width: 28, height: 28, borderRadius: 4, border: '1px solid var(--border)',
                      background: field.startsWith('color') ? value : 'var(--bg)',
                    }}
                    title={`${field}: ${value} (${inspoPreview.provenance[field] ?? 'unknown'})`}
                  />
                  <div style={{ color: 'var(--ink-faint)' }}>{field}</div>
                </div>
              ))}
            </div>
            <form onSubmit={handleInspoImport} style={{ display: 'flex', gap: 10 }}>
              <input
                value={inspoImportName}
                onChange={e => setInspoImportName(e.target.value)}
                placeholder="New Style Bible name"
                style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '9px 11px' }}
              />
              <button className="btn btn-primary" type="submit" disabled={inspoImporting || !inspoImportName.trim()}>
                {inspoImporting ? 'Importing…' : 'Confirm Import'}
              </button>
            </form>
            {inspoImportError && <p style={{ color: 'var(--reject)', fontSize: 13, marginTop: 8 }}>{inspoImportError}</p>}
          </div>
        )}
      </div>

      {stylesError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{stylesError}</p>}
      {forkError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{forkError}</p>}

      {!loading && !stylesError && styles.length === 0 ? (
        <div className="empty-state">No Style Bibles yet. Create the first one above.</div>
      ) : (
        <div className="grid">
          {styles.map(style => {
            const parent = style.forked_from ? styles.find(s => s.id === style.forked_from) : null;
            return (
              <div key={style.id} className="card">
                <div className="frame-label" style={{ marginBottom: 8 }}>
                  {style.id.slice(0, 8)}
                </div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>{style.name}</div>
                {style.forked_from && (
                  <div style={{ fontSize: 12, color: 'var(--ink-faint)', marginBottom: 12 }}>
                    forked from {parent ? parent.name : style.forked_from.slice(0, 8)}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: style.forked_from ? 0 : 12 }}>
                  <Link className="btn" href={`/dashboard/styles/${style.id}`}>
                    View
                  </Link>
                  <button
                    className="btn"
                    disabled={forkingId === style.id}
                    onClick={() => handleFork(style.id)}
                  >
                    {forkingId === style.id ? 'Forking…' : 'Fork'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
