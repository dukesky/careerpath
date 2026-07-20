<div align="center">

# 🎯 career-path

### Tailor your resume to any job description — in 30 seconds, without lying.

Upload your resume, paste a job link, and get it **rewritten for that specific role** —
plus an **honest gap analysis** of where you fall short. Your data is processed
in-session and **never stored unless you sign in and explicitly save a version**.

**[▶ Try the live demo](https://careerpath-hazel.vercel.app)** &nbsp;·&nbsp; **[⭐ Star this repo](https://github.com/dukesky/careerpath)** &nbsp;·&nbsp; [Report an issue](https://github.com/dukesky/careerpath/issues)

<br/>

![Next.js](https://img.shields.io/badge/Next.js-15-000000?logo=next.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v4-06B6D4?logo=tailwindcss&logoColor=white)
![Vercel](https://img.shields.io/badge/Deployed_on-Vercel-000000?logo=vercel&logoColor=white)
![Claude](https://img.shields.io/badge/LLM-Claude_%2B_DeepSeek-7C3AED)
![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)

<br/>

<!--
  ⬇ HIGH-LEVERAGE TODO: record a 15–20s screen recording (paste JD → generate → diff),
  save it as docs/demo.gif, then delete this comment and uncomment the <img> below.
  A GIF here is the single biggest thing for converting repo visitors into stars.

  <img src="docs/demo.gif" alt="career-path demo — paste a job description and get a tailored resume with a gap analysis" width="820" />
-->

</div>

---

> 💻 **Prefer the command line?** There's also a free, open-source **CLI skill** —
> [**resume-tailor**](https://github.com/dukesky/resume-tailor) — that runs the same
> honest tailoring method right inside Claude Code, Codex, or any
> [Agent Skills](https://agentskills.io) tool. No upload, no API keys.

## Why it's different

- **🔒 Private by design.** Your resume and the JD are processed in-session. Nothing
  is persisted unless you sign in and click *Save this version*.
- **🚫 It won't lie for you.** It reorders, re-emphasizes, and surfaces keywords from
  your **real** experience — but never invents a title, metric, or skill you don't have.
- **📊 Honest gap analysis.** A match score (before → after), a requirements matrix,
  and the gaps you genuinely can't fake.
- **🔍 Verifiable.** A *what changed & why* view and a word-level diff show every edit
  before you export.
- **🔗 Ingests JDs from anywhere.** Paste text, a screenshot, or a link — with direct
  fetchers for LinkedIn, Greenhouse, Lever, Ashby & Workday.

Built with **Next.js 15 (App Router)**, **TypeScript**, and **Tailwind CSS**.

## How it works

A four-step pipeline — all in one session, nothing stored by default.

1. **Add your resume.** Upload a PDF or DOCX (≤5 MB) or paste the text; it's
   parsed into structured JSON (`unpdf` / `mammoth`).
2. **Add the job description** — three ways in, in order of convenience:
   - **Paste a link** — direct fetchers pull the full JD from **LinkedIn,
     Greenhouse, Lever, Ashby & Workday**, with a JSON-LD + Readability fallback
     for everything else.
   - **Paste the text** — always works.
   - **Upload 1–4 screenshots** — a vision model transcribes them.
3. **Analyze & Tailor** — two LLM calls run in parallel:
   - **Gap analysis** — an overall match score, a requirements matrix (every
     must-have / nice-to-have marked met / partial / missing, with evidence),
     your top strengths, and honest gaps with realistic mitigation.
   - **Tailored resume** — rewritten to foreground the role's top themes using
     **only your real experience**, plus a change log and a projected score.
4. **Review, edit & export.** Tabs for **Preview**, **Changes (diff)**, **What
   changed & why**, and **Edit**; a **before → after** match score; live inline
   editing; **Copy as Markdown**; and one-page **PDF export**. Optionally sign in
   to **save a version** to *My resumes* — the only thing ever persisted.

## Features

- 📄 **Resume parsing** from PDF / DOCX / pasted text
- 🔗 **JD ingestion** from a link (multi-ATS), pasted text, or screenshots (OCR)
- 📊 **Honest gap analysis** — match score, requirements matrix, strengths, gaps
- ✍️ **Truthful tailoring** — a theme-first rewrite that never fabricates facts
- 🔀 **Before → after match score** so you can see the lift a rewrite gives
- 🧾 **Diff + change log** — verify every edit before you send it
- 🖊️ **Inline editing** — tweak the result; preview, copy, and PDF update instantly
- 📥 **One-page PDF export** (`Name_Company_Resume.pdf`) + copy as Markdown
- 💾 **Opt-in saved versions** — sign in and save; find them under *My resumes*,
  each with a link back to the original posting
- ⚡ **Fast / Quality model toggle**
- 🔒 **Private by design** — in-session processing; nothing stored unless you save

## Pages & endpoints

| Route                | Description                                                                    |
| -------------------- | ------------------------------------------------------------------------------ |
| `/`                  | Landing page — value prop and a 3-step overview.                               |
| `/app`               | Workspace — resume + JD inputs, then the analysis/tailored-resume results view. |
| `/app/saved`         | **My resumes** — versions a signed-in user chose to save (preview / export / delete). |
| `/demo`              | No-backend preview of the results UI with sample data (no API calls).          |
| `POST /api/parse-resume` | Multipart PDF/DOCX (≤5MB) **or** a `text` field → extracted (`unpdf`/`mammoth`) → structured resume JSON. |
| `POST /api/fetch-jd` | `{ url }` → server-side fetch + Readability extraction. `{ ok:false, reason }` on failure. |
| `POST /api/ocr-jd`   | 1–4 image uploads (PNG/JPG, ≤4MB each) → single vision call → transcribed JD text. |
| `POST /api/parse-jd` | `{ text }` → structured JD JSON.                                                |
| `POST /api/analyze`  | `{ structuredResume, structuredJD, extraInfo }` → gap analysis (score, requirements matrix, strengths, gaps). |
| `POST /api/tailor`   | analyze inputs + `analysis` → rewritten resume (same schema) + `change_log`. Never fabricates facts. Quota-gated (returns `402` when exhausted). |
| `GET /api/quota`     | Current anonymous free-tailor quota for the caller (`{ remaining, used, limit }`). |
| `GET/POST /api/saved` | Signed-in only. List saved versions, or save the current one (per-user Redis hash, capped at 50). |
| `DELETE /api/saved/[id]` | Signed-in only. Delete one saved version.                                 |
| `POST /api/waitlist` | `{ email }` → appended to an Upstash Redis list (early-access signup). |

### Quota, rate limiting & abuse protection

Two independent concerns, two modules:

- **Quota** (`src/lib/quota.ts`) — business logic. Each anonymous identity gets
  **5 free tailor runs** (one analyze+tailor flow = one run). Beta testers with a
  code in `BETA_ACCESS_CODES` (via `?code=` → `x-access-code` header) get
  **unlimited** runs, bypassing the quota (rate limiting still applies). Tracked against
  **both** a client `anonId` (localStorage UUID, sent via the `x-anon-id`
  header) **and** the client IP, and counted exhausted if **either** hits the
  limit — so clearing localStorage alone doesn't reset it. Keys expire after 30
  days. Designed to be swapped for a paid credits ledger later.
- **Rate limiting** (`src/lib/rate-limit.ts`) — abuse protection. Per-IP fixed
  window (30 requests / 60s) on the API routes.

Both share a small KV abstraction (`src/lib/kv.ts`) backed by Upstash Redis,
falling back to an in-memory store when Upstash isn't configured. Server-side
input caps: resume 15k chars, JD 10k chars, extra info 5k chars.

### Accounts & saved versions

Auth is handled by **[Clerk](https://clerk.com)** and is entirely **optional** —
the full tailoring flow works signed-out and stores nothing. Signing in unlocks a
single feature: **opt-in saving.** Clicking *Save this version* writes the current
tailored resume to a per-user Redis hash (`saved:<userId>`, capped at 50 versions)
via `src/lib/saved.ts`; those versions appear at `/app/saved` ("My resumes"),
each with a link back to the original posting when the JD came from a URL. Nothing
is written unless the user explicitly saves. (Clerk v7 removed the
`<SignedIn>`/`<SignedOut>` control components; `src/components/clerk-auth.tsx` is
a small shim that re-exposes them on top of the new `<Show>` primitive.)

### Model routing

All model choices live in one place — `src/lib/llm.ts` (`MODEL_MAP` /
`QUALITY_MODELS`). Calls go through OpenRouter via the `openai` package. A
`quality` flag (`"fast" | "quality"`) overrides the analyze/tailor model; OCR is
pinned to a vision-capable model regardless.

## Prerequisites

- **Node.js 18.18+** (Node 20+ recommended)
- **npm** (or pnpm/yarn/bun — commands below use npm)

## Local development

```bash
# 1. Install dependencies
npm install

# 2. Set up environment variables
cp .env.example .env.local
# then open .env.local and add your OPENROUTER_API_KEY

# 3. Start the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The workspace lives at
[http://localhost:3000/app](http://localhost:3000/app).

### Available scripts

| Command         | What it does                          |
| --------------- | ------------------------------------- |
| `npm run dev`   | Start the dev server with hot reload. |
| `npm run build` | Create a production build.            |
| `npm run start` | Serve the production build locally.   |
| `npm run lint`  | Run ESLint.                           |

## Environment variables

| Variable                    | Required | Description                                                             |
| --------------------------- | -------- | ---------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`        | Yes      | OpenRouter API key for parse/analyze/tailor/OCR (used server-side). The model is served via [OpenRouter](https://openrouter.ai). |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Yes | Clerk publishable key — required for the app to render (auth provider). Get one at [clerk.com](https://clerk.com). |
| `CLERK_SECRET_KEY`          | Yes      | Clerk secret key (server-side) — backs sign-in and the saved-versions API. |
| `UPSTASH_REDIS_REST_URL`    | Prod     | Upstash Redis REST URL — backs quota, rate limiting, saved versions, and the waitlist. |
| `UPSTASH_REDIS_REST_TOKEN`  | Prod     | Upstash Redis REST token.                                              |
| `NEXT_PUBLIC_SITE_URL`      | Optional | Canonical site URL for absolute OG/Twitter share-image links. Falls back to the Vercel production URL, then `localhost`. |
| `BETA_ACCESS_CODES`         | Optional | Comma-separated codes granting unlimited tailors (via `?code=`). |

Keep the secret values server-side only — never expose them with a
`NEXT_PUBLIC_` prefix (the two `NEXT_PUBLIC_` vars above are intentionally
client-safe). Without the Upstash vars the app still runs, but quota/rate-limit/
saved-versions/waitlist use a per-process in-memory store that is **not shared
across serverless instances** — so set them for any real deployment. The Clerk
keys are required for the app to boot; grab free test keys from the Clerk
dashboard for local development.

## Deploy to Vercel

1. **Push to a Git provider** (GitHub, GitLab, or Bitbucket).
2. In the [Vercel dashboard](https://vercel.com/new), click **Add New → Project**
   and import the repository. Vercel auto-detects Next.js — no build config
   needed.
3. Under **Settings → Environment Variables**, add `OPENROUTER_API_KEY`, the two
   Clerk keys (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`), and — for
   real deployments — the Upstash Redis vars, for the Production (and Preview)
   environments.
4. Click **Deploy**. Every push to your default branch ships to production;
   every other branch/PR gets a preview URL.

### Deploy from the CLI (optional)

```bash
npm i -g vercel
vercel            # first run links the project and creates a preview
vercel --prod     # promote to production
```

Pull the project's environment variables into your local `.env.local` at any
time with:

```bash
vercel env pull .env.local
```

## Privacy

career-path is designed to keep your data in your session. The parse → analyze →
tailor pipeline is stateless: resume files and job descriptions are **not** written
to any database or persistent store. The **only** data that is ever persisted is a
tailored version you explicitly save while signed in (stored per-user in Redis and
deletable from *My resumes*). Anonymous use stores nothing.
