import { NextResponse } from "next/server";

// TEMPORARY diagnostic — verifies the linkedom-based fetch pipeline on Vercel.
// GET only, hardcoded inputs. Remove after confirming.
export const runtime = "nodejs";
export const maxDuration = 60;

const ROBLOX =
  "https://careers.roblox.com/jobs/7950872?gh_jid=7950872&gh_src=da92d0c91";
const ADOBE =
  "https://careers.adobe.com/us/en/job/ADOBUSR166334EXTERNALENUS/Senior-Machine-Learning-Engineer";

function info(e: unknown): { error: string; stack: string } {
  const x = e as Error & { cause?: unknown };
  const cause = (x?.cause as { code?: string; message?: string }) ?? undefined;
  return {
    error: `${x?.name}: ${x?.message}${cause ? ` | cause: ${cause.code ?? cause.message ?? ""}` : ""}`,
    stack: (x?.stack ?? "").slice(0, 500),
  };
}

export async function GET() {
  const steps: Record<string, unknown>[] = [];

  // 1) linkedom loads + parses in this runtime?
  try {
    const { parseHTML } = await import("linkedom");
    const { document } = parseHTML(
      "<!doctype html><body><p>hello&nbsp;world</p></body>",
    );
    steps.push({
      step: "linkedom",
      ok: true,
      sample: document.body?.textContent,
    });
  } catch (e) {
    steps.push({ step: "linkedom", ok: false, ...info(e) });
  }

  // 2) The real dispatcher for both URLs (Roblox via public GH API; Adobe JSON-LD).
  for (const [name, url] of [
    ["fetchJobFromUrl(roblox)", ROBLOX],
    ["fetchJobFromUrl(adobe)", ADOBE],
  ] as const) {
    try {
      const { fetchJobFromUrl, greenhouseJidRescue } = await import("@/lib/ats");
      let r = await fetchJobFromUrl(new URL(url));
      if (!r && /[?&]gh_jid=\d+/.test(new URL(url).search)) {
        r = await greenhouseJidRescue(new URL(url));
      }
      steps.push({ step: name, ok: !!r, len: r?.text.length ?? 0, title: r?.title ?? null });
    } catch (e) {
      steps.push({ step: name, ok: false, ...info(e) });
    }
  }

  return NextResponse.json({
    node: process.version,
    region: process.env.VERCEL_REGION ?? null,
    steps,
  });
}
