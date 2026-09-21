import crypto from 'crypto';
import { DatabaseConnection } from '@/lib/database';
import { InspoReferenceCacheSchema, type InspoReferenceCache } from '@/lib/database/schema';
import { getInspoBaseUrl } from '@/lib/services/inspoClient';

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
  const base = new URL(getInspoBaseUrl());
  let resolved: URL;
  try {
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
