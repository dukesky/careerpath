import { NextResponse } from "next/server";

// TEMPORARY connectivity diagnostic — tests what this Vercel function can reach
// outbound. Open in a browser (you're authenticated) and share the JSON.
// Safe: GET only, hardcoded targets (no user input → no SSRF). Remove after use.
export const runtime = "nodejs";
export const maxDuration = 30;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const TARGETS = [
  ["baseline", "https://example.com"],
  ["greenhouse-api", "https://boards-api.greenhouse.io/v1/boards/roblox/jobs/7950872"],
  ["roblox-html", "https://careers.roblox.com/jobs/7950872"],
  ["adobe-html", "https://careers.adobe.com/us/en/job/ADOBUSR166334EXTERNALENUS/Senior-Machine-Learning-Engineer"],
  ["openrouter", "https://openrouter.ai/api/v1/models"],
] as const;

export async function GET() {
  const results = [];
  for (const [name, url] of TARGETS) {
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: { "User-Agent": UA, Accept: "*/*" },
      });
      const body = await res.text();
      results.push({
        name,
        ok: res.ok,
        status: res.status,
        ms: Date.now() - t0,
        bytes: body.length,
      });
    } catch (err) {
      const e = err as Error & { cause?: unknown };
      const cause = e.cause as { message?: string; code?: string } | undefined;
      results.push({
        name,
        ok: false,
        error: `${e.name}: ${e.message}`,
        cause: cause?.code ?? cause?.message ?? String(e.cause ?? ""),
        ms: Date.now() - t0,
      });
    } finally {
      clearTimeout(timer);
    }
  }
  return NextResponse.json({ node: process.version, region: process.env.VERCEL_REGION ?? null, results });
}
