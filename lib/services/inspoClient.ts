import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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
const DESIGN_MD_CACHE_MAX_SIZE_BYTES = 2 * 1024 * 1024; // 2MB, matching MAX_TOKENS_JSON_LENGTH pattern
const designMdCache = new Map<string, { content: string; fetchedAt: number }>();

function pruneDesignMdCacheIfNeeded(): void {
  if (designMdCache.size < DESIGN_MD_CACHE_MAX_ENTRIES) return;
  // Map iteration order is insertion order — the first key is the oldest.
  const oldestKey = designMdCache.keys().next().value;
  if (oldestKey !== undefined) designMdCache.delete(oldestKey);
}

export function resetDesignMdCacheForTests(): void {
  designMdCache.clear();
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
    throw new InspoHttpError(400, `Invalid slug: ${JSON.stringify(slug).slice(0, 80)}`);
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
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new InspoHttpError(504, 'Inspo request timed out');
    }
    throw err;
  }

  let content: string;
  try {
    if (!res.ok) {
      // Release socket to keep-alive pool without buffering the error body
      await res.body?.cancel().catch(() => {});
      throw new InspoHttpError(res.status, `Inspo returned ${res.status}`);
    }

    // ponytail: size limit checks the Content-Length header (not streaming byte-count),
    // with a post-read fallback for responses missing/lying about Content-Length.
    // When Content-Length is present and accurate, pre-check prevents buffering large responses.
    // When missing (e.g. Transfer-Encoding: chunked) or false, the full buffer is read before
    // post-check enforces the limit — acceptable for this known/generally-reliable API;
    // true streaming reader is the upgrade path if needed.
    const contentLength = res.headers.get('content-length');
    if (contentLength) {
      const length = parseInt(contentLength, 10);
      if (length > DESIGN_MD_CACHE_MAX_SIZE_BYTES) {
        await res.body?.cancel().catch(() => {});
        throw new InspoHttpError(413, `Inspo DESIGN.md exceeds size limit (${length} > ${DESIGN_MD_CACHE_MAX_SIZE_BYTES} bytes)`);
      }
    }

    content = await res.text();
    clearTimeout(timeout);
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new InspoHttpError(504, 'Inspo request timed out');
    }
    throw err;
  }

  // Double-check byte size in case Content-Length header was wrong/missing
  const byteLength = new TextEncoder().encode(content).length;
  if (byteLength > DESIGN_MD_CACHE_MAX_SIZE_BYTES) {
    throw new InspoHttpError(413, `Inspo DESIGN.md exceeds size limit (${byteLength} > ${DESIGN_MD_CACHE_MAX_SIZE_BYTES} bytes)`);
  }

  pruneDesignMdCacheIfNeeded();
  // Delete before set to maintain recency ordering in Map
  designMdCache.delete(slug);
  designMdCache.set(slug, { content, fetchedAt: Date.now() });
  return content;
}

// Lazily-created, per-process singleton — not a fresh connection per call.
// The initialize handshake and Mcp-Session-Id happen once and are reused
// across search/recommend/find_components calls for the process's
// lifetime, so a logical tool call costs one tools/call round trip against
// the shared rate limit in the common case, not the full 2-4-round-trip
// handshake every time.
let clientPromise: Promise<Client> | null = null;

function createClient(): Promise<Client> {
  return (async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${getInspoBaseUrl()}/api/mcp`));
    const client = new Client({ name: 'gameforge', version: '1.0.0' });
    await client.connect(transport);
    return client;
  })();
}

// A rejected connection attempt must not become a permanent tombstone: reset
// clientPromise back to null on failure so the NEXT call retries instead of
// replaying the same stale rejection for the rest of the process lifetime.
function getClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = createClient().catch(err => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

// Best-effort cleanup of a superseded client — a close() failure (socket
// already gone, etc.) is not this call's problem and must never surface.
function closeQuietly(promise: Promise<Client>): void {
  promise.then(client => client.close()).catch(() => {});
}

// Swaps in a fresh connection to replace `staleClientPromise`, closing the
// old one. Compares against the CURRENT clientPromise first: if another
// concurrent caller already performed this same swap (both hit a
// session-invalid error around the same time, off the same shared
// connection), this is a no-op and the caller just awaits the reconnect
// that's already in flight, instead of every concurrent caller opening its
// own redundant connection.
function reconnect(staleClientPromise: Promise<Client>): Promise<Client> {
  if (clientPromise === staleClientPromise) {
    closeQuietly(staleClientPromise);
    clientPromise = createClient().catch(err => {
      clientPromise = null;
      throw err;
    });
  }
  return getClient();
}

// Test-only: forces the next getClient() call to reconnect, matching what
// resetForTests()-style helpers do elsewhere in this codebase.
export function resetInspoClientForTests(): void {
  clientPromise = null;
}

// onDeadline, when given, fires right before the timeout rejection — used to
// abort the underlying request that's still running in the background
// instead of just abandoning it (see callMcpTool's `attempt`).
function withDeadline<T>(promise: Promise<T>, deadlineMs: number, onDeadline?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onDeadline?.();
      reject(new Error(`Inspo MCP call timed out after ${deadlineMs}ms`));
    }, deadlineMs);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

function isSessionInvalidError(error: unknown): boolean {
  // A gone/expired Streamable HTTP session's canonical signal is an HTTP 404
  // on POST (see client/streamableHttp.js: any non-ok POST response throws
  // `new StreamableHTTPError(response.status, ...)`), per the MCP spec's
  // session-recovery contract — the body text isn't guaranteed to mention
  // "session" at all. Check the real error shape first (the `typeof` guard
  // is just belt-and-suspenders for a non-function binding; it does NOT
  // protect against a test module-mock that omits this export entirely —
  // Vitest's mock proxy throws on that property access before `typeof` ever
  // sees a value, so any test mocking this module must export the class).
  // Keep the regex as a fallback for transports/servers that report it as a
  // plain message instead of a 404.
  if (typeof StreamableHTTPError === 'function' && error instanceof StreamableHTTPError && error.code === 404) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /session/i.test(message) && /(invalid|expired|not found)/i.test(message);
}

// Below this budget, a reconnect+retry is more likely to just fail its own
// withDeadline race than actually complete — retrying would replace a clear
// session-invalidation error with a confusing "timed out" one. Give up and
// surface the original error instead.
const MIN_RETRY_BUDGET_MS = 100;

/**
 * Calls one MCP tool by name against the shared singleton client. The whole
 * attempt (handshake-if-needed + the tools/call itself) is bounded by
 * deadlineMs. If the call fails with a session-invalid/expired error, this
 * reconnects (re-runs initialize) once and retries — inside the SAME
 * deadline, not a fresh one, since a genuinely timed-out call has already
 * exhausted its budget and isn't retried at all.
 */
export async function callMcpTool<T>(name: string, args: Record<string, unknown>, deadlineMs: number): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  const remaining = () => Math.max(0, deadline - Date.now());

  async function attempt(usedClientPromise: Promise<Client>): Promise<T> {
    const client = await withDeadline(usedClientPromise, remaining());
    // Pass an AbortSignal through to the SDK so a deadline timeout actually
    // cancels the in-flight request against the MCP server (the SDK sends a
    // cancellation notification and aborts its own wait), instead of merely
    // abandoning it while it keeps running server-side in the background.
    const controller = new AbortController();
    const result = await withDeadline(
      client.callTool({ name, arguments: args }, undefined, { signal: controller.signal }) as Promise<any>,
      remaining(),
      () => controller.abort()
    );
    const block = result?.content?.find((c: any) => c?.type === 'text');
    if (result?.isError) {
      throw new Error(`Inspo MCP tool "${name}" returned an error: ${block?.text ?? JSON.stringify(result)}`);
    }
    const text = block?.text;
    if (typeof text !== 'string') {
      throw new Error(`Inspo MCP tool "${name}" returned an unexpected shape`);
    }
    return JSON.parse(text) as T;
  }

  const firstClientPromise = getClient();
  try {
    return await attempt(firstClientPromise);
  } catch (error) {
    if (isSessionInvalidError(error) && remaining() > MIN_RETRY_BUDGET_MS) {
      const retryClientPromise = reconnect(firstClientPromise);
      return attempt(retryClientPromise);
    }
    throw error;
  }
}

// None of these four mappings is a clean match — Inspo's 10 crop types
// don't line up with GameForge's 5 component types. Button->cta is
// arguably the loosest of the four (a cta crop is typically a whole
// headline+button+image band, not an isolated button) despite being the
// most common component type; it gets no special treatment here because
// none of the mapped entries should read as more confident than another.
export const INSPO_TYPE_FOR_COMPONENT_TYPE: Record<string, string | null> = {
  Button: 'cta',
  'Nav Bar': 'nav',
  Card: 'features', // Inspo has no unified card category; features crops are often a multi-card grid
  Form: 'cta', // inline-form-as-CTA is a named archetype; no first-class Form type exists
  Other: null,
};

export interface InspoComponentResult {
  imageUrl: string;
  fallback: boolean;
}

const SEARCH_DEADLINE_MS = 3000;

export function searchScreens(args: Record<string, unknown>): Promise<unknown> {
  return callMcpTool('search_screens', args, SEARCH_DEADLINE_MS);
}

export function recommend(brief: string): Promise<unknown> {
  return callMcpTool('recommend', { brief }, SEARCH_DEADLINE_MS);
}

export function getFilters(): Promise<unknown> {
  return callMcpTool('get_filters', {}, SEARCH_DEADLINE_MS);
}

// search/recommend responses carry one top-level `images` template string
// (not a per-result image URL) shaped like:
// "https://<host>/captures/<slug>/hero.1440.webp (also full.1440, thumb.384,
// mobile.384; get_screen returns exact URLs)". To display a small thumbnail
// for a given result we substitute the real slug and swap in the smallest
// listed size. `imagesTemplate` is API-returned data, not a hardcoded
// constant, so this validates defensively rather than trusting the shape:
// fails soft (null) on anything that isn't a string containing the literal
// `/captures/` segment, that fails to parse as a well-formed https URL, or
// (the slug, also API data) that doesn't match this file's own
// isValidInspoSlug guard — the same one getDesignMd() and
// app/api/inspo/preview/route.ts already use before a slug crosses into a URL.
export function deriveThumbnailUrl(imagesTemplate: unknown, slug: string): string | null {
  if (typeof imagesTemplate !== 'string' || !isValidInspoSlug(slug)) return null;
  const marker = '/captures/';
  const markerIdx = imagesTemplate.indexOf(marker);
  if (markerIdx === -1) return null;
  const base = imagesTemplate.slice(0, markerIdx + marker.length);
  const url = `${base}${slug}/thumb.384.webp`;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return url;
}

// Real find_components response items also carry siteSlug, siteTitle,
// siteHost, width, height, label, palette, and mode — confirmed live
// 2026-09-21 — none of that is consumed downstream yet, so the interface
// stays narrowed to what's actually used.
interface RawFindComponentsResult {
  imageUrl: string;
}

/**
 * Wraps find_components: passes through the ready-to-use imageUrl for every
 * result with one present, and silently drops any that don't rather than
 * trusting a malformed/missing field. deadlineMs is the caller's to set —
 * Feature 1's UI calls use SEARCH_DEADLINE_MS-equivalent budgets, Feature
 * 2's grounding path uses a tighter one (see inspoGrounding.ts).
 */
export async function findComponents(
  args: { type: string; color?: string } & Record<string, unknown>,
  deadlineMs: number = SEARCH_DEADLINE_MS
): Promise<InspoComponentResult[]> {
  const response = await callMcpTool<{ components: RawFindComponentsResult[] }>('find_components', args, deadlineMs);
  const out: InspoComponentResult[] = [];
  // A malformed/unexpected response (components missing, null, or not an
  // array at all) is treated the same as an empty result set — fail soft,
  // matching this function's per-item silent-drop philosophy below.
  const components = Array.isArray(response?.components) ? response.components : [];
  for (const r of components) {
    // Minimal sanity guard only — real URL validation (origin/scheme) already
    // happens downstream in inspoGrounding.ts's resolveAndValidateUrl. `!r`
    // guards a null/non-object array item: `typeof r.imageUrl` throws on
    // property access before `typeof` runs if `r` itself is null/undefined.
    if (!r || typeof r.imageUrl !== 'string' || !r.imageUrl) continue;
    // Always false: find_components' live response carries no fallback/
    // full-page-thumbnail signal at all, so this is the honest current value,
    // not a placeholder. This makes selectGroundingCandidate's
    // `.find(r => !r.fallback)` always match the FIRST result immediately —
    // i.e. trust Inspo's own result ordering — which is correct behavior;
    // its lowest-index-fallback branch is unreachable given this but is
    // cheap, harmless, forward-compatible defensive code if Inspo's schema
    // ever adds a real fallback signal later.
    out.push({ imageUrl: r.imageUrl, fallback: false });
  }
  return out;
}
