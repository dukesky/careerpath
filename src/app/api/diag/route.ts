import { NextResponse } from "next/server";

// TEMPORARY diagnostic — verifies each linkedom-dependent path on Vercel.
// GET only, hardcoded inputs. Remove after confirming.
export const runtime = "nodejs";
export const maxDuration = 60;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const ADOBE =
  "https://careers.adobe.com/us/en/job/ADOBUSR166334EXTERNALENUS/Senior-Machine-Learning-Engineer";
const LINKEDIN =
  "https://www.linkedin.com/jobs/search-results/?currentJobId=4419665582";
const WIKI = "https://en.wikipedia.org/wiki/Software_engineer";

function info(e: unknown) {
  const x = e as Error & { cause?: unknown };
  const cause = (x?.cause as { code?: string; message?: string }) ?? undefined;
  return {
    error: `${x?.name}: ${x?.message}${cause ? ` | cause: ${cause.code ?? cause.message ?? ""}` : ""}`,
    stack: (x?.stack ?? "").slice(0, 400),
  };
}

export async function GET() {
  const steps: Record<string, unknown>[] = [];

  // 1) The robust text-extraction form (createElement + innerHTML + textContent).
  try {
    const { parseHTML } = await import("linkedom");
    const { document } = parseHTML("<!DOCTYPE html><body></body>");
    const div = document.createElement("div");
    div.innerHTML = "<p>hello <b>brave</b> world</p>";
    steps.push({ step: "linkedom-createElement", ok: true, sample: div.textContent });
  } catch (e) {
    steps.push({ step: "linkedom-createElement", ok: false, ...info(e) });
  }

  // 2) Adobe via the JSON-LD extractor (now regex-based script finding).
  try {
    const { extractJobPostingJsonLd } = await import("@/lib/ats");
    const res = await fetch(ADOBE, { headers: { "User-Agent": UA } });
    const html = await res.text();
    const jd = extractJobPostingJsonLd(html);
    steps.push({ step: "adobe-jsonld", ok: !!jd, len: jd?.text.length ?? 0, htmlBytes: html.length });
  } catch (e) {
    steps.push({ step: "adobe-jsonld", ok: false, ...info(e) });
  }

  // 3) LinkedIn via the dispatcher (linkedom querySelector + innerHTML path).
  try {
    const { fetchJobFromUrl } = await import("@/lib/ats");
    const r = await fetchJobFromUrl(new URL(LINKEDIN));
    steps.push({ step: "linkedin", ok: !!r, len: r?.text.length ?? 0, title: r?.title ?? null });
  } catch (e) {
    steps.push({ step: "linkedin", ok: false, ...info(e) });
  }

  // 4) Readability (generic fallback) on a linkedom document.
  try {
    const { parseHTML } = await import("linkedom");
    const { Readability } = await import("@mozilla/readability");
    const res = await fetch(WIKI, { headers: { "User-Agent": UA } });
    const html = await res.text();
    const { document } = parseHTML(html);
    const art = new Readability(document).parse();
    steps.push({ step: "readability-wiki", ok: (art?.textContent?.length ?? 0) > 200, len: art?.textContent?.length ?? 0 });
  } catch (e) {
    steps.push({ step: "readability-wiki", ok: false, ...info(e) });
  }

  return NextResponse.json({ node: process.version, region: process.env.VERCEL_REGION ?? null, steps });
}
