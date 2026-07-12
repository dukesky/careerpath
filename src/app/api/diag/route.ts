import { NextResponse } from "next/server";

// TEMPORARY diagnostic. Everything is dynamically imported inside try/catch so a
// module-load or native crash is REPORTED (not a bare 500). Remove after use.
export const runtime = "nodejs";
export const maxDuration = 60;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const ROBLOX =
  "https://careers.roblox.com/jobs/7950872?gh_jid=7950872&gh_src=da92d0c91";
const ADOBE =
  "https://careers.adobe.com/us/en/job/ADOBUSR166334EXTERNALENUS/Senior-Machine-Learning-Engineer";

function info(e: unknown): { error: string; stack: string } {
  const x = e as Error & { cause?: unknown };
  const cause = (x?.cause as { code?: string; message?: string }) ?? undefined;
  return {
    error: `${x?.name}: ${x?.message}${cause ? ` | cause: ${cause.code ?? cause.message ?? ""}` : ""}`,
    stack: (x?.stack ?? "").slice(0, 600),
  };
}

async function timedFetch(url: string): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 12_000);
  try {
    return await fetch(url, { signal: c.signal, headers: { "User-Agent": UA } });
  } finally {
    clearTimeout(t);
  }
}

export async function GET() {
  const steps: Record<string, unknown>[] = [];

  // 1) Load jsdom and instantiate it.
  try {
    const { JSDOM } = await import("jsdom");
    const txt = new JSDOM(
      "<!doctype html><body><p>hello&nbsp;world</p></body>",
    ).window.document.body?.textContent;
    steps.push({ step: "jsdom", ok: true, sample: txt });
  } catch (e) {
    steps.push({ step: "jsdom", ok: false, ...info(e) });
  }

  // 2) Load @mozilla/readability + jsdom together (the fetch-jd generic path).
  try {
    const { JSDOM } = await import("jsdom");
    const { Readability } = await import("@mozilla/readability");
    const dom = new JSDOM(
      "<!doctype html><title>t</title><body><article><h1>Hi</h1><p>" +
        "word ".repeat(80) +
        "</p></article></body>",
      { url: "https://example.com/" },
    );
    const art = new Readability(dom.window.document).parse();
    steps.push({ step: "readability", ok: true, len: art?.textContent?.length ?? 0 });
  } catch (e) {
    steps.push({ step: "readability", ok: false, ...info(e) });
  }

  // 3) Greenhouse rescue for Roblox (the public-API fix path).
  try {
    const { greenhouseJidRescue } = await import("@/lib/ats");
    const r = await greenhouseJidRescue(new URL(ROBLOX));
    steps.push({ step: "greenhouseJidRescue(roblox)", ok: !!r, len: r?.text.length ?? 0 });
  } catch (e) {
    steps.push({ step: "greenhouseJidRescue(roblox)", ok: false, ...info(e) });
  }

  // 4) Adobe: fetch HTML then JSON-LD extractor (uses jsdom).
  try {
    const { extractJobPostingJsonLd } = await import("@/lib/ats");
    const res = await timedFetch(ADOBE);
    const html = await res.text();
    let jd: { text: string; title: string } | null = null;
    let jdErr: { error: string; stack: string } | null = null;
    try {
      jd = extractJobPostingJsonLd(html);
    } catch (e) {
      jdErr = info(e);
    }
    steps.push({
      step: "adobe: fetch + JSON-LD",
      fetchOk: res.ok,
      htmlBytes: html.length,
      jsonLdOk: !!jd,
      jsonLdLen: jd?.text.length ?? 0,
      jsonLdError: jdErr,
    });
  } catch (e) {
    steps.push({ step: "adobe: fetch + JSON-LD", ok: false, ...info(e) });
  }

  return NextResponse.json({
    node: process.version,
    region: process.env.VERCEL_REGION ?? null,
    steps,
  });
}
