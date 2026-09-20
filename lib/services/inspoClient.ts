// Slug shape is observational (matches what Inspo's own search results
// return as of 2026-09-20), not a fixed security policy — if real usage
// turns up legitimate slugs this rejects, widen the charset then. The
// enforcement itself is mandatory regardless of how the charset is tuned:
// every slug crosses into a URL path and (for grounding) a cache key, and
// this check is what makes that interpolation safe.
const INSPO_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidInspoSlug(s: string): boolean {
  return typeof s === 'string' && INSPO_SLUG_RE.test(s);
}

// find_components' own hard `limit` cap is 40 — bounding idx against that
// fixed cap, not a response's own self-reported result count, since a
// malicious/misbehaving response's own count field isn't a trustworthy bound.
const FIND_COMPONENTS_LIMIT = 40;

export function isValidInspoIdx(idx: number): boolean {
  return Number.isInteger(idx) && idx >= 0 && idx < FIND_COMPONENTS_LIMIT;
}

// Read lazily (matching PIXELLAB_API_KEY's lazy-getter precedent in
// ImageGenerator.ts) rather than as a module-level constant, so it's never
// evaluated before env vars land — a bare `tsx worker.ts` process doesn't
// auto-load .env.local the way `next dev` does.
export function getInspoBaseUrl(): string {
  return process.env.INSPO_BASE_URL || 'https://inspomcp.dev';
}

export class InspoHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'InspoHttpError';
    this.status = status;
  }
}

const DESIGN_MD_CACHE_TTL_MS = 10 * 60 * 1000;
const DESIGN_MD_CACHE_MAX_ENTRIES = 200;
const designMdCache = new Map<string, { content: string; fetchedAt: number }>();

function pruneDesignMdCacheIfNeeded(): void {
  if (designMdCache.size < DESIGN_MD_CACHE_MAX_ENTRIES) return;
  // Map iteration order is insertion order — the first key is the oldest.
  const oldestKey = designMdCache.keys().next().value;
  if (oldestKey !== undefined) designMdCache.delete(oldestKey);
}

const DESIGN_MD_FETCH_DEADLINE_MS = 2000;

/**
 * Fetches one site's DESIGN.md as raw markdown via Inspo's plain,
 * unauthenticated REST endpoint. Cached in-memory per process for
 * DESIGN_MD_CACHE_TTL_MS so opening the preview panel and clicking the same
 * result twice doesn't spend the shared rate-limit budget twice — staleness
 * cost is just "an extra live fetch" on a process restart, not correctness.
 */
export async function getDesignMd(slug: string): Promise<string> {
  if (!isValidInspoSlug(slug)) {
    throw new Error(`Invalid slug: ${slug}`);
  }

  const cached = designMdCache.get(slug);
  if (cached && Date.now() - cached.fetchedAt < DESIGN_MD_CACHE_TTL_MS) {
    return cached.content;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DESIGN_MD_FETCH_DEADLINE_MS);
  let res: Response;
  try {
    res = await fetch(`${getInspoBaseUrl()}/api/design/${slug}`, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new InspoHttpError(res.status, `Inspo returned ${res.status} for slug "${slug}"`);
  }

  const content = await res.text();
  pruneDesignMdCacheIfNeeded();
  designMdCache.set(slug, { content, fetchedAt: Date.now() });
  return content;
}
