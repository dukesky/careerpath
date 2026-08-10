# Chrome Extension v1 — Design

- **Date:** 2026-08-10
- **Status:** Approved, ready for implementation planning
- **Scope:** Side-panel Chrome extension that tailors the user's resume against the
  job posting they are currently viewing. Auth and per-account quota included;
  billing deferred to v2.

---

## 1. Context

career-path today is a web app: the user opens `/app`, uploads a resume, supplies a
job description (link, pasted text, or screenshots), and gets a gap analysis plus a
tailored resume. That flow works, but it sits *outside* the user's actual job-hunting
session — they have to leave the posting, come to us, and re-supply everything.

### Why an extension is the right next move

The strongest argument is not convenience. It is **data access**.

`src/app/api/fetch-jd/route.ts` (148 lines) plus `src/lib/ats.ts` (470 lines) exist
almost entirely to fight anti-scraping: the LinkedIn guest endpoint, Greenhouse
`gh_jid` rescues, JSON-LD extraction, a Readability fallback, and finally an OCR
path where the user uploads screenshots. The failure message we ship today says it
plainly:

> "Many sites block scraping — paste the text or upload screenshots instead."

A content script runs **in the user's own already-authenticated browser**, against
the DOM the user is looking at. Login-gated LinkedIn postings, JS-rendered Workday
pages, and bot-protected company career sites all become readable. That is a
capability gain, not an ergonomics gain.

Secondary benefits: extension users retain and convert better than one-off web
visitors, and the tool sits at the exact moment of intent ("I want to apply to
this").

### Honest risks going in

- **Crowded category.** Simplify, Teal, Huntr, Jobscan, and Careerflow all ship
  side-panel extensions, most of them free. Our differentiation must stay the
  **honest gap analysis and verifiable diff** — most competitors happily fabricate
  experience. This is already our strength in code; it must survive the port to a
  narrow panel.
- **Unit cost.** Every run is `parse-jd` + `analyze` + `tailor`. A free daily
  allowance multiplied by registered users is real money. Section 6 exists so we can
  measure this instead of guessing.
- **Store review.** Chrome Web Store scrutinizes single-purpose compliance and host
  permissions. Section 3 designs around that rather than hoping.
- **LinkedIn ToS.** Reading a page the user is already viewing, for that user only,
  with no bulk collection, is a materially weaker target than server-side scraping,
  and is what the incumbent extensions all do. The risk is lower, not zero.

---

## 2. v1 scope boundary

**In:** extension shell and side panel · JD extraction from the live DOM · base
resume stored on-device · anonymous device trial · Clerk sign-in inside the
extension · real bearer-token auth on the API · per-account daily quota ·
staged result rendering · LLM latency/cost instrumentation.

**Out (see §9 for the full list):** billing and subscriptions, SSE streaming,
multi-device resume sync, autofill of application forms.

The API's LLM logic — prompts, model routing, normalizers — **does not change** in
v1. The extension is a thin client. Only the API's auth and quota layers are
reworked, plus a new observability hook.

---

## 3. Product surface and main flow

### Trigger

The side panel opens automatically on the five supported job sites. Anywhere else the
user opens it by clicking the extension icon.

### First run (one time)

The panel prompts for a resume, uploads it once to `POST /api/parse-resume`, and
stores the **structured result** in `chrome.storage.local`. The user is never asked
again.

The panel keeps a persistent **My resume** block showing the current resume (name +
parse date) and a **Replace** button. Uploading a new one overwrites it; doing
nothing keeps the existing one indefinitely.

### Main flow — one button, two visible stages

| Moment | What appears in the panel |
| --- | --- |
| Panel opens | `Company · Role title` and the primary **Tailor my resume** button. **Zero network requests.** |
| Stage 1 | **Match score** plus the per-requirement matrix (met / partial / missing, each with evidence from the resume), strengths, and honest gaps |
| Stage 2 | Score becomes **before → after**; the change log; the tailored resume with Preview / Copy as Markdown / Export PDF / Save to cloud\* |

\* Save requires sign-in and writes to the existing `saved:<userId>` hash.

`parse-jd` still runs — `analyze` needs a structured JD — but its output is **not
rendered as its own stage**. Nothing is lost: must-haves and nice-to-haves already
appear as rows in the requirements matrix.

Two consequences of collapsing that stage, both binding requirements:

1. **`parse-jd` must use the fast model.** Time-to-first-content is now
   `parse-jd + analyze` in series, so `parse-jd` sits directly on the critical path.
   It is pure extraction and does not need a quality model.
2. **The loading state must show staged progress copy** — "Reading the role's
   requirements…" → "Comparing against your experience…" → "Writing the tailored
   version…" — not an undifferentiated spinner.

`analyze` and `tailor` are dispatched **in parallel**. `tailor` must not wait on
`analyze`; `src/app/api/tailor/route.ts` already treats `analysis` as optional
precisely for this. Total latency is `max(analyze, tailor)`, not their sum.

### Advanced (collapsed by default)

Contains: view/edit the extracted JD text · extra info (the existing `extraInfo`
field) · Fast/Quality toggle.

It stays collapsed so the primary experience is seamless. It **auto-expands** in
exactly two cases: extraction failed, or extraction returned suspiciously little
content (see §5). Editing the JD text there re-runs from stage 1.

### Quota affordance

Remaining runs sit next to the primary button. When the anonymous trial is exhausted
the button becomes **Sign in to continue — 5 free per day**.

---

## 4. Architecture and repo layout

```
careerpath/
├── src/                        # existing Next.js app — LLM logic untouched;
│                               # auth + quota layers reworked
├── shared/
│   └── contract.ts             # types shared by both sides; no runtime code
└── extension/                  # own package.json, Vite + CRXJS, MV3
    ├── manifest.json
    ├── src/background/         # service worker: side-panel control, token refresh
    ├── src/content/
    │   ├── index.ts            #   host-based dispatch
    │   ├── sites/              #   linkedin / greenhouse / lever / ashby / workday
    │   └── generic.ts          #   in-page Readability fallback
    ├── src/sidepanel/          # React; compact renderer written fresh
    └── src/lib/                # storage / api / auth
```

### Why one repo, not two

The web API deploys on every push; the extension goes through days-to-weeks of store
review. **Old extension against new API is a permanent production state.** Keeping
both in one repo is the only cheap way to see a contract change next to the code that
consumes it — and it keeps `.claude/agents/api-contract-checker.md` useful, which a
split would render dead.

No workspaces / turborepo: that would mean relocating a live, deployed app into
`apps/web` and changing Vercel's root directory for two applications. Not worth the
risk. Vercel only looks at the root Next.js project and ignores `extension/`, so
**deployment configuration does not change.**

Splitting later is easy; merging later is not.

### The extension is a strictly thin client

It does three things: read the DOM, manage the local resume, render results. Every
prompt, model choice, and normalizer stays server-side.

This has a concrete payoff: **changing models or prompts never requires store
review.** Given that model selection is an explicit ongoing goal (§8), this matters.

### Data flow

```
content script reads DOM ──┐
                           ├─→ side panel ─→ Bearer token ─→ existing API ─→ staged render
chrome.storage.local ──────┘   (resume passes through the request body only;
                                the server never persists it)
```

### What `shared/contract.ts` holds

Only the type shapes crossing the wire: `ParsedResume`, `ParsedJD`, the gap-analysis
result, and the tailor result. Both sides import them with `import type`, so nothing
is pulled into the extension bundle at runtime. The prompts and normalizers in
`src/lib/{resume,jd,analysis}.ts` stay exactly where they are; the type declarations
move to `shared/` and are re-exported from their current modules so existing imports
keep working.

---

## 5. JD extraction

### Dispatch

The content script routes by host: the five supported sites get purpose-written
extractors; everything else gets in-page Readability.

`ats.ts` **code is not reusable** — it hits platform APIs and parses raw HTML
server-side, while the extension reads rendered DOM. What *is* reusable is the
knowledge encoded there: where each platform puts the JD body, title, and company.
Reimplementation, not rediscovery.

### SPA navigation (mandatory)

LinkedIn and Workday change the URL without a page load when the user clicks the next
job. The content script listens to History API changes and a MutationObserver, and on
a detected job change it re-extracts **and clears any rendered result**.

Showing job A's analysis under job B is worse than showing nothing. This is a
correctness requirement, not a polish item.

### Quality gate

Extraction is treated as failed when the text is under **300 characters**, or when it
matches known noise patterns (related-jobs rails, nav chrome). Failure auto-expands
Advanced with "We couldn't read this posting — paste the JD here."

### Permissions (this determines whether we pass review)

`host_permissions` lists **only** the five supported sites. Every other origin goes
through `optional_host_permissions`, requested the first time the user clicks the
icon on that site. Requesting `<all_urls>` up front invites exactly the review
friction we can avoid.

We extract **text**. Not screenshots, not the DOM tree.

---

## 6. Identity, auth, and quota

### Three layers

1. **Anonymous device.** On install, the background worker calls
   `POST /api/device-token`. The **server** generates the device id and signs a
   JWT (HS256, secret server-side only) with a **24-hour TTL**. The extension stores
   it in `chrome.storage.local`; the background worker refreshes it on browser
   startup and whenever the token is within an hour of expiring. The critical
   difference from today: the device id is server-issued, not a client-side
   `crypto.randomUUID()` like `newId()` in `src/lib/anon.ts`. Extension code is
   public and unpackable; a self-generated id resets quota by editing one string.
2. **Signed in.** `@clerk/chrome-extension`; the Clerk session token is the bearer.
3. **API side.** Each protected route parses `Authorization` into
   `{kind: "user", userId}` or `{kind: "device", deviceId}`. Per-IP rate limiting
   (`src/lib/rate-limit.ts`) continues to apply to everyone.

The existing `x-anon-id` header path stays for the current web app so it keeps working
unchanged; it is simply not trusted for extension traffic.

A server-issued device token raises the bar but is not a wall — uninstall/reinstall or
a fresh browser profile defeats it. The per-IP cap is the real backstop, which is why
the anonymous allowance is deliberately small.

### Quota model (rewrite of `src/lib/quota.ts`)

| Key | Applies to | Allowance | TTL |
| --- | --- | --- | --- |
| `quota:user:<userId>:<YYYY-MM-DD>` | any signed-in user, web or extension | 5 per day | 48h |
| `quota:device:<deviceId>` | extension, signed out | 3 total, never resets | 30 days |
| `quota:anon:<anonId>` | **web app, signed out — unchanged from today** | 5 total | 30 days |
| `quota:ip:<ip>:<YYYY-MM-DD>` | everyone | 20 per day (abuse ceiling) | 48h |

The existing `quota:anon:<anonId>` row is kept verbatim so **current web behavior does
not regress**. Two things do change for the web app, both improvements: signing in now
grants a daily allowance instead of sharing the anonymous counter, and the per-IP
ceiling becomes daily rather than a 30-day total.

Anonymous usage does **not** carry over on sign-in; the user simply receives that
day's fresh allowance. Simplest to build and nobody complains about being given more.

A caller is blocked when **either** its identity-tier counter **or** the IP counter is
exhausted — same "whichever hits first" rule the current implementation uses.

### Closing the `/api/analyze` hole

`analyze` currently has rate limiting but **no quota gate** — only `tailor` consumes.
In the extension `analyze` is independently callable, so leaving it open gives away
half the expensive work.

**Design:** the client generates a `runId` (UUID) per run and sends it with both
`analyze` and `tailor`.

- Both endpoints **check** quota before doing any work and return `402` when exhausted.
- On **success**, the endpoint does `incr("run:<identity>:<runId>")` (TTL 10 minutes).
  A result of `1` means this is the first success in the run → consume one unit of
  quota. Anything higher → do not consume.
- On **failure**, the marker is not touched.

This is parallel-safe, preserves today's "only successful runs cost the user"
behavior, works identically for the web app and the extension, and costs the frontend
one extra field.

### Error handling

| Condition | Behavior |
| --- | --- |
| `401` (token expired) | Refresh once silently; on a second failure, prompt to sign in |
| `402` (quota exhausted) | Replace the primary button with the sign-in / upgrade CTA |
| `429` (rate limited) | Show a wait message; do not auto-retry |
| `502` (LLM failure) | Show a retry button; no quota was consumed |
| Extraction failure | Auto-expand Advanced with a paste prompt |
| Job changed mid-run | Cancel in-flight requests and reset the panel |

---

## 7. Data and privacy boundary

**The complete list of what the server persists** is exactly five things: quota
counters, rate-limit counters, device ids, tailored versions a signed-in user
explicitly saved (`saved:<userId>`), and waitlist emails.

- **Base resume** → `chrome.storage.local`. Never written to server-side storage. It
  passes through the request body during parse/analyze/tailor and is not retained.
- **JD text** → same; not persisted. Unchanged from today.
- **Tailored output** → not stored by default; written only when a signed-in user
  clicks Save. Unchanged from today.

Supporting work: add a `/privacy` page to the existing Next app (the Web Store
requires one); add a short extension paragraph to the README's privacy section.

**"Nothing stored unless you save" remains literally true in the extension.** It is
the one claim we can make that Simplify and Teal cannot. Implementation must not
quietly break it.

---

## 8. Observability — the basis for model selection

Instrument `callLLM` in `src/lib/llm.ts` uniformly: `task`, `model`, `quality`,
duration, prompt and completion tokens, success/failure.

v1 uses two cheap channels: structured `console.log` (queryable in Vercel logs) and a
rolling Redis aggregate at `stats:<task>:<model>:<date>` holding counts and summed
durations. In dev builds the side panel displays per-stage timings.

Model routing is already centralized in `MODEL_MAP` / `QUALITY_MODELS`, so swapping
models is a one-file change that ships without store review.

This gives objective data for **fast**. **Good enough** is subjective and needs a
fixed evaluation set of (resume, JD) pairs for regression comparison — that is v2
work. v1's obligation is only that the instrumentation exists and data is
accumulating.

---

## 9. Explicitly out of scope for v1

- Stripe / subscriptions (v2 — v1 establishes the account and quota layer it needs)
- SSE streaming (v2 — partial-JSON parsing would complicate the `normalizeXxx`
  defensive layer; staged rendering already captures most of the perceived win)
- Multi-device resume sync (follows from the on-device storage decision)
- **Multiple base resumes** (e.g. separate SDE and MLE versions) — a genuine user
  need, consciously deferred
- Application-form autofill (Simplify's core product; a different product from ours)
- Application tracking
- Cover-letter generation
- Purpose-written extractors beyond the five supported sites

---

## 10. Testing

- **Extraction fixtures.** Saved HTML snapshots of each supported site, tested
  offline. Live sites change; fixtures make breakage visible as a failing test rather
  than a user complaint.
- **Contract tests.** `shared/contract.ts` shapes against the normalizers in
  `src/lib/{resume,jd,analysis}.ts`.
- **Quota unit tests.** `src/lib/kv.ts` already falls back to an in-memory store, so
  the daily-reset, device-cap, and `runId` dedup logic are testable without Redis —
  including the parallel case where `analyze` and `tailor` both succeed.
- **Auth tests.** Unauthenticated calls to protected routes return `401`; expired
  tokens refresh; device tokens cannot be forged client-side.
- **Manual QA checklist.** All five sites, plus SPA navigation between postings, plus
  one unsupported site through the generic fallback and the optional-permission
  prompt.

## 11. Success criteria

1. Company and role appear in the panel within ~500ms of opening it, with no network
   request.
2. JD extraction succeeds on all five supported sites, verified against a manually
   checked batch of live postings.
3. Stage 1 (match score and requirement matrix) renders well before stage 2; both
   stages are individually useful.
4. Switching jobs in a LinkedIn SPA session never shows a stale result.
5. The anonymous 3 runs → sign-in → 5-per-day path works end to end.
6. Calling any protected API route without a valid token returns `401`.
7. `callLLM` timing and token data is queryable per task and per model.
