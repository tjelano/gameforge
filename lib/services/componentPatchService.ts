import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import { ZodError } from 'zod';
import { parseDocument, DomUtils } from 'htmlparser2';
import type { Element as DomElement } from 'domhandler';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { assetService } from '@/lib/services/AssetService';
import { getComponentGenerator } from '@/lib/services/ComponentGenerator';
import type { ComponentDeltaResult } from '@/lib/services/ComponentGenerator';
import type { OllamaProviderOverride } from '@/lib/services/ollamaToolCall';
import type { ReferenceImagePayload } from '@/lib/services/referenceImage';
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
  | { code: 'WRITE_FAILED'; message: string }
  | { code: 'TRUSTED_CONTENT'; message: string };

export interface PatchResult {
  ok: true;
  idMap: { rootId: string; newDescendantIds: string[] };
  newDocumentHash: string;
}

export type PatchInput = { dataGfId: string; html: string; cssDeclarations: string | null };

export type ApplyPatchBufferResult =
  | { ok: true; tokens: ComponentTokens; appliedIds: string[]; newDescendantIds: string[] }
  | { ok: false; reason: 'vanished'; dataGfId: string }
  | { ok: false; reason: 'sanitize-rejected'; message: string };

/**
 * Applies a batch of id-anchored patches to `tokens` in memory, mirroring applyElementPatch's own
 * per-patch sequence (sanitize, assign fresh descendant ids, ensure the gf-<id> class, merge CSS,
 * splice) generalized to N patches applied in order. Every `dataGfId` in `patches` must already be
 * confirmed present in `tokens` by the caller BEFORE calling this (see resolveComponentRegeneration's
 * own upfront resolution step) -- a `dataGfId` that can't be found here always means an EARLIER
 * patch in this same call already removed it (a "mid-batch vanish"), not that it never existed,
 * since the caller has already ruled that out. Pure: no disk, no AI, no clock/randomness -- calling
 * it twice with the same inputs always produces the same result.
 */
export function applyPatchBuffer(tokens: ComponentTokens, patches: PatchInput[]): ApplyPatchBufferResult {
  let html = tokens.html;
  let css = tokens.css;
  const appliedIds: string[] = [];
  const newDescendantIds: string[] = [];

  for (const patch of patches) {
    const located = findElementByDataGfId(html, patch.dataGfId);
    if (!located.found) {
      return { ok: false, reason: 'vanished', dataGfId: patch.dataGfId };
    }

    if (RAW_MARKER_PATTERN.test(patch.html)) {
      return { ok: false, reason: 'sanitize-rejected', message: 'Patch contains a disallowed marker sequence.' };
    }

    let sanitizedHtml: string;
    try {
      sanitizedHtml = sanitizeComponentHtml(patch.html);
    } catch (e: any) {
      return { ok: false, reason: 'sanitize-rejected', message: e.message };
    }
    if (!sanitizedHtml.trim()) {
      return { ok: false, reason: 'sanitize-rejected', message: 'Patch sanitized to nothing.' };
    }

    // Seeded from max(existing data-gf-id) across the CURRENT buffer, recomputed before each patch
    // -- reusing a pre-batch max across multiple patches that each introduce new descendants would
    // silently produce colliding ids between patches.
    const startAt = maxDataGfId(html) + 1;
    let idAssignedFragment: string;
    try {
      idAssignedFragment = assignElementIds(sanitizedHtml, { preserveRootId: patch.dataGfId, startAt });
    } catch (e: any) {
      return { ok: false, reason: 'sanitize-rejected', message: e?.message ?? 'Patch fragment must be exactly one root element.' };
    }

    const gfClass = `gf-${patch.dataGfId}`;
    const withClass = ensureClassOnRoot(idAssignedFragment, gfClass);

    if (patch.cssDeclarations !== null) {
      let sanitizedRule: string;
      try {
        sanitizedRule = sanitizeComponentCss(`.${gfClass} { ${patch.cssDeclarations} }`);
      } catch (e: any) {
        return { ok: false, reason: 'sanitize-rejected', message: e.message };
      }
      css = replaceOrAppendRuleForClass(css, gfClass, sanitizedRule);
    }

    try {
      html = replaceElementByDataGfId(html, patch.dataGfId, withClass);
    } catch (e: any) {
      // findElementByDataGfId already confirmed this id exists and is unambiguous immediately
      // above, with nothing in between that could change `html` -- unreachable in practice, but
      // every path through this loop must return a typed result, never let an exception escape.
      return { ok: false, reason: 'sanitize-rejected', message: e?.message ?? 'Failed to apply patch.' };
    }

    appliedIds.push(patch.dataGfId);
    const thisPatchDescendantIds = [...idAssignedFragment.matchAll(/data-gf-id="(\d+)"/g)]
      .map((m) => m[1])
      .filter((id) => id !== patch.dataGfId);
    newDescendantIds.push(...thisPatchDescendantIds);
  }

  return { ok: true, tokens: { html, css }, appliedIds, newDescendantIds };
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

  // Enforced here, not just in each route, so every current and future caller of
  // applyElementPatch inherits the guard rather than relying on each one remembering to duplicate
  // it (the job-scoped patch route originally didn't — see the final-review-fix-brief).
  const asset = await assetService.getById(params.assetId);
  if (asset?.edited_externally === 1) {
    return { ok: false, error: { code: 'TRUSTED_CONTENT', message: 'Hand-edited components cannot be patched — use full regeneration instead.' } };
  }

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

    const bufferResult = applyPatchBuffer(tokens, [{ dataGfId: params.dataGfId, html: patched.html, cssDeclarations: patched.cssDeclarations }]);
    if (!bufferResult.ok) {
      if (bufferResult.reason === 'vanished') {
        // reLocated.found (checked immediately above) already confirmed this exact id exists,
        // with nothing in between that could remove it -- unreachable in practice, but every
        // outcome applyPatchBuffer can report must still be handled with a real PatchError.
        return { ok: false, error: { code: 'ELEMENT_NOT_FOUND' } };
      }
      return { ok: false, error: { code: 'SANITIZE_REJECTED', message: bufferResult.message } };
    }
    const { html: newHtml, css: newCss } = bufferResult.tokens;

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

    return {
      ok: true,
      idMap: { rootId: params.dataGfId, newDescendantIds: bufferResult.newDescendantIds },
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

function isElementNode(node: unknown): node is DomElement {
  return !!node && typeof node === 'object' && (node as { type?: string }).type === 'tag';
}

/**
 * Builds a map of every data-gf-id in `html` to its tag name and classes, for the one-shot
 * corrective retry's prompt (an id integer alone gives the model nothing to anchor a correction
 * to -- it needs both halves).
 */
function buildIdTagClassMap(html: string): Record<string, { tag: string; classes: string[] }> {
  const dom = parseDocument(html);
  const elements = DomUtils.findAll(
    (el) => isElementNode(el) && typeof el.attribs['data-gf-id'] === 'string',
    dom.children,
  ) as DomElement[];
  const map: Record<string, { tag: string; classes: string[] }> = {};
  for (const el of elements) {
    const id = el.attribs['data-gf-id'];
    map[id] = { tag: el.name, classes: (el.attribs['class'] ?? '').split(/\s+/).filter(Boolean) };
  }
  return map;
}

function buildCorrectionMessage(reason: 'unresolved-id' | 'mid-batch-vanish', offendingId: string, validIdMap: Record<string, { tag: string; classes: string[] }>): string {
  const explanation = reason === 'unresolved-id'
    ? `The element with data-gf-id="${offendingId}" does not exist in the current document.`
    : `Your patch for data-gf-id="${offendingId}" is invalid because an earlier patch in your own response removed that element before this one could be applied.`;
  return `${explanation} Here is every valid data-gf-id in the current document, with its tag and classes, to help you target correctly: ${JSON.stringify(validIdMap)}. Please resend a corrected response.`;
}

export type RegenerationResult =
  | { ok: true; filename: string }
  | { ok: false; message: string };

const PATCHES_COUNT_CAP = 20;
const PATCHES_BYTE_CAP_FRACTION = 0.5;

interface RegenerationLogEntry {
  basedOnAssetId: string;
  outcome: 'applied' | 'failed';
  failureStage?: 'final-read' | 'staleness' | 'sanitize-full' | 'ai-call';
  sourceUntrusted: boolean;
  originalMode?: 'patches' | 'full';
  appliedMode?: 'patches' | 'full';
  retryFired: boolean;
  initialRejectReason?: 'unresolved-id' | 'mid-batch-vanish';
  retryOutcome?: 'resolved' | 'still-failed';
  fallbackUsed: boolean;
  fallbackReason?: 'retry-failed' | 'sanitize-rejected' | 'cap-exceeded' | 'duplicate-id'
                 | 'empty-batch' | 'payload-too-large' | 'malformed-response' | 'unparseable-source';
  filename?: string;
  durationMs: number;
}

export async function resolveComponentRegeneration(params: {
  basedOnAssetId: string;
  basedOnContent: string;
  instruction: string;
  styleId: string;
  componentType?: string;
  referenceImage?: ReferenceImagePayload;
  signal?: AbortSignal;
  providerOverride?: OllamaProviderOverride;
}): Promise<RegenerationResult> {
  const startedAt = Date.now();
  const log: RegenerationLogEntry = {
    basedOnAssetId: params.basedOnAssetId,
    outcome: 'failed',
    sourceUntrusted: false,
    retryFired: false,
    fallbackUsed: false,
    durationMs: 0,
  };
  function finish(result: RegenerationResult): RegenerationResult {
    log.durationMs = Date.now() - startedAt;
    if (result.ok) { log.outcome = 'applied'; log.filename = result.filename; }
    console.log('resolveComponentRegeneration:', JSON.stringify(log));
    return result;
  }

  // Step 1: the snapshot to re-verify against at the end.
  const basedOnContentHash = hashDocument(params.basedOnContent);

  // Step 2: trust flag + the path source for the final recheck (step 10).
  const sourceAsset = await assetService.getById(params.basedOnAssetId);
  if (!sourceAsset || !sourceAsset.image_path
      || sourceAsset.image_path.includes('/') || sourceAsset.image_path.includes('\\') || sourceAsset.image_path.includes('..')
      || sourceAsset.output_kind !== 'component') {
    log.failureStage = 'final-read';
    return finish({ ok: false, message: 'The component this was based on could not be re-read.' });
  }
  const sourceFilePath = path.join(getProjectRoot(), 'storage', 'components', sourceAsset.image_path);
  const sourceUntrusted = sourceAsset.edited_externally === 1;
  log.sourceUntrusted = sourceUntrusted;

  async function callGenerateDelta(opts: { forceFull: boolean; correction?: string }): Promise<ComponentDeltaResult> {
    const result = await getComponentGenerator().generate(
      params.instruction, params.styleId, params.componentType, params.referenceImage,
      params.basedOnContent, params.signal, params.providerOverride, opts.correction, opts.forceFull,
    );
    return result as ComponentDeltaResult;
  }

  async function runFallback(reason: NonNullable<RegenerationLogEntry['fallbackReason']>): Promise<RegenerationResult> {
    log.fallbackUsed = true;
    log.fallbackReason = reason;
    let fallbackResult: ComponentDeltaResult;
    try {
      fallbackResult = await callGenerateDelta({ forceFull: true });
    } catch (e) {
      log.failureStage = 'ai-call';
      return finish({ ok: false, message: e instanceof Error ? e.message : 'Component regeneration failed.' });
    }
    return finalize(fallbackResult, true);
  }

  async function retryOnce(reason: 'unresolved-id' | 'mid-batch-vanish', offendingId: string, sourceTokens: ComponentTokens): Promise<RegenerationResult> {
    log.retryFired = true;
    log.initialRejectReason = reason;
    const validIdMap = buildIdTagClassMap(sourceTokens.html);
    const correction = buildCorrectionMessage(reason, offendingId, validIdMap);

    let retryResult: ComponentDeltaResult;
    try {
      retryResult = await callGenerateDelta({ forceFull: false, correction });
    } catch (e) {
      if (e instanceof ZodError) return runFallback('malformed-response');
      log.failureStage = 'ai-call';
      return finish({ ok: false, message: e instanceof Error ? e.message : 'Component regeneration failed.' });
    }
    return finalize(retryResult, true);
  }

  // Steps 4-9: resolve `result` into a final {html, css}, or route to a retry/fallback/failure.
  // `alreadyRetried` is true only on the recursive call made from `retryOnce` -- it caps the retry
  // at exactly one attempt (a second unresolved-id/vanish here goes straight to fallback).
  async function finalize(result: ComponentDeltaResult, alreadyRetried: boolean): Promise<RegenerationResult> {
    let finalTokens: ComponentTokens;

    if (result.mode === 'full') {
      if (alreadyRetried) log.retryOutcome = 'resolved';
      let html: string, css: string;
      try {
        html = assignElementIds(sanitizeComponentHtml(result.html));
        css = sanitizeComponentCss(result.css);
      } catch (e: any) {
        log.failureStage = 'sanitize-full';
        return finish({ ok: false, message: e?.message ?? 'Generated component failed validation.' });
      }
      finalTokens = { html, css };
    } else {
      let sourceTokens: ComponentTokens;
      try {
        sourceTokens = parseComponentHtml(params.basedOnContent);
      } catch {
        return runFallback('unparseable-source');
      }

      const patches = result.patches;
      if (patches.length === 0) return runFallback('empty-batch');
      if (patches.length > PATCHES_COUNT_CAP) return runFallback('cap-exceeded');
      const seenIds = new Set<string>();
      for (const p of patches) {
        if (seenIds.has(p.dataGfId)) return runFallback('duplicate-id');
        seenIds.add(p.dataGfId);
      }
      const totalBytes = patches.reduce((sum, p) => sum + p.html.length + (p.cssDeclarations?.length ?? 0), 0);
      if (totalBytes > (sourceTokens.html.length + sourceTokens.css.length) * PATCHES_BYTE_CAP_FRACTION) {
        return runFallback('payload-too-large');
      }
      const unresolved = patches.find((p) => !findElementByDataGfId(sourceTokens.html, p.dataGfId).found);
      if (unresolved) {
        if (alreadyRetried) { log.retryOutcome = 'still-failed'; return runFallback('retry-failed'); }
        return retryOnce('unresolved-id', unresolved.dataGfId, sourceTokens);
      }

      const patchInputs: PatchInput[] = patches.map((p) => ({ dataGfId: p.dataGfId, html: p.html, cssDeclarations: p.cssDeclarations ?? null }));
      const bufferResult = applyPatchBuffer(sourceTokens, patchInputs);
      if (!bufferResult.ok) {
        if (bufferResult.reason === 'sanitize-rejected') return runFallback('sanitize-rejected');
        if (alreadyRetried) { log.retryOutcome = 'still-failed'; return runFallback('retry-failed'); }
        return retryOnce('mid-batch-vanish', bufferResult.dataGfId, sourceTokens);
      }
      if (alreadyRetried) log.retryOutcome = 'resolved';
      finalTokens = bufferResult.tokens;
    }

    log.appliedMode = result.mode;

    // Step 10: the one point-in-time recheck this design performs.
    let latest: string;
    try {
      latest = await fsPromises.readFile(sourceFilePath, 'utf-8');
    } catch {
      log.failureStage = 'final-read';
      return finish({ ok: false, message: 'The component this was based on could not be re-read.' });
    }
    if (hashDocument(latest) !== basedOnContentHash) {
      log.failureStage = 'staleness';
      return finish({ ok: false, message: 'Component changed while regenerating — please try again.' });
    }
    const recheckAsset = await assetService.getById(params.basedOnAssetId);
    if ((recheckAsset?.edited_externally === 1) !== sourceUntrusted) {
      log.failureStage = 'staleness';
      return finish({ ok: false, message: 'Component changed while regenerating — please try again.' });
    }

    // Step 11: write once, no lock -- this filename cannot collide with anything else on disk.
    const filename = `component-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.html`;
    const componentsDir = path.join(getProjectRoot(), 'storage', 'components');
    try {
      await fsPromises.mkdir(componentsDir, { recursive: true });
      await fsPromises.writeFile(path.join(componentsDir, filename), combineComponentHtml(finalTokens));
    } catch (e: any) {
      return finish({ ok: false, message: e?.message ?? 'Failed to write the regenerated component.' });
    }

    return finish({ ok: true, filename });
  }

  // Step 3: choose whether patches mode is even attempted.
  let aiResult: ComponentDeltaResult;
  try {
    aiResult = await callGenerateDelta({ forceFull: sourceUntrusted });
  } catch (e) {
    if (e instanceof ZodError) return runFallback('malformed-response');
    log.failureStage = 'ai-call';
    return finish({ ok: false, message: e instanceof Error ? e.message : 'Component regeneration failed.' });
  }
  // Set only here, not generically inside finalize() -- a malformed initial response never
  // reaches this line at all (it throws above, before aiResult is ever assigned), so a
  // subsequent successful fallback correctly leaves originalMode absent rather than reporting
  // the fallback's own mode as if it had been the original response's.
  log.originalMode = aiResult.mode;

  return finalize(aiResult, false);
}
