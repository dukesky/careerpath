import { NextResponse } from "next/server";
import { JSDOM } from "jsdom";
import {
  greenhouseJidRescue,
  extractJobPostingJsonLd,
  fetchJobFromUrl,
} from "@/lib/ats";

// TEMPORARY diagnostic — runs the REAL fetch pipeline on Vercel and reports
// where each step succeeds/fails. GET only, hardcoded inputs. Remove after use.
export const runtime = "nodejs";
export const maxDuration = 60;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const ROBLOX =
  "https://careers.roblox.com/jobs/7950872?gh_jid=7950872&gh_src=da92d0c91";
const ADOBE =
  "https://careers.adobe.com/us/en/job/ADOBUSR166334EXTERNALENUS/Senior-Machine-Learning-Engineer";

function errStr(e: unknown): string {
  const x = e as Error & { cause?: unknown };
  const cause = (x?.cause as { code?: string; message?: string }) ?? undefined;
  return `${x?.name}: ${x?.message}${cause ? ` | cause: ${cause.code ?? cause.message ?? ""}` : ""}`;
}

export async function GET() {
  const steps: Record<string, unknown>[] = [];

  // 1) Does JSDOM even work in this runtime?
  try {
    const txt = new JSDOM(
      "<!doctype html><body><p>hello&nbsp;world</p></body>",
    ).window.document.body?.textContent;
    steps.push({ step: "jsdom-smoke", ok: true, sample: txt });
  } catch (e) {
    steps.push({ step: "jsdom-smoke", ok: false, error: errStr(e) });
  }

  // 2) The Greenhouse public-API rescue for the Roblox URL (the fix path).
  try {
    const r = await greenhouseJidRescue(new URL(ROBLOX));
    steps.push({
      step: "greenhouseJidRescue(roblox)",
      ok: !!r,
      len: r?.text.length ?? 0,
      title: r?.title ?? null,
    });
  } catch (e) {
    steps.push({
      step: "greenhouseJidRescue(roblox)",
      ok: false,
      error: errStr(e),
    });
  }

  // 3) fetchJobFromUrl (dispatcher) for both.
  for (const [name, url] of [
    ["fetchJobFromUrl(roblox)", ROBLOX],
    ["fetchJobFromUrl(adobe)", ADOBE],
  ] as const) {
    try {
      const r = await fetchJobFromUrl(new URL(url));
      steps.push({ step: name, ok: !!r, len: r?.text.length ?? 0 });
    } catch (e) {
      steps.push({ step: name, ok: false, error: errStr(e) });
    }
  }

  // 4) Adobe: fetch HTML then run the JSON-LD extractor (uses jsdom).
  try {
    const res = await fetch(ADOBE, { headers: { "User-Agent": UA } });
    const html = await res.text();
    let jd: { text: string; title: string } | null = null;
    let jdErr: string | null = null;
    try {
      jd = extractJobPostingJsonLd(html);
    } catch (e) {
      jdErr = errStr(e);
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
    steps.push({ step: "adobe: fetch + JSON-LD", ok: false, error: errStr(e) });
  }

  return NextResponse.json({
    node: process.version,
    region: process.env.VERCEL_REGION ?? null,
    steps,
  });
}
