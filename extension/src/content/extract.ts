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

/** JSON-LD descriptions are frequently HTML. Render to text without eval. */
function stripHtml(doc: Document, html: string): string {
  const el = doc.createElement("div");
  el.innerHTML = html;
  return el.textContent ?? "";
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.textContent ?? "");
    } catch {
      continue; // one malformed block must not sink the page
    }
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
