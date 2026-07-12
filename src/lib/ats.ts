import { parseHTML } from "linkedom";
import he from "he";

/**
 * Applicant-tracking-system (ATS) job fetchers.
 *
 * Many job pages are JavaScript-rendered, so the server HTML we fetch has no
 * job description for Readability to find. Most big ATSs expose a public
 * JSON/HTML endpoint keyed off ids in the URL — so when we recognize the host
 * we pull the JD from that API instead of scraping.
 *
 * Every fetcher returns `{ text, title } | null` and never throws — a null
 * simply falls back to the generic Readability path in the route.
 */

const TIMEOUT_MS = 10_000;
const MIN_CHARS = 200;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export interface FetchedJob {
  text: string;
  title: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

async function timedFetch(
  url: string,
  accept: string,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { Accept: accept, "User-Agent": UA },
    });
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Strip real HTML to readable text, preserving block breaks. */
function stripHtmlToText(html: string): string {
  const withBreaks = html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6]|tr|ul|ol)\s*>/gi, "\n");
  // linkedom's body.textContent on a parsed fragment is unreliable for larger
  // HTML; a detached element's innerHTML→textContent is robust.
  const { document } = parseHTML("<!DOCTYPE html><body></body>");
  const div = document.createElement("div");
  div.innerHTML = withBreaks;
  return normalize(div.textContent ?? "");
}

/** Decode entity-escaped HTML (e.g. Greenhouse's double-encoded content). */
function decodeHtmlEntities(s: string): string {
  return he.decode(s);
}

function normalize(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function withTitle(parts: (string | undefined)[]): string {
  return parts.map((p) => str(p)).filter(Boolean).join(" — ");
}

// ---------------------------------------------------------------------------
// Greenhouse
// ---------------------------------------------------------------------------

export interface GreenhouseRef {
  board: string;
  jobId: string;
}

const BOARD_RE = /^[A-Za-z0-9_-]+$/;
const NUM_ID_RE = /^\d+$/;

export function greenhouseFromUrl(u: URL): GreenhouseRef | null {
  if (!u.hostname.toLowerCase().endsWith("greenhouse.io")) return null;
  const path = u.pathname.match(/^\/([A-Za-z0-9_-]+)\/jobs\/(\d+)/);
  if (path) return { board: path[1], jobId: path[2] };
  const board = u.searchParams.get("for");
  const token = u.searchParams.get("token");
  if (board && token && BOARD_RE.test(board) && NUM_ID_RE.test(token)) {
    return { board, jobId: token };
  }
  return null;
}

/** Greenhouse job embedded in a page whose URL names the job id. */
export function greenhouseFromHtml(html: string, u: URL): GreenhouseRef | null {
  const jobId =
    u.pathname.match(/\/jobs\/(\d+)/)?.[1] ??
    u.search.match(/[?&](?:token|gh_jid)=(\d+)/)?.[1] ??
    null;
  if (!jobId) return null;
  const board =
    html.match(new RegExp(`for=([A-Za-z0-9_-]+)&(?:amp;)?token=${jobId}\\b`, "i"))?.[1] ??
    html.match(
      new RegExp(
        `(?:job-boards|boards)\\.greenhouse\\.io/([A-Za-z0-9_-]+)/jobs/${jobId}\\b`,
        "i",
      ),
    )?.[1];
  return board ? { board, jobId } : null;
}

/** Any single Greenhouse embed on the page — last-resort only. */
export function greenhouseAnyEmbed(html: string): GreenhouseRef | null {
  const m = html.match(/for=([A-Za-z0-9_-]+)&(?:amp;)?token=(\d+)\b/i);
  return m ? { board: m[1], jobId: m[2] } : null;
}

export async function fetchGreenhouseJob(
  ref: GreenhouseRef,
): Promise<FetchedJob | null> {
  if (!BOARD_RE.test(ref.board) || !NUM_ID_RE.test(ref.jobId)) return null;
  const res = await timedFetch(
    `https://boards-api.greenhouse.io/v1/boards/${ref.board}/jobs/${ref.jobId}`,
    "application/json",
  );
  if (!res || !res.ok) return null;
  const data = (await res.json().catch(() => null)) as {
    content?: unknown;
    title?: unknown;
    location?: { name?: unknown } | null;
  } | null;
  const content = str(data?.content);
  if (!content) return null;
  const text = stripHtmlToText(decodeHtmlEntities(content));
  if (text.length < MIN_CHARS) return null;
  return { text, title: withTitle([str(data?.title), str(data?.location?.name)]) };
}

// ---------------------------------------------------------------------------
// LinkedIn (public "guest" job-posting endpoint — no login)
// ---------------------------------------------------------------------------

export function linkedinJobId(u: URL): string | null {
  if (!u.hostname.toLowerCase().endsWith("linkedin.com")) return null;
  const inPath = u.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d{5,})/);
  if (inPath) return inPath[1];
  const q = u.searchParams.get("currentJobId") ?? u.searchParams.get("jobId");
  if (q && NUM_ID_RE.test(q)) return q;
  return null;
}

async function fetchLinkedinJob(jobId: string): Promise<FetchedJob | null> {
  const res = await timedFetch(
    `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`,
    "text/html",
  );
  if (!res || !res.ok) return null;
  const html = await res.text();
  const { document } = parseHTML(html);
  const descEl =
    document.querySelector(".show-more-less-html__markup") ??
    document.querySelector(".description__text");
  const text = descEl
    ? stripHtmlToText(descEl.innerHTML)
    : normalize(document.body?.textContent ?? "");
  if (text.length < MIN_CHARS) return null;
  const title = (
    document.querySelector(".top-card-layout__title") ??
    document.querySelector(".topcard__title")
  )?.textContent?.trim();
  const company = (
    document.querySelector(".topcard__org-name-link") ??
    document.querySelector(".topcard__flavor")
  )?.textContent?.trim();
  return { text, title: withTitle([title, company]) };
}

// ---------------------------------------------------------------------------
// Lever
// ---------------------------------------------------------------------------

function leverFromUrl(u: URL): { company: string; postingId: string } | null {
  const h = u.hostname.toLowerCase();
  if (h !== "jobs.lever.co" && h !== "jobs.eu.lever.co") return null;
  const m = u.pathname.match(/^\/([A-Za-z0-9._-]+)\/([0-9a-f-]{36})/i);
  return m && UUID_RE.test(m[2]) ? { company: m[1], postingId: m[2] } : null;
}

async function fetchLeverJob(ref: {
  company: string;
  postingId: string;
}): Promise<FetchedJob | null> {
  const res = await timedFetch(
    `https://api.lever.co/v0/postings/${ref.company}/${ref.postingId}`,
    "application/json",
  );
  if (!res || !res.ok) return null;
  const d = (await res.json().catch(() => null)) as {
    text?: unknown;
    descriptionPlain?: unknown;
    description?: unknown;
    categories?: { location?: unknown } | null;
  } | null;
  const text = str(d?.descriptionPlain)
    ? normalize(str(d?.descriptionPlain))
    : stripHtmlToText(str(d?.description));
  if (text.length < MIN_CHARS) return null;
  return { text, title: withTitle([str(d?.text), str(d?.categories?.location)]) };
}

// ---------------------------------------------------------------------------
// Ashby
// ---------------------------------------------------------------------------

function ashbyFromUrl(u: URL): { org: string; jobId: string } | null {
  if (u.hostname.toLowerCase() !== "jobs.ashbyhq.com") return null;
  const m = u.pathname.match(/^\/([A-Za-z0-9._-]+)\/([0-9a-f-]{36})/i);
  return m && UUID_RE.test(m[2]) ? { org: m[1], jobId: m[2] } : null;
}

async function fetchAshbyJob(ref: {
  org: string;
  jobId: string;
}): Promise<FetchedJob | null> {
  const res = await timedFetch(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(
      ref.org,
    )}?includeCompensation=true`,
    "application/json",
  );
  if (!res || !res.ok) return null;
  const d = (await res.json().catch(() => null)) as {
    jobs?: Array<Record<string, unknown>>;
  } | null;
  const job = (d?.jobs ?? []).find((j) => str(j.id) === ref.jobId);
  if (!job) return null;
  const text = str(job.descriptionPlain)
    ? normalize(str(job.descriptionPlain))
    : stripHtmlToText(str(job.descriptionHtml));
  if (text.length < MIN_CHARS) return null;
  return { text, title: withTitle([str(job.title), str(job.location)]) };
}

// ---------------------------------------------------------------------------
// Workday (best-effort — tenant/site parsed from the URL)
// ---------------------------------------------------------------------------

function workdayApiUrl(u: URL): string | null {
  const h = u.hostname.toLowerCase();
  if (!h.endsWith("myworkdayjobs.com")) return null;
  const tenant = h.split(".")[0];
  // …/{site}/job/{location}/{title}_{req}
  const m = u.pathname.match(/\/([^/]+)\/job\/(.+)$/);
  if (!tenant || !m) return null;
  return `${u.protocol}//${u.hostname}/wday/cxs/${tenant}/${m[1]}/job/${m[2]}`;
}

async function fetchWorkdayJob(apiUrl: string): Promise<FetchedJob | null> {
  const res = await timedFetch(apiUrl, "application/json");
  if (!res || !res.ok) return null;
  const d = (await res.json().catch(() => null)) as {
    jobPostingInfo?: {
      title?: unknown;
      jobDescription?: unknown;
      location?: unknown;
    } | null;
  } | null;
  const info = d?.jobPostingInfo;
  if (!info) return null;
  const text = stripHtmlToText(str(info.jobDescription));
  if (text.length < MIN_CHARS) return null;
  return { text, title: withTitle([str(info.title), str(info.location)]) };
}

// ---------------------------------------------------------------------------
// Eightfold (Netflix and other "…/careers/job/{id}?domain=…" boards)
// ---------------------------------------------------------------------------

function eightfoldFromUrl(
  u: URL,
): { host: string; jobId: string; domain: string } | null {
  const m = u.pathname.match(/\/careers\/job\/(\d{6,})/);
  if (!m) return null;
  const domain =
    u.searchParams.get("domain") ||
    u.hostname.replace(/^(explore\.jobs|jobs|careers)\./, "");
  return { host: u.hostname, jobId: m[1], domain };
}

async function fetchEightfoldJob(ref: {
  host: string;
  jobId: string;
  domain: string;
}): Promise<FetchedJob | null> {
  const res = await timedFetch(
    `https://${ref.host}/api/apply/v2/jobs/${ref.jobId}?domain=${encodeURIComponent(
      ref.domain,
    )}`,
    "application/json",
  );
  if (!res || !res.ok) return null;
  const d = (await res.json().catch(() => null)) as {
    name?: unknown;
    job_description?: unknown;
    location?: unknown;
  } | null;
  const text = stripHtmlToText(str(d?.job_description));
  if (text.length < MIN_CHARS) return null;
  return { text, title: withTitle([str(d?.name), str(d?.location)]) };
}

// ---------------------------------------------------------------------------
// schema.org JobPosting (JSON-LD) — a canonical JD embedded by most career
// sites for Google for Jobs. High-quality and generic.
// ---------------------------------------------------------------------------

function findJobPosting(node: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findJobPosting(n);
      if (r) return r;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    const t = o["@type"];
    const isJP =
      (typeof t === "string" && t.includes("JobPosting")) ||
      (Array.isArray(t) && t.some((x) => String(x).includes("JobPosting")));
    if (isJP) return o;
    if (o["@graph"]) return findJobPosting(o["@graph"]);
  }
  return null;
}

export function extractJobPostingJsonLd(html: string): FetchedJob | null {
  const { document } = parseHTML(html);
  const scripts = document.querySelectorAll(
    'script[type="application/ld+json"]',
  );
  for (const s of Array.from(scripts)) {
    let data: unknown;
    try {
      data = JSON.parse(s.textContent ?? "");
    } catch {
      continue;
    }
    const jp = findJobPosting(data);
    if (!jp) continue;
    let raw = str(jp.description);
    if (raw.includes("&lt;") || raw.includes("&gt;")) raw = decodeHtmlEntities(raw);
    const text = stripHtmlToText(raw);
    if (text.length < MIN_CHARS) continue;
    const org = jp.hiringOrganization;
    const orgName =
      org && typeof org === "object"
        ? str((org as Record<string, unknown>).name)
        : str(org);
    return { text, title: withTitle([str(jp.title), orgName]) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Greenhouse gh_jid rescue — when a custom domain embeds a Greenhouse job id
// but blocks scraping (403), guess the board token from the hostname.
// ---------------------------------------------------------------------------

const HOST_SKIP = new Set([
  "www", "careers", "career", "jobs", "job", "boards", "apply", "explore",
  "talent", "work", "com", "net", "org", "io", "co", "us", "en", "ai",
]);

function greenhouseBoardCandidates(u: URL): string[] {
  const labels = u.hostname.toLowerCase().split(".");
  const core = labels.filter((l) => !HOST_SKIP.has(l));
  const main = core.length ? core[core.length - 1] : labels[0];
  const cands = new Set<string>([main]);
  for (const suf of ["careers", "career", "jobs", "job", "hq", "inc"]) {
    if (main.endsWith(suf) && main.length > suf.length) {
      cands.add(main.slice(0, -suf.length));
    }
  }
  return [...cands];
}

export async function greenhouseJidRescue(u: URL): Promise<FetchedJob | null> {
  const jid =
    u.search.match(/[?&](?:gh_jid|token)=(\d+)/)?.[1] ??
    u.pathname.match(/\/jobs?\/(\d+)/)?.[1];
  if (!jid) return null;
  for (const board of greenhouseBoardCandidates(u)) {
    const r = await fetchGreenhouseJob({ board, jobId: jid });
    if (r) return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dispatcher — recognize the host and fetch from the right API
// ---------------------------------------------------------------------------

export async function fetchJobFromUrl(u: URL): Promise<FetchedJob | null> {
  const gh = greenhouseFromUrl(u);
  if (gh) {
    const r = await fetchGreenhouseJob(gh);
    if (r) return r;
  }
  const liId = linkedinJobId(u);
  if (liId) {
    const r = await fetchLinkedinJob(liId);
    if (r) return r;
  }
  const lever = leverFromUrl(u);
  if (lever) {
    const r = await fetchLeverJob(lever);
    if (r) return r;
  }
  const ashby = ashbyFromUrl(u);
  if (ashby) {
    const r = await fetchAshbyJob(ashby);
    if (r) return r;
  }
  const wd = workdayApiUrl(u);
  if (wd) {
    const r = await fetchWorkdayJob(wd);
    if (r) return r;
  }
  const ef = eightfoldFromUrl(u);
  if (ef) {
    const r = await fetchEightfoldJob(ef);
    if (r) return r;
  }
  return null;
}
