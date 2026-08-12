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
| `GET /api/quota`     | Current free-tailor quota for the caller — signed-in, extension device, or anonymous (`{ remaining, used, limit }`). |
| `POST /api/device-token` | Mints a server-signed, 24h device identity for a signed-out extension client. |
| `GET/POST /api/saved` | Signed-in only. List saved versions, or save the current one (per-user Redis hash, capped at 50). |
| `DELETE /api/saved/[id]` | Signed-in only. Delete one saved version.                                 |
| `POST /api/waitlist` | `{ email }` → appended to an Upstash Redis list (early-access signup). |

### Quota, rate limiting & abuse protection

Two independent concerns, two modules:

- **Quota** (`src/lib/quota.ts`) — business logic. One "run" = one analyze +
  tailor flow, charged once via a client-supplied `runId` and only on success
  (see `src/lib/auth.ts` for how a caller is identified). Allowances by
  caller: **5 per day** signed in (`quota:user:<userId>:<YYYY-MM-DD>`, 48h
  TTL); **3 per 30-day window** for a signed-out extension device
  (`quota:device:<deviceId>`); **5 per 30-day window** for a signed-out web
  visitor, keyed on the `x-anon-id` header when it's sent
  (`quota:anon:<anonId>`, unchanged from before the extension work) or on IP
  when it's absent (`quota:anon:ip:<ip>`). A per-IP ceiling of **20 per day**
  (`quota:ip:<ip>:<YYYY-MM-DD>`) applies on top of every tier, and a caller is
  blocked when **either** its tier counter **or** the IP counter is exhausted.
  Beta testers with a code in `BETA_ACCESS_CODES` (via `?code=` →
  `x-access-code` header) bypass the quota entirely (rate limiting still
  applies). Extension callers are identified by a server-signed device JWT
  (`Authorization: Bearer <token>`, minted by `POST /api/device-token`)
  rather than a client-generated id, so clearing extension storage alone
  doesn't reset the trial.
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

| Command                  | What it does                                          |
| ------------------------ | ------------------------------------------------------ |
| `npm run dev`             | Start the dev server with hot reload.                  |
| `npm run build`           | Create a production build.                             |
| `npm run start`           | Serve the production build locally.                    |
| `npm run lint`            | Run ESLint.                                             |
| `npm test`                | Run this app's Vitest suite.                            |
| `npm run test:extension`  | Run the [Chrome extension](#chrome-extension)'s Vitest suite (`extension/`). |
| `npm run test:all`        | Run both suites.                                        |

`test:extension` and `test:all` shell out to `npm --prefix extension`. Since
`extension/` is a separate package rather than an npm workspace, its
dependencies aren't pulled in by the root `npm install` — run
`npm --prefix extension install` once (see [Chrome extension](#chrome-extension))
before either of those on a fresh clone, or they'll fail with a missing
`extension/node_modules`.

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
| `DEVICE_TOKEN_SECRET`       | Prod     | Secret for signing Chrome-extension device tokens (HS256). Generate with `openssl rand -base64 32`. |
| `ALLOWED_EXTENSION_IDS`     | Optional | Comma-separated Chrome extension IDs permitted to call the API (CORS). Empty means no extension origin is accepted. |

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

## Chrome extension

`extension/` is a separate, thin-client package (its own `package.json`, not an
npm workspace) that lets you tailor your resume against the job posting in
your active tab without leaving it. It talks to the same API as the web app —
no prompts or model choices live in the extension itself.

```bash
# 1. Install its dependencies (separate from the root install)
npm --prefix extension install

# 2. Build it — against production...
npm --prefix extension run build
# ...or against a local API (http://localhost:3000)
npm --prefix extension run build:dev

# 3. Run its tests
npm --prefix extension run test
```

Then load it unpacked:

1. Open `chrome://extensions`, enable **Developer mode** (top right).
2. Click **Load unpacked** and select `extension/dist`.

The manifest pins a `key`, so the extension ID stays stable across rebuilds —
currently `nipgolameclkfjekaggkmanahaddcbaj`. Add it to the server's
`ALLOWED_EXTENSION_IDS` environment variable (comma-separated) so the API's
CORS layer recognizes it. That check is **defense-in-depth, not the thing
making requests work**: in MV3, a fetch from an extension page to a host
listed in the manifest's `host_permissions` bypasses CORS regardless of
`ALLOWED_EXTENSION_IDS`. When this extension is published to the Chrome Web
Store, it will be assigned its own ID there — append that one to the list too
rather than replacing the dev ID.

B1 ships with no sign-in: every extension user is a signed-out device caller,
sharing the same **3 runs per rolling 30-day window** allowance described
above (`quota:device:<deviceId>`, identified by a server-signed token rather
than anything the client can reset by clearing storage).

## Privacy

career-path is designed to keep your data in your session. The parse → analyze →
tailor pipeline is stateless: resume files and job descriptions are **not** written
to any database or persistent store, whether or not you're signed in. A tailored
result is persisted only when a signed-in user explicitly saves it (stored per-user
in Redis, deletable from *My resumes*).

The server does keep a small amount of **operational** data for every caller, signed
in or not, to enforce the free allowances and watch for abuse: usage counters, rate-limit
counters, and aggregate model timing/token counts with no user content attached. None
of it is your resume, your job description, or a tailored result you didn't explicitly
save.

The complete list lives at [`/privacy`](https://careerpath-hazel.vercel.app/privacy).
