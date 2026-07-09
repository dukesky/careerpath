import { NextResponse } from "next/server";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { getIdentity } from "@/lib/identity";
import { rateLimitResponse } from "@/lib/rate-limit";
import { capText, MAX_JD_CHARS } from "@/lib/limits";
import {
  extractJobPostingJsonLd,
  fetchGreenhouseJob,
  fetchJobFromUrl,
  greenhouseAnyEmbed,
  greenhouseFromHtml,
  greenhouseJidRescue,
} from "@/lib/ats";

function ok(text: string, title: string) {
  return NextResponse.json({ ok: true, text: capText(text, MAX_JD_CHARS), title });
}

export const runtime = "nodejs";
export const maxDuration = 30;

const MIN_CONTENT_CHARS = 200;
const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Always 200 with an { ok } envelope so the frontend can offer fallbacks.
function fail(reason: string) {
  return NextResponse.json({ ok: false, reason });
}

export async function POST(request: Request) {
  const { ip } = getIdentity(request);
  const limited = await rateLimitResponse(ip);
  if (limited) return limited;

  let url: string;
  try {
    const body = (await request.json()) as { url?: unknown };
    url = typeof body.url === "string" ? body.url.trim() : "";
  } catch {
    return fail("Invalid request body.");
  }

  if (!url) return fail("Please enter a URL.");

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail("That doesn't look like a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return fail("Only http and https URLs are supported.");
  }

  // Known ATS hosts (Greenhouse, LinkedIn, Lever, Ashby, Workday, Eightfold):
  // skip scraping and pull the JD from the platform's public API.
  const ats = await fetchJobFromUrl(parsed);
  if (ats) return ok(ats.text, ats.title);

  // Fetch with a realistic UA and a hard 10s timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let html: string;
  try {
    const res = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) {
      // Blocked (e.g. 403). If the URL carries a Greenhouse job id, rescue it.
      const rescue = await greenhouseJidRescue(parsed);
      if (rescue) return ok(rescue.text, rescue.title);
      return fail(`The page returned HTTP ${res.status}.`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("html")) {
      return fail("That link isn't an HTML page. Paste the text instead.");
    }
    html = await res.text();
  } catch (err) {
    const rescue = await greenhouseJidRescue(parsed);
    if (rescue) return ok(rescue.text, rescue.title);
    const aborted = err instanceof Error && err.name === "AbortError";
    return fail(
      aborted
        ? "The page took too long to respond (10s timeout)."
        : "Could not reach that URL.",
    );
  } finally {
    clearTimeout(timer);
  }

  // Custom domain backed by Greenhouse (JS-rendered): prefer the API JD.
  const strongGh = greenhouseFromHtml(html, parsed);
  if (strongGh) {
    const gh = await fetchGreenhouseJob(strongGh);
    if (gh) return ok(gh.text, gh.title);
  }

  // Canonical schema.org JobPosting (JSON-LD) — clean, and present on most
  // career sites. Preferred over Readability when it has the full JD.
  const jsonld = extractJobPostingJsonLd(html);
  if (jsonld) return ok(jsonld.text, jsonld.title);

  // Extract the main readable content.
  let text = "";
  let title = "";
  try {
    const dom = new JSDOM(html, { url: parsed.toString() });
    const article = new Readability(dom.window.document).parse();
    text = (article?.textContent ?? "").replace(/\s+\n/g, "\n").trim();
    title = article?.title?.trim() ?? "";
  } catch {
    return fail("Could not extract content from that page.");
  }
  if (text.length >= MIN_CONTENT_CHARS) return ok(text, title);

  // Last resorts: a Greenhouse embed on the page, or a board-guess rescue.
  const embeddedGh = greenhouseAnyEmbed(html);
  if (embeddedGh) {
    const gh = await fetchGreenhouseJob(embeddedGh);
    if (gh) return ok(gh.text, gh.title);
  }
  const rescue = await greenhouseJidRescue(parsed);
  if (rescue) return ok(rescue.text, rescue.title);

  return fail(
    "Couldn't find enough job-description text on that page. Many sites block scraping — paste the text or upload screenshots instead.",
  );
}
