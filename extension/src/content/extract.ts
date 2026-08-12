import { Readability } from "@mozilla/readability";

/**
 * Generic JD extraction. Two strategies, in order of trustworthiness:
 *
 *   1. schema.org JobPosting in JSON-LD — structured, authoritative, present
 *      on most career sites.
 *   2. Readability over the live DOM — good at finding the article body and
 *      dropping nav and footers.
 *
 * This runs in the user's own already-authenticated browser against rendered
 * HTML, which is why it reaches postings the server-side fetcher cannot.
 *
 * B2 adds purpose-written extractors for LinkedIn, Greenhouse, Lever, Ashby
 * and Workday, which take precedence over both of these.
 */

export const MIN_JD_CHARS = 300;

export interface ExtractedJD {
  text: string;
  title: string;
  company: string;
  url: string;
}

export type ExtractResult =
  | { ok: true; jd: ExtractedJD }
  | { ok: false; reason: string };

function clean(text: string): string {
  return text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * JSON-LD descriptions are frequently HTML. Render them to text through an
 * INERT parse.
 *
 * Do not reach for `doc.createElement("div")` + `innerHTML` here. A detached
 * div is not inert: the HTML parser still binds inline event-handler content
 * attributes, so `<img src=x onerror=…>` in a description runs — and it runs
 * in the page's realm, because the element's node document is the live page.
 * A `<template>`'s content lives in a separate inert document that never
 * loads resources or fires handlers.
 */
function stripHtml(doc: Document, html: string): string {
  const tpl = doc.createElement("template");
  tpl.innerHTML = html;
  return tpl.content.textContent ?? "";
}

interface JobPostingLd {
  title?: unknown;
  description?: unknown;
  hiringOrganization?: { name?: unknown } | unknown;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function findJobPosting(node: unknown): JobPostingLd | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;
  if (obj["@type"] === "JobPosting") return obj as JobPostingLd;
  if ("@graph" in obj) return findJobPosting(obj["@graph"]);
  return null;
}

function fromJsonLd(doc: Document): ExtractedJD | null {
  const blocks = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const block of Array.from(blocks)) {
    // The try covers the traversal, not just the parse. `findJobPosting`
    // recurses, and a syntactically VALID but deeply nested block parses fine
    // and then blows the stack with a RangeError. Guarding only JSON.parse
    // would let one pathological page kill extraction outright instead of
    // falling through to Readability — exactly the "one bad block must not
    // sink the page" rule, applied to the case that actually reaches it.
    try {
      const parsed: unknown = JSON.parse(block.textContent ?? "");
      const posting = findJobPosting(parsed);
      if (!posting) continue;

      const description = asString(posting.description);
      if (!description) continue;

      const org = posting.hiringOrganization as { name?: unknown } | undefined;
      return {
        text: clean(stripHtml(doc, description)),
        title: asString(posting.title),
        company: asString(org?.name),
        url: "",
      };
    } catch {
      continue;
    }
  }
  return null;
}

function fromReadability(doc: Document): ExtractedJD | null {
  try {
    // Readability mutates the document it is given; clone so the live page
    // the user is reading is never altered.
    const article = new Readability(doc.cloneNode(true) as Document).parse();
    if (!article?.textContent) return null;
    return {
      text: clean(article.textContent),
      title: clean(article.title ?? ""),
      company: clean(article.siteName ?? ""),
      url: "",
    };
  } catch {
    return null;
  }
}

export function extractFromDocument(doc: Document, url: string): ExtractResult {
  const candidate = fromJsonLd(doc) ?? fromReadability(doc);
  if (!candidate || candidate.text.length < MIN_JD_CHARS) {
    return { ok: false, reason: "too-short" };
  }
  return { ok: true, jd: { ...candidate, url } };
}
