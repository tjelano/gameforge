import crypto from 'crypto';
import { parseDocument, DomUtils } from 'htmlparser2';
import render from 'dom-serializer';
import type { Element as DomElement } from 'domhandler';

function isElement(node: unknown): node is DomElement {
  return !!node && typeof node === 'object' && (node as { type?: string }).type === 'tag';
}

function findAllByDataGfId(html: string, id: string): DomElement[] {
  const dom = parseDocument(html);
  return DomUtils.findAll(
    (el) => isElement(el) && el.attribs['data-gf-id'] === id,
    dom.children,
  ) as DomElement[];
}

export function findElementByDataGfId(
  html: string,
  id: string,
): { found: true; outerHtml: string; classes: string[] } | { found: false; ambiguous: boolean } {
  const matches = findAllByDataGfId(html, id);
  if (matches.length === 0) return { found: false, ambiguous: false };
  if (matches.length > 1) return { found: false, ambiguous: true };
  const el = matches[0];
  const classAttr = el.attribs['class'] ?? '';
  return {
    found: true,
    outerHtml: render(el),
    classes: classAttr.split(/\s+/).filter(Boolean),
  };
}

export function replaceElementByDataGfId(html: string, id: string, replacementOuterHtml: string): string {
  const dom = parseDocument(html);
  const matches = DomUtils.findAll(
    (el) => isElement(el) && el.attribs['data-gf-id'] === id,
    dom.children,
  ) as DomElement[];
  if (matches.length === 0) throw new Error(`replaceElementByDataGfId: no element with data-gf-id="${id}" found.`);
  if (matches.length > 1) throw new Error(`replaceElementByDataGfId: data-gf-id="${id}" is ambiguous (${matches.length} matches).`);

  const target = matches[0];
  const replacementDom = parseDocument(replacementOuterHtml);
  const replacementRoots = replacementDom.children.filter(isElement);
  if (replacementRoots.length !== 1) {
    throw new Error('replaceElementByDataGfId: replacement must be exactly one root element.');
  }
  const replacement = replacementRoots[0];

  const parent = target.parent;
  if (!parent) throw new Error('replaceElementByDataGfId: matched element has no parent (cannot be a document root).');
  const siblings = parent.children;
  const index = siblings.indexOf(target);
  replacement.parent = parent;
  siblings[index] = replacement;

  return render(dom);
}

export function maxDataGfId(html: string): number {
  const dom = parseDocument(html);
  const matches = DomUtils.findAll(
    (el) => isElement(el) && typeof el.attribs['data-gf-id'] === 'string',
    dom.children,
  ) as DomElement[];
  let max = 0;
  for (const el of matches) {
    const n = Number(el.attribs['data-gf-id']);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

export function stripElementIds(html: string): string {
  const dom = parseDocument(html);
  const matches = DomUtils.findAll(
    (el) => isElement(el) && typeof el.attribs['data-gf-id'] === 'string',
    dom.children,
  ) as DomElement[];
  if (matches.length === 0) return html;
  for (const el of matches) {
    delete el.attribs['data-gf-id'];
  }
  return render(dom);
}

export function hashDocument(rawBytes: string): string {
  return crypto.createHash('sha256').update(rawBytes, 'utf-8').digest('hex');
}
