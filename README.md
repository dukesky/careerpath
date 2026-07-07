# career-path

**Tailor your resume to any job description — nothing stored, nothing saved.**

A privacy-first web app: upload your resume, paste a job description, and get a
tailored resume plus an honest gap analysis. Nothing is persisted — your resume
and JD are processed in-session only.

Built with **Next.js 15 (App Router)**, **TypeScript**, and **Tailwind CSS**.

> **Status:** End-to-end flow works — upload/parse a resume, ingest a job
> description (URL / paste / screenshots), then **Analyze & Tailor** produces a
> gap analysis and a truthfully-rewritten resume with a change log.

## Pages & endpoints

| Route                | Description                                                                    |
| -------------------- | ------------------------------------------------------------------------------ |
| `/`                  | Landing page — value prop and a 3-step overview.                               |
| `/app`               | Workspace — resume + JD inputs, then the analysis/tailored-resume results view. |
| `POST /api/parse-resume` | Multipart PDF/DOCX (≤5MB) **or** a `text` field → extracted (`unpdf`/`mammoth`) → structured resume JSON. |
| `POST /api/fetch-jd` | `{ url }` → server-side fetch + Readability extraction. `{ ok:false, reason }` on failure. |
| `POST /api/ocr-jd`   | 1–4 image uploads (PNG/JPG, ≤4MB each) → single vision call → transcribed JD text. |
| `POST /api/parse-jd` | `{ text }` → structured JD JSON.                                                |
| `POST /api/analyze`  | `{ structuredResume, structuredJD, extraInfo }` → gap analysis (score, requirements matrix, strengths, gaps). |
| `POST /api/tailor`   | analyze inputs + `analysis` → rewritten resume (same schema) + `change_log`. Never fabricates facts. |

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

| Variable             | Required | Description                                                             |
| -------------------- | -------- | ---------------------------------------------------------------------- |
| `OPENROUTER_API_KEY` | Yes\*    | OpenRouter API key for resume analysis (used server-side). The model is served via [OpenRouter](https://openrouter.ai). |

\* Not yet consumed by the current UI-only scaffold, but required once the
analysis backend is wired up. Keep it server-side only — never expose it with a
`NEXT_PUBLIC_` prefix.

## Deploy to Vercel

1. **Push to a Git provider** (GitHub, GitLab, or Bitbucket).
2. In the [Vercel dashboard](https://vercel.com/new), click **Add New → Project**
   and import the repository. Vercel auto-detects Next.js — no build config
   needed.
3. Under **Settings → Environment Variables**, add `OPENROUTER_API_KEY` for the
   Production (and Preview) environments.
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

career-path is designed to keep your data in your session. Resume files and job
descriptions are not written to any database or persistent store.
