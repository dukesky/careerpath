import { NextResponse } from "next/server";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

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
    if (!res.ok) return fail(`The page returned HTTP ${res.status}.`);
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("html")) {
      return fail("That link isn't an HTML page. Paste the text instead.");
    }
    html = await res.text();
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return fail(
      aborted
        ? "The page took too long to respond (10s timeout)."
        : "Could not reach that URL.",
    );
  } finally {
    clearTimeout(timer);
  }

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

  if (text.length < MIN_CONTENT_CHARS) {
    return fail(
      "Couldn't find enough job-description text on that page. Many sites block scraping — paste the text or upload screenshots instead.",
    );
  }

  return NextResponse.json({ ok: true, text, title });
}
