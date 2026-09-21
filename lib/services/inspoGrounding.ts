import crypto from 'crypto';
import { DatabaseConnection } from '@/lib/database';
import { InspoReferenceCacheSchema, type InspoReferenceCache } from '@/lib/database/schema';
import { getInspoBaseUrl, findComponents, INSPO_TYPE_FOR_COMPONENT_TYPE } from '@/lib/services/inspoClient';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A short, deterministic hash of a Style Bible's colorAccent, used as part of the cache key so an accent change naturally misses old entries instead of needing explicit invalidation. */
export function hashAccentColor(colorAccent: string): string {
  return crypto.createHash('sha256').update(colorAccent).digest('hex').slice(0, 8);
}

/**
 * Resolves a (possibly relative) Inspo-supplied URL against INSPO_BASE_URL
 * and validates it's same-origin http(s) before any caller fetches it.
 * Returns null for anything that fails the check — a relative path is
 * always safe by construction (resolving against the configured base
 * can't produce a cross-origin URL); an already-absolute URL must match
 * INSPO_BASE_URL's origin exactly.
 */
export function resolveAndValidateUrl(url: string): string | null {
  let base: URL;
  let resolved: URL;
  try {
    base = new URL(getInspoBaseUrl());
    resolved = new URL(url, base);
  } catch {
    return null;
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
  if (resolved.origin !== base.origin) return null;
  return resolved.toString();
}

/** Looks up a fresh (within CACHE_TTL_MS) cached reference row, or null on a miss/stale row. Does not itself validate the stored image_url — callers must still run it through resolveAndValidateUrl before fetching, since the row could predate an INSPO_BASE_URL change. */
export function lookupCachedReference(styleId: string, componentType: string, accentHash: string): InspoReferenceCache | null {
  const db = DatabaseConnection.getInstance();
  const row = db.prepare(`
    SELECT * FROM inspo_reference_cache WHERE style_id = ? AND component_type = ? AND accent_hash = ?
  `).get(styleId, componentType, accentHash);
  if (!row) return null;
  const parsed = InspoReferenceCacheSchema.parse(row);
  if (Date.now() - parsed.fetched_at > CACHE_TTL_MS) return null;
  return parsed;
}

/** Deletes a cache row outright — used when its stored URL fails the SSRF/origin check on read (e.g. after a self-host base-URL change), so grounding doesn't keep retrying a dead entry every call. */
export function deleteCachedReference(styleId: string, componentType: string, accentHash: string): void {
  const db = DatabaseConnection.getInstance();
  db.prepare('DELETE FROM inspo_reference_cache WHERE style_id = ? AND component_type = ? AND accent_hash = ?').run(styleId, componentType, accentHash);
}

export interface GroundingCandidate {
  imageUrl: string;
  fallback: boolean;
  colorMatched: boolean;
}

// InspoComponentResult only carries {imageUrl, fallback} — findComponents drops the raw MCP
// response's `idx` field when it builds imageUrl. Parse it back out of the same URL shape
// findComponents itself builds (`.../api/component/<slug>/<idx>`) so fallback selection can sort
// by real index instead of just "whatever order find_components returned."
function extractIdxFromUrl(url: string): number {
  const match = url.match(/\/(\d+)$/);
  return match ? parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * Calls find_components for the mapped Inspo type, preferring a color-matched
 * call first; if that rejects (the `color` parameter's real format is
 * unverified against Inspo's live schema), degrades to an unmatched call
 * rather than failing the whole grounding attempt. Selection is
 * deterministic: first non-fallback result, else the lowest-index fallback
 * result — never a random/first-returned pick.
 */
export async function selectGroundingCandidate(componentType: string, colorAccent: string, deadlineMs: number): Promise<GroundingCandidate | null> {
  const inspoType = INSPO_TYPE_FOR_COMPONENT_TYPE[componentType];
  if (!inspoType) return null;

  let colorMatched = true;
  let results;
  try {
    results = await findComponents({ type: inspoType, color: colorAccent }, deadlineMs);
  } catch {
    colorMatched = false;
    results = await findComponents({ type: inspoType }, deadlineMs);
  }

  if (results.length === 0) return null;

  const nonFallback = results.find(r => !r.fallback);
  const chosen = nonFallback ?? results.reduce((lowest, r) =>
    extractIdxFromUrl(r.imageUrl) < extractIdxFromUrl(lowest.imageUrl) ? r : lowest
  );
  return { imageUrl: chosen.imageUrl, fallback: chosen.fallback, colorMatched };
}

const MAX_CROP_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_CROP_CONTENT_TYPES: Record<string, 'image/png' | 'image/jpeg' | 'image/webp'> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/webp': 'image/webp',
};

/**
 * Downloads a crop image with a byte cap and a Content-Type allowlist —
 * rejects (never coerces) anything outside either bound, or a non-2xx
 * response. Returns null on any rejection; the caller treats that as an
 * ordinary grounding-failure case, same as a timeout or a 404.
 */
export async function downloadAndValidateCropImage(url: string, deadlineMs: number): Promise<{ base64: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deadlineMs);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch {
    clearTimeout(timeout);
    return null;
  }

  try {
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }

    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    const mediaType = ALLOWED_CROP_CONTENT_TYPES[contentType];
    if (!mediaType) {
      await res.body?.cancel().catch(() => {});
      return null;
    }

    const contentLength = Number(res.headers.get('content-length') ?? '0');
    if (contentLength > MAX_CROP_IMAGE_BYTES) {
      await res.body?.cancel().catch(() => {});
      return null;
    }

    const buffer = await res.arrayBuffer();
    clearTimeout(timeout);
    if (buffer.byteLength > MAX_CROP_IMAGE_BYTES) return null;

    return { base64: Buffer.from(buffer).toString('base64'), mediaType };
  } catch {
    clearTimeout(timeout);
    return null;
  }
}
