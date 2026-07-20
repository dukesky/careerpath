# I built an open-source AI resume tailor that refuses to lie — here's the architecture

*How I turned "rewrite my resume for every job" into a privacy-first web app — the two-call LLM pipeline, the no-fabrication constraint, ingesting job descriptions from anywhere, and the bug that only ever happened in production.*

> **TL;DR** — [careerpath](https://github.com/dukesky/careerpath) takes your resume and a job description and returns a version rewritten for that specific role, plus an honest gap analysis. It never invents facts, stores nothing unless you opt in, and the whole thing is open source. Live demo and code linked at the bottom. This post is the engineering story.

---

## The itch

I applied to a lot of jobs last year, and the single most soul-draining part wasn't the interviews — it was rewriting my resume for every job description. Reorder the bullets, surface the keywords this team cares about, downplay the irrelevant stuff, keep it to one page. Every. Single. Time.

It's mechanical enough to feel like it should be automated, and judgment-heavy enough that the existing "AI resume" tools do it badly. Most of them share two problems I refused to ship:

1. **They quietly keep your data.** Your resume and career history get uploaded, stored, and often used to train something.
2. **They lie.** Ask them to "optimize for this role" and they'll happily invent a metric, inflate a title, or bolt on a skill you don't have. A tailored resume that lies is worse than useless — it blows up in the interview.

So I built the tool I wanted: **fast, private, and constitutionally incapable of fabricating.** Here's how it works under the hood.

---

## The shape of it

The stack is deliberately boring so the interesting parts stand out:

- **Next.js 15 (App Router) + TypeScript**, deployed on **Vercel**
- **LLMs via [OpenRouter](https://openrouter.ai/)** (one OpenAI-compatible endpoint, many models) — Claude (Sonnet/Haiku) for the reasoning-heavy work, DeepSeek for cheap structured parsing
- **Upstash Redis** for the few things that *are* stateful (quota, opt-in saves)
- **Clerk** for auth (only needed if you choose to save a version)

The user flow is four steps: **parse the resume → ingest the JD → analyze + tailor → review and export.** Two of those steps are where the engineering lives.

---

## One place to route every model

Before any of the AI logic, I made one decision that paid for itself repeatedly: **all model routing lives in a single file.** Swapping a model, or adding a "fast vs. quality" toggle, is a one-line change.

```ts
const MODEL_MAP: Record<LLMTask, string> = {
  parse:   "deepseek/deepseek-chat",       // cheap, structured extraction
  analyze: "anthropic/claude-sonnet-4.6",  // reasoning-heavy
  tailor:  "anthropic/claude-sonnet-4.6",
  ocr:     "anthropic/claude-sonnet-4.6",  // vision-capable
};

// The quality flag only overrides analyze/tailor.
const QUALITY_MODELS: Record<Quality, string> = {
  fast:    "anthropic/claude-haiku-4.5",
  quality: "anthropic/claude-sonnet-4.6",
};
```

Different tasks have genuinely different needs. Parsing a resume into JSON is a solved problem a cheap model nails; tailoring is where you want the strongest reasoning. Routing per-task instead of picking one model for everything cut cost without touching quality where it matters.

The wrapper around OpenRouter is a thin `callLLM()` with one feature worth stealing: **reliable JSON mode.** LLMs love to wrap JSON in ```` ```json ```` fences or add a "Sure! Here's your JSON:" preamble. So the JSON path strips fences, tries to parse, and if that fails, **feeds the parse error back to the model and retries once**:

```ts
const first = await complete(messages);
try {
  return JSON.parse(stripCodeFences(first)) as T;
} catch (err) {
  const retry = [
    ...messages,
    { role: "assistant", content: first },
    { role: "user", content:
      `Your previous reply could not be parsed as JSON (${err.message}). ` +
      "Reply again with ONLY valid, complete JSON — no fences, no commentary." },
  ];
  return JSON.parse(stripCodeFences(await complete(retry))) as T;
}
```

`stripCodeFences` also falls back to grabbing the outermost `{…}`/`[…]` block if the model buries the JSON in prose. Between the two, malformed-JSON failures effectively went to zero.

---

## The core: a two-call pipeline that runs in parallel

The naive approach is one giant prompt: "here's a resume and a job, rewrite it." That conflates two very different jobs — *judging* fit and *editing* text — and does both worse. I split it into two calls with two distinct system prompts:

- **Analyze** → an evidence-based gap analysis: a 0–100 match score, a requirements matrix (every must-have and nice-to-have, marked met / partial / missing with the specific evidence), top strengths, and honest gaps.
- **Tailor** → the rewritten resume itself, plus a change log and a *projected* match score for the new version.

Crucially, **they run in parallel.** Tailor doesn't wait on analyze; both fire against the resume + JD at once, so the user sees results in roughly the time of a single call.

### Making "don't lie" a hard constraint

The tailor system prompt opens with a non-negotiable:

> You may rephrase, reorder, re-emphasize, tighten wording, surface relevant keywords, and incorporate facts the candidate supplied in "extra info". You must **NEVER** invent or alter employers, job titles, dates, degrees, metrics, numbers, or experiences that are not present in the input. If a fact is not in the resume or extra info, it does not go in the output. Inventing anything is a critical failure.

Then it gives the model a **theme-first method** instead of letting it free-associate:

1. Identify the 3–5 most important themes from the job's must-have requirements.
2. Rewrite every section to foreground the candidate's *real* experience that maps to those themes — reorder bullets so the most relevant impact leads, tighten wording to surface matching keywords, reorder skills.
3. If the candidate genuinely lacks a must-have, **leave it out.** The gap belongs in the analysis, not the resume.

That last rule is the whole philosophy in one line. The gap analysis is allowed to say "you're missing PyTorch experience." The resume is not allowed to pretend you have it.

### Scoring the rewrite honestly

The tailor call also returns a `projected_match_score` — but the prompt is explicit that **rewording can raise the score only by surfacing experience that was already there**, and that missing hard requirements still cap it:

> Base it ONLY on real content now in the tailored resume — rewording can raise it by surfacing existing relevant experience, but missing hard requirements (skills/years/degrees the candidate genuinely lacks) still cap it. A rephrase does not manufacture qualifications.

The UI then shows **before → after** as the product's value at a glance: your original resume scored 78 for this role; the tailored one scores 86, and here's the +8 with every change annotated. No magic, no inflation — just your real experience, better arranged.

---

## Ingesting a job description from *anywhere*

A tool like this dies on friction, and the highest-friction step is getting the JD in. Nobody wants to copy-paste. So there are three ways in, in order of preference:

1. **Paste a link.** This is the happy path — and the hardest to build.
2. **Paste the text.** Always works.
3. **Upload screenshots.** A single vision call (OCR) transcribes them to text.

The link path is a rabbit hole, because "job posting URLs" are a dozen different systems wearing a trench coat. A LinkedIn job, a Greenhouse board, a Lever posting, an Ashby page, and a Workday site are completely different beasts, and most render the actual description with client-side JavaScript — so a naive `fetch()` returns an empty shell.

So `fetchJobFromUrl` is a **dispatcher** that recognizes the host and calls the right backend API directly:

- **Greenhouse** → `boards-api.greenhouse.io`
- **Lever** → `api.lever.co` (and it assembles the plain description *plus* the `lists[]` *plus* the closing content — miss those and you get a third of the JD)
- **Ashby** → the posting API
- **Workday** → the `cxs` endpoint, tolerant of the maddening `/en-US/`, `/apply`, and trailing-slash variations
- **LinkedIn** → the `jobs-guest` endpoint
- **Anything else** → look for a JSON-LD `JobPosting` blob, then fall back to Readability content extraction

That JSON-LD fallback alone rescued a bunch of sites. An Adobe posting that returned 1,070 characters of navigation chrome had a complete 6,600-character `JobPosting` object sitting in a `<script type="application/ld+json">` tag the whole time.

---

## The bug that only happened in production

This one cost me an evening and taught me the most, so it gets its own section.

Locally, link-fetching worked perfectly. In production on Vercel, every URL returned **"Could not reach that URL."** Same code, same input, opposite result — the worst kind of bug.

I added a temporary diagnostic endpoint (and immediately learned that App Router treats folders starting with `_` as private, so `/api/_diag` 404s — it had to be `/api/diag`). The logs showed the real error:

```
ERR_REQUIRE_ESM: require() of ES Module .../encoding-lite.js
from html-encoding-sniffer
```

The culprit was **jsdom**, which I was using to parse HTML and extract text. One of its transitive dependencies had gone ESM-only, and Vercel's bundler resolved it differently than my local `next start` did. It's the classic "works on my machine": the deployed serverless function is *not* bundled the same way as your local server, so a dependency graph that resolves locally can explode in production.

The fix was to stop depending on a heavyweight DOM. I replaced jsdom with **[linkedom](https://github.com/WebReflection/linkedom)** (a tiny, pure-JS DOM) plus **[he](https://github.com/mathiasbynens/he)** for entity decoding, and made the JSON-LD extraction **regex-based** so it needs no DOM at all.

Then a *second*, subtler production-only bug surfaced: linkedom's `body.textContent` returned empty for large HTML documents on Vercel (but not locally). The fix was to route text extraction through a element instead:

```ts
const div = document.createElement("div");
div.innerHTML = html;
const text = div.textContent; // reliable where body.textContent wasn't
```

Two lessons I keep coming back to:
- **`next start` is not `vercel deploy`.** If something touches the filesystem, native modules, or ESM/CJS boundaries, test it on a real preview deployment.
- **A cheap diagnostic endpoint beats guessing.** Ten minutes building `/api/diag` saved hours of redeploy-and-pray.

---

## Privacy as an architecture, not a promise

"We don't store your data" is easy to say and hard to prove. Here it's structural:

- The parse → analyze → tailor pipeline is **stateless**. Your resume and the JD flow through request handlers and are never written anywhere.
- The **only** thing that persists is what you *explicitly* save. Signed-in users can click "Save this version," which writes to a per-user Redis hash (`saved:<userId>`, capped at 50). Anonymous use writes nothing, full stop.
- When a JD came from a link, the saved version keeps that link so you can jump back to the original posting — but again, only if you chose to save.

Auth is Clerk, and it's genuinely optional — the entire tailoring flow works signed-out. (Fun migration note: Clerk v7 removed the `<SignedIn>` / `<SignedOut>` control components in favor of a single `<Show when="signed-in">`. Rather than rewrite every call site, I wrote a six-line shim that re-exposes the old names on top of the new primitive. Small thing, but it kept the app code declarative and readable.)

---

## Keeping the free tier alive

An open, free, LLM-backed tool is a metered credit card facing the internet, so there are two independent guardrails — deliberately separate modules, because they answer different questions:

- **Quota** (business logic): each anonymous identity gets 5 free tailor runs, tracked against *both* a client-generated `anonId` *and* the IP, and counted exhausted if *either* hits the limit — so clearing localStorage alone doesn't reset it. It's designed to swap for a paid credits ledger later.
- **Rate limiting** (abuse protection): a per-IP fixed window (30 requests / 60s) on the API routes.

Both sit on a tiny KV abstraction backed by Upstash, with an in-memory fallback for local dev so you can run the whole thing with zero external services.

---

## What I'd tell you to steal

If you're building anything LLM-backed, three ideas here generalize:

1. **Split judgment from generation, and run them in parallel.** Two focused prompts beat one kitchen-sink prompt, and you often don't pay for it in latency.
2. **Make your hard constraints *hard*.** "Don't fabricate" as a hopeful suggestion fails; as the first, loudest rule with a concrete method that routes around temptation ("if it's missing, leave it out"), it holds.
3. **Route models per-task and centralize it.** Cheap where you can, strong where it counts, one file to change your mind.

---

## Try it / break it / fork it

- **Live demo (no account needed):** [careerpath-hazel.vercel.app](https://careerpath-hazel.vercel.app)
- **Source:** [github.com/dukesky/careerpath](https://github.com/dukesky/careerpath)

It's open source and I'm actively improving the tailoring quality. If you try it and the output misses the mark for your field, that's exactly the feedback I want — open an issue or reply. And if this saved you an hour of resume-wrangling, a ⭐ on the repo genuinely helps more people find it.

*I build things end-to-end — from LLM prompts to PDF rendering to auth — and I'm building in public. If you're working on something interesting, say hi.*
