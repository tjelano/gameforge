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

const MAX_CROP_IMAGE_REDIRECTS = 5;

/**
 * Follows redirects manually (never `fetch`'s default `redirect: 'follow'`)
 * so every hop's Location header goes back through resolveAndValidateUrl —
 * the same-origin check the caller already ran on the initial URL means
 * nothing without a redirect the origin itself would otherwise silently
 * bypass it and land somewhere unvalidated (loopback, private-network,
 * cloud metadata). Bounded by MAX_CROP_IMAGE_REDIRECTS. Returns null on an
 * invalid or excessive redirect target; a network error or abort still
 * throws and is caught by the caller.
 */
async function followValidatedRedirects(url: string, signal: AbortSignal): Promise<Response | null> {
  let currentUrl = url;
  let redirectCount = 0;
  while (true) {
    const res = await fetch(currentUrl, { signal, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return res;

    const location = res.headers.get('location');
    await res.body?.cancel().catch(() => {});
    redirectCount++;
    if (!location || redirectCount > MAX_CROP_IMAGE_REDIRECTS) return null;

    const validated = resolveAndValidateUrl(location);
    if (!validated) return null;
    currentUrl = validated;
  }
}

/**
 * Downloads a crop image with a byte cap and a Content-Type allowlist —
 * rejects (never coerces) anything outside either bound, or a non-2xx
 * response. Returns null on any rejection; the caller treats that as an
 * ordinary grounding-failure case, same as a timeout or a 404. The body is
 * read incrementally and cancelled the moment MAX_CROP_IMAGE_BYTES is
 * crossed, so a chunked or Content-Length-lying response can never buffer
 * past the cap regardless of what the header claims.
 */
export async function downloadAndValidateCropImage(url: string, deadlineMs: number): Promise<{ base64: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deadlineMs);
  let res: Response | null;
  try {
    res = await followValidatedRedirects(url, controller.signal);
  } catch {
    clearTimeout(timeout);
    return null;
  }
  if (!res) {
    clearTimeout(timeout);
    return null;
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      clearTimeout(timeout);
      return null;
    }

    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    const mediaType = ALLOWED_CROP_CONTENT_TYPES[contentType];
    if (!mediaType) {
      await res.body?.cancel().catch(() => {});
      clearTimeout(timeout);
      return null;
    }

    const contentLength = Number(res.headers.get('content-length') ?? '0');
    if (contentLength > MAX_CROP_IMAGE_BYTES) {
      await res.body?.cancel().catch(() => {});
      clearTimeout(timeout);
      return null;
    }

    reader = res.body?.getReader() ?? null;
    if (!reader) {
      clearTimeout(timeout);
      return null;
    }
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_CROP_IMAGE_BYTES) {
        await reader.cancel().catch(() => {});
        clearTimeout(timeout);
        return null;
      }
      chunks.push(value);
    }
    clearTimeout(timeout);

    const buffer = Buffer.concat(chunks.map(c => Buffer.from(c)));
    return { base64: buffer.toString('base64'), mediaType };
  } catch {
    await reader?.cancel().catch(() => {});
    clearTimeout(timeout);
    return null;
  }
}

export function upsertCachedReference(
  styleId: string, componentType: string, accentHash: string,
  imageUrl: string, isFallback: boolean, isColorMatched: boolean
): void {
  const db = DatabaseConnection.getInstance();
  db.prepare(`
    INSERT INTO inspo_reference_cache (id, style_id, component_type, accent_hash, image_url, is_fallback, is_color_matched, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (style_id, component_type, accent_hash) DO UPDATE SET
      image_url = excluded.image_url, is_fallback = excluded.is_fallback,
      is_color_matched = excluded.is_color_matched, fetched_at = excluded.fetched_at
  `).run(crypto.randomUUID(), styleId, componentType, accentHash, imageUrl, isFallback ? 1 : 0, isColorMatched ? 1 : 0, Date.now());
}

export type GroundingOutcome =
  | { grounded: true; referenceImage: { base64: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' }; referenceIsFallbackThumbnail: boolean; colorMatched: boolean }
  | { grounded: false; groundedReason: string };

const MCP_CALL_DEADLINE_MS = 2000;
const IMAGE_DOWNLOAD_DEADLINE_MS = 2000;

/**
 * The single entry point worker.ts calls. Fully fail-soft: every failure
 * mode (unmapped type, no match, timeout, SSRF rejection, oversized/wrong-
 * type download, an unexpected throw from anywhere in the chain) resolves
 * to {grounded:false, groundedReason}, never rejects. A cache row is only
 * written on a full success — a failed attempt is not negative-cached, so
 * the next generation for the same key retries normally rather than being
 * suppressed for the 7-day TTL.
 */
export async function groundComponent(params: { styleId: string; componentType: string; colorAccent: string }): Promise<GroundingOutcome> {
  try {
    const accentHash = hashAccentColor(params.colorAccent);

    const cached = lookupCachedReference(params.styleId, params.componentType, accentHash);
    if (cached) {
      const validUrl = resolveAndValidateUrl(cached.image_url);
      if (!validUrl) {
        deleteCachedReference(params.styleId, params.componentType, accentHash);
      } else {
        const image = await downloadAndValidateCropImage(validUrl, IMAGE_DOWNLOAD_DEADLINE_MS);
        if (image) {
          return {
            grounded: true, referenceImage: image,
            referenceIsFallbackThumbnail: !!cached.is_fallback,
            colorMatched: !!cached.is_color_matched,
          };
        }
        // Cached URL no longer resolves to a valid image (e.g. upstream
        // scheme change) — drop it and fall through to a fresh lookup.
        deleteCachedReference(params.styleId, params.componentType, accentHash);
      }
    }

    if (!INSPO_TYPE_FOR_COMPONENT_TYPE[params.componentType]) {
      return { grounded: false, groundedReason: 'unmapped-type' };
    }

    const candidate = await selectGroundingCandidate(params.componentType, params.colorAccent, MCP_CALL_DEADLINE_MS);
    if (!candidate) {
      return { grounded: false, groundedReason: 'no-match' };
    }

    const validUrl = resolveAndValidateUrl(candidate.imageUrl);
    if (!validUrl) {
      return { grounded: false, groundedReason: 'origin-mismatch' };
    }

    const image = await downloadAndValidateCropImage(validUrl, IMAGE_DOWNLOAD_DEADLINE_MS);
    if (!image) {
      return { grounded: false, groundedReason: 'invalid-image' };
    }

    upsertCachedReference(params.styleId, params.componentType, accentHash, validUrl, candidate.fallback, candidate.colorMatched);

    return {
      grounded: true, referenceImage: image,
      referenceIsFallbackThumbnail: candidate.fallback,
      colorMatched: candidate.colorMatched,
    };
  } catch (error) {
    console.error('Inspo grounding attempt failed unexpectedly:', error);
    return { grounded: false, groundedReason: 'error' };
  }
}
