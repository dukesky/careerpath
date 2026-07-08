import { JSDOM } from "jsdom";

/**
 * Greenhouse ATS support.
 *
 * Many career sites (including custom domains like mrbeastjobs.com) are
 * JavaScript-rendered front-ends backed by Greenhouse — the job description is
 * NOT in the server HTML, so Readability finds nothing. Greenhouse exposes a
 * public JSON API, so when we can identify the board + job id we fetch the JD
 * directly instead.
 */

const GH_TIMEOUT_MS = 10_000;
const MIN_CHARS = 200;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface GreenhouseRef {
  board: string;
  jobId: string;
}

const BOARD_RE = /^[A-Za-z0-9_-]+$/;
const ID_RE = /^\d+$/;

/** Identify a Greenhouse job from a direct greenhouse.io URL. */
export function greenhouseFromUrl(u: URL): GreenhouseRef | null {
  if (!u.hostname.toLowerCase().endsWith("greenhouse.io")) return null;

  // e.g. https://job-boards.greenhouse.io/mrbeastyoutube/jobs/6093126004
  const path = u.pathname.match(/^\/([A-Za-z0-9_-]+)\/jobs\/(\d+)/);
  if (path) return { board: path[1], jobId: path[2] };

  // e.g. https://job-boards.greenhouse.io/embed/job_app?for=board&token=id
  const board = u.searchParams.get("for");
  const token = u.searchParams.get("token");
  if (board && token && BOARD_RE.test(board) && ID_RE.test(token)) {
    return { board, jobId: token };
  }
  return null;
}

/**
 * Strict: identify a Greenhouse job embedded in a page whose URL already names
 * the job id (…/jobs/<id>, ?token=<id>, ?gh_jid=<id>) and whose HTML contains a
 * board tied to THAT id. Strong enough to prefer over a weak Readability parse.
 */
export function greenhouseFromHtml(html: string, u: URL): GreenhouseRef | null {
  const idInPath = u.pathname.match(/\/jobs\/(\d+)/);
  const idInQuery = u.search.match(/[?&](?:token|gh_jid)=(\d+)/);
  const jobId = idInPath?.[1] ?? idInQuery?.[1] ?? null;
  if (!jobId) return null;

  // Find the board token tied to THIS job id (pages can list many jobs).
  const embed = html.match(
    new RegExp(`for=([A-Za-z0-9_-]+)&(?:amp;)?token=${jobId}\\b`, "i"),
  );
  const boardsUrl = html.match(
    new RegExp(
      `(?:job-boards|boards)\\.greenhouse\\.io/([A-Za-z0-9_-]+)/jobs/${jobId}\\b`,
      "i",
    ),
  );
  const board = embed?.[1] ?? boardsUrl?.[1];
  return board ? { board, jobId } : null;
}

/**
 * Loose: any single Greenhouse embed on the page. Only used as a last resort
 * after Readability fails, since it isn't tied to the requested job id.
 */
export function greenhouseAnyEmbed(html: string): GreenhouseRef | null {
  const m = html.match(/for=([A-Za-z0-9_-]+)&(?:amp;)?token=(\d+)\b/i);
  return m ? { board: m[1], jobId: m[2] } : null;
}

/** Convert Greenhouse's entity-encoded HTML `content` into plain text. */
function greenhouseContentToText(contentHtml: string): string {
  const dom = new JSDOM("<!DOCTYPE html><body></body>");
  const doc = dom.window.document;
  // Greenhouse double-encodes the content (JSON string of entity-escaped HTML).
  const decoder = doc.createElement("textarea");
  decoder.innerHTML = contentHtml; // entity-decode → real HTML string
  const container = doc.createElement("div");
  container.innerHTML = decoder.value; // parse the real HTML
  return (container.textContent ?? "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Fetch a job's description from the Greenhouse public API. */
export async function fetchGreenhouseJob(
  ref: GreenhouseRef,
): Promise<{ text: string; title: string } | null> {
  if (!BOARD_RE.test(ref.board) || !ID_RE.test(ref.jobId)) return null;

  const api = `https://boards-api.greenhouse.io/v1/boards/${ref.board}/jobs/${ref.jobId}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GH_TIMEOUT_MS);
  try {
    const res = await fetch(api, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      content?: unknown;
      title?: unknown;
      location?: { name?: unknown } | null;
    };
    const contentHtml = typeof data.content === "string" ? data.content : "";
    if (!contentHtml) return null;

    const text = greenhouseContentToText(contentHtml);
    if (text.length < MIN_CHARS) return null;

    const title = [
      typeof data.title === "string" ? data.title : "",
      typeof data.location?.name === "string" ? data.location.name : "",
    ]
      .filter(Boolean)
      .join(" — ");
    return { text, title };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
