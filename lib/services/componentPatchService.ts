import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { assetService } from '@/lib/services/AssetService';
import { getComponentGenerator } from '@/lib/services/ComponentGenerator';
import type { OllamaProviderOverride } from '@/lib/services/ollamaToolCall';
import { parseComponentHtml, combineComponentHtml, type ComponentTokens } from '@/lib/services/componentDocument';
import { sanitizeComponentHtml, sanitizeComponentCss, assignElementIds } from '@/lib/services/componentSanitize';
import {
  findElementByDataGfId,
  replaceElementByDataGfId,
  maxDataGfId,
  hashDocument,
} from '@/lib/services/componentElementTree';

export type PatchError =
  | { code: 'COMPONENT_NOT_FOUND' }
  | { code: 'ELEMENT_NOT_FOUND' }
  | { code: 'ELEMENT_CHANGED' }
  | { code: 'SANITIZE_REJECTED'; message: string }
  | { code: 'CONFLICT' }
  | { code: 'WRITE_FAILED'; message: string };

export interface PatchResult {
  ok: true;
  idMap: { rootId: string; newDescendantIds: string[] };
  newDocumentHash: string;
}

// One mutex per filename, in-process only. Sufficient for a single Node process (next dev /
// single-instance next start); if GameForge ever runs multiple instances behind a load balancer,
// this stops being sufficient and CONFLICT silently degrades to last-writer-wins.
// ponytail: the map entry per filename is never removed, but growth is bounded by the number of
// distinct component files ever created (all of which already exist as real files on disk) — not
// an unbounded leak. Add cleanup if that assumption changes.
const fileLocks = new Map<string, Promise<void>>();

async function withFileLock<T>(filename: string, fn: () => Promise<T>): Promise<T> {
  const prior = fileLocks.get(filename) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  fileLocks.set(filename, prior.then(() => next));
  await prior;
  try {
    return await fn();
  } finally {
    release();
  }
}

const RAW_MARKER_PATTERN = /<\/(body|head|style)>/i;

export async function applyElementPatch(params: {
  filename: string; // storage/components/<filename>, already validated by the caller
  assetId: string; // for assetService.update's history recording
  requestingUserId: string;
  isAdmin: boolean;
  dataGfId: string;
  documentHash: string; // the client-sent revision hash to verify against
  instruction: string;
  styleId: string;
  signal?: AbortSignal;
  providerOverride?: OllamaProviderOverride;
}): Promise<PatchResult | { ok: false; error: PatchError }> {
  const filePath = path.join(getProjectRoot(), 'storage', 'components', params.filename);

  // Reads the stored file, verifies it against the client-sent revision hash, and parses it into
  // {html, css} tokens — the exact three steps both the unlocked pre-check and the locked re-check
  // need, in the same order, so there's one place to get the error-mapping right rather than two.
  // Neither a non-ENOENT fs error (EACCES, EBUSY — plausible on Windows) nor a parse failure is
  // allowed to throw out of this function: a component file on disk isn't guaranteed to still be
  // combineComponentHtml's shape (GameForge's reverse-sync feature, PR #22, can overwrite it with
  // hand-edited content that's missing a <style> or <body> section), and every error path here
  // must return a PatchError, never an unhandled rejection reaching the route handler.
  async function readVerifiedTokens(): Promise<
    { ok: true; tokens: ComponentTokens } | { ok: false; error: PatchError }
  > {
    let doc: string | null;
    try {
      doc = await fsPromises.readFile(filePath, 'utf-8');
    } catch (e: any) {
      if (e.code === 'ENOENT') return { ok: false, error: { code: 'COMPONENT_NOT_FOUND' } };
      return { ok: false, error: { code: 'WRITE_FAILED', message: e?.message ?? 'Failed to read the stored component file.' } };
    }
    if (hashDocument(doc) !== params.documentHash) {
      return { ok: false, error: { code: 'ELEMENT_CHANGED' } };
    }
    try {
      return { ok: true, tokens: parseComponentHtml(doc) };
    } catch (e: any) {
      return { ok: false, error: { code: 'WRITE_FAILED', message: e?.message ?? 'Stored component file is not a valid component document.' } };
    }
  }

  // Phase 1: cheap, unlocked pre-check — fail fast on a stale selection or a missing element
  // before spending an AI call. Not a replacement for the locked re-check below (the document can
  // still change during the AI call itself), just an optimization to avoid wasting inference.
  const preCheck = await readVerifiedTokens();
  if (!preCheck.ok) return preCheck;

  const located = findElementByDataGfId(preCheck.tokens.html, params.dataGfId);
  if (!located.found) return { ok: false, error: { code: 'ELEMENT_NOT_FOUND' } };

  const gfClass = `gf-${params.dataGfId}`;
  const currentDeclarations = extractDeclarationsForClass(preCheck.tokens.css, gfClass);

  // AI call — deliberately outside the mutex; nothing here touches the file.
  let patched;
  try {
    patched = await getComponentGenerator().patchElement(
      located.outerHtml,
      params.instruction,
      currentDeclarations,
      params.styleId,
      params.signal,
      params.providerOverride,
    );
  } catch (e: any) {
    return { ok: false, error: { code: 'SANITIZE_REJECTED', message: e?.message ?? 'Element patch generation failed.' } };
  }

  return withFileLock(params.filename, async () => {
    // Phase 2: locked re-check — the document may have changed during the AI call.
    const reCheck = await readVerifiedTokens();
    if (!reCheck.ok) return reCheck;
    const tokens = reCheck.tokens;

    const reLocated = findElementByDataGfId(tokens.html, params.dataGfId);
    if (!reLocated.found) return { ok: false, error: { code: 'ELEMENT_NOT_FOUND' } };

    if (RAW_MARKER_PATTERN.test(patched.html)) {
      return { ok: false, error: { code: 'SANITIZE_REJECTED', message: 'Patch contains a disallowed marker sequence.' } };
    }

    let sanitizedHtml: string;
    try {
      sanitizedHtml = sanitizeComponentHtml(patched.html);
    } catch (e: any) {
      return { ok: false, error: { code: 'SANITIZE_REJECTED', message: e.message } };
    }
    if (!sanitizedHtml.trim()) {
      return { ok: false, error: { code: 'SANITIZE_REJECTED', message: 'Patch sanitized to nothing.' } };
    }

    // Seeded from max(existing data-gf-id) across the WHOLE freshly-read document, not just the
    // patch fragment — ids must stay unique document-wide, not just within this one patch.
    const startAt = maxDataGfId(tokens.html) + 1;
    let idAssignedFragment: string;
    try {
      idAssignedFragment = assignElementIds(sanitizedHtml, { preserveRootId: params.dataGfId, startAt });
    } catch (e: any) {
      // Thrown when the sanitized fragment isn't exactly one root element (assignElementIds'
      // preserveRootId mode requires it) — the brief's reference code didn't guard this call, but
      // an uncaught throw here would violate "every error path returns a PatchError."
      return { ok: false, error: { code: 'SANITIZE_REJECTED', message: e?.message ?? 'Patch fragment must be exactly one root element.' } };
    }

    // Ensure the fragment's root carries the gf-<id> class (added on first patch, reused after).
    const withClass = ensureClassOnRoot(idAssignedFragment, gfClass);

    let newCss = tokens.css;
    if (patched.cssDeclarations !== null) {
      let sanitizedRule: string;
      try {
        sanitizedRule = sanitizeComponentCss(`.${gfClass} { ${patched.cssDeclarations} }`);
      } catch (e: any) {
        return { ok: false, error: { code: 'SANITIZE_REJECTED', message: e.message } };
      }
      newCss = replaceOrAppendRuleForClass(tokens.css, gfClass, sanitizedRule);
    }

    let newHtml: string;
    try {
      newHtml = replaceElementByDataGfId(tokens.html, params.dataGfId, withClass);
    } catch (e: any) {
      return { ok: false, error: { code: 'ELEMENT_NOT_FOUND' } };
    }

    const combined = combineComponentHtml({ html: newHtml, css: newCss });

    // Round-trip assertion — postcondition backstop for the raw-marker check above: catches any
    // way the recombined document ends up corrupting the next indexOf-based parse, without having
    // to reason precisely about every serializer's escaping guarantees.
    const roundTripped = parseComponentHtml(combined);
    if (roundTripped.html !== newHtml || roundTripped.css !== newCss) {
      return { ok: false, error: { code: 'SANITIZE_REJECTED', message: 'Patch failed document round-trip validation.' } };
    }

    try {
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      await fsPromises.writeFile(filePath, combined);
    } catch (e: any) {
      return { ok: false, error: { code: 'WRITE_FAILED', message: e.message } };
    }

    // Best-effort history bookkeeping: the patch itself already succeeded and is on disk (the
    // actual source of truth the client re-fetches), so a failure recording it against the asset's
    // prompt history is logged, not fatal — there's no PatchError code for it, and by design the
    // caller (Tasks 9-10) is expected to have already authorized requestingUserId against this same
    // asset before ever reaching this function.
    try {
      const asset = await assetService.getById(params.assetId);
      const existingPrompt = asset?.prompt ?? '';
      const updateResult = await assetService.update(
        params.assetId,
        params.requestingUserId,
        { prompt: `${existingPrompt}\n\nPatch: ${params.instruction}` },
        params.isAdmin,
      );
      if ('error' in updateResult) {
        console.error(`applyElementPatch: failed to record patch history on asset ${params.assetId}: ${updateResult.error}`);
      }
    } catch (e) {
      console.error(`applyElementPatch: failed to record patch history on asset ${params.assetId}:`, e);
    }

    const newDescendantIds = [...idAssignedFragment.matchAll(/data-gf-id="(\d+)"/g)]
      .map((m) => m[1])
      .filter((id) => id !== params.dataGfId);

    return {
      ok: true,
      idMap: { rootId: params.dataGfId, newDescendantIds },
      newDocumentHash: hashDocument(combined),
    };
  });
}

// Extracts the raw declaration text inside `.gf-<n> { ... }` from a stylesheet, or null if no
// such rule exists yet. Simple string extraction (not a full postcss walk) is sufficient here
// since sanitizeComponentCss already guarantees the stored CSS is well-formed. Safe against regex
// injection from className because className is always `gf-<dataGfId>`, and dataGfId only reaches
// here after findElementByDataGfId found a live match — the stored document's own ids are always
// plain digit strings assigned by assignElementIds, so a match can only occur for a digit string.
function extractDeclarationsForClass(css: string, className: string): string | null {
  const match = css.match(new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`));
  return match ? match[1].trim() : null;
}

function replaceOrAppendRuleForClass(css: string, className: string, newRule: string): string {
  const pattern = new RegExp(`\\.${className}\\s*\\{[^}]*\\}`);
  if (pattern.test(css)) return css.replace(pattern, newRule);
  return `${css}\n${newRule}`;
}

function ensureClassOnRoot(html: string, className: string): string {
  // html is a single-root fragment (assignElementIds' preserveRootId mode already enforces this).
  const match = html.match(/^<([a-zA-Z0-9]+)([^>]*)>/);
  if (!match) return html;
  const [full, tag, attrs] = match;
  const classMatch = attrs.match(/class="([^"]*)"/);
  if (classMatch) {
    if (classMatch[1].split(/\s+/).includes(className)) return html; // already present
    const newAttrs = attrs.replace(/class="([^"]*)"/, `class="$1 ${className}"`);
    return html.replace(full, `<${tag}${newAttrs}>`);
  }
  return html.replace(full, `<${tag}${attrs} class="${className}">`);
}
