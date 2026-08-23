# Changelog

Notable changes to career-path. Newest first.

The web app has no version number; the extension carries its own in
`extension/manifest.config.ts`. Dates are when the work landed on `main`.

---

## 2026-08-22 — The extension signs in against production Clerk

### Changed

- The production extension build now uses the production Clerk instance
  (`clerk.career-allpath.com`, a `pk_live_` key) instead of the shared dev
  instance; the dev build keeps pointing at the dev instance. Both Clerk
  hosts are in `host_permissions` so the production host is declared before
  the first Chrome Web Store submission — adding one afterwards would
  disable the extension for every existing user until they re-approve it.
- A test decodes each build mode's publishable key and checks it names the
  same Frontend API host as `CLERK_FRONTEND_API`, so the two can't drift.

### Known limits

- Users who signed in to the extension against the dev instance are signed
  out by this build: the production instance has its own user database.

---

## 2026-08-20 — Signing in gives the extension somewhere to go

### Added

- **Sign in from the extension.** A dedicated extension page — not the side
  panel — walks you through email-code or Google sign-in through Clerk, the
  same account system the web app uses. Signed in, your runs count against
  your account instead of a device ID, and the allowance itself changes: 5
  runs a day, instead of the signed-out device tier's 3 runs every 30 days.
- **An account bar in the panel** shows your email and how many runs you have
  left today, with a Sign out control beside it.
- **Sign out asks what to do with this device.** A checkbox, checked by
  default, reads "Also remove my resume and saved results from this
  browser." Checked, sign-out clears your resume and cached results from
  `chrome.storage.local` along with the session. Unchecked, only the session
  ends — the resume and cached results stay.
- **Save**, next to Download PDF, for signed-in users: saves the tailored
  resume to your account, viewable later at `/app/saved`.
- **A session that expires mid-use now tells you, instead of quietly
  spending your device trial.** An expired or unreachable Clerk session
  surfaces as a signed-out state with a prompt to sign in again — it never
  falls through to minting a device token and retrying as one.
- **Never signed in? Nothing changes for you.** If Clerk is unreachable —
  an outage, a blocked domain — a browser that has never signed in carries
  on exactly as it did before sign-in existed. Only a browser with a Clerk
  session to protect refuses to run in that case, and it says so rather
  than quietly spending the device trial instead.

### Changed

- **The extension's toolbar icon** is career-path's own mark, not the
  default puzzle piece. It landed earlier in this same run of commits, ahead
  of the sign-in work above.
- **Installing or updating the extension now asks for one more host.**
  Sign-in needs a host permission for Clerk's Frontend API, which the
  extension contacts directly, and that widens what the Chrome Web Store's
  install prompt shows — accepted as the cost of adding sign-in at all. It
  is the only thing sign-in added to the prompt: no new API permission was
  needed. In particular the extension does **not** request `cookies` —
  Clerk's SDK only uses it for the Sync Host feature listed under Known
  limits below, which this build does not use.

### Known limits

- Browsing saved resumes in the panel is still a link out to `/app/saved` —
  there's no in-panel list yet.
- Clerk's Sync Host doesn't work for side panels, so signing in on the
  career-path website does not carry over into the extension. Sign-in has to
  happen inside the extension itself.

---

## 2026-08-17 — The match score stops moving

### Fixed

- **In the extension's side panel, the "before" score is measured once per
  posting and never recomputed.**
  Generating a posting, adding experience and regenerating used to show the
  left-hand number *falling* — 72 → 72 first, then 62 → 72 — which read as
  "telling you more about me made my resume worse". It was resampling, not a
  real change: that number came from a fresh model call each time, at a
  temperature where a ±10 swing on a 0-100 judgment is ordinary. It is now
  captured on the first run for a posting and carried forward unchanged.
- **`analyze` runs at temperature 0.** It is a judgment task; reproducibility
  is what it needs. `tailor` stays at 0.4 — the same call writes the rewritten
  prose, and cooling it to steady one number would flatten the writing.
- **Cached results are tied to the resume that produced them.** Every entry now
  carries a fingerprint of that resume, and an entry whose fingerprint does not
  match the resume loaded now is treated as absent. Before this, replacing your
  resume left every cached analysis and rewrite on screen, computed from the old
  one, with nothing saying so.

### Changed

- In the extension's side panel, both scores render in multiples of five. An
  integer on a 0-100 scale claimed a precision these numbers do not have: they
  come from two different model calls that never see each other, and the
  right-hand one is genuinely recomputed on every regeneration. Rounding stops
  a meaningless three-point wobble reading as a real change.

### Known limits

- The two numbers still come from two uncalibrated instruments, so the *gap*
  between them carries noise even though the left one no longer moves. Fixing
  that properly means running the rewrite after the analysis so it can be
  anchored to it — which would serialize two calls that currently run in
  parallel and roughly double an already-slow generation. Not done.
- **Replacing your resume invalidates all 20 cached postings**, each costing a
  run to regenerate. That is the price of tying results to the resume that
  produced them, and it falls hardest on the signed-out extension tier.
- Cache entries written before this release carry no fingerprint and are
  discarded on first read — there is no way to confirm which resume produced
  them.
- **"Clear N cached results" still counts every stored entry**, including ones
  hidden by a fingerprint mismatch. The control is about what occupies storage
  and does delete all of them, so N can exceed the number of results you can
  currently see.
- The freeze and the rounding are **the side panel only**. The web app still
  renders both scores raw and still re-measures the "before" number on every
  run. It does get the temperature change, since both share the same route.
- Replacing your resume while a run is in flight leaves that run's result on
  screen when it lands, computed from the resume you just replaced. It is not
  cached as current — the entry is written under the fingerprint captured when
  the run started, so it is discarded on the next read — but nothing on screen
  says so until you navigate away.

---

## 2026-08-16 — Answer a gap without paying twice

### Added

- **Supplementary experience.** When the analysis reports a requirement as
  missing and you actually have it, a box at the bottom of the details takes
  what your resume left out and regenerates from it. The placeholder names the
  requirements *this* analysis marked missing rather than a fixed example. It
  is free text on purpose: a per-gap "I have this" button would be one click to
  assert an experience, and making you write what you actually did is the guard
  against the one thing this product promises never to do.
- **Refining is free, as long as you still have runs left.** A charged run now
  buys up to two regenerations of the same posting under the same `runId`, for
  signed-in and signed-out callers alike. Free of your allowance only — the
  per-IP ceiling still counts every generate, because it bounds spend rather
  than rationing a user. The bound is deliberate: extension code ships
  publicly, and an unlimited free-ride on a reused id would let one
  attacker-chosen id buy uncharged model calls.
- **Your saved resumes ↗** at the bottom of the panel, opening the web app's
  saved list. Signed out, it lands on the sign-in prompt — the extension has no
  session to carry over.

### Changed

- The panel marks a result generated from supplementary experience, under the
  score. The supplement feeds the analysis as well as the rewrite, so the match
  score rises — which means the number is no longer derived from the parsed
  document alone, and the panel has to say so. **The downloaded PDF carries no
  such mark**: that is your document, and stamping a disclosure onto what you
  send an employer oversteps.
- A `runId` stays refinable for 48 hours, up from 10 minutes. The old window
  was shorter than the result cache's lifetime, so a user returning the next day
  would have been charged for a refinement they were told was free.

### Known limits

- Refinement is one shot at a time, not a conversation. The design that would
  help you articulate the experience over a few turns needs a new endpoint, a
  new class of metered call, and prompt work to stop the model proposing
  phrasings you then rubber-stamp. Its output would fill this same field, so
  nothing here is wasted if it gets built.
- Supplementary text is per posting. The same experience typed against five
  jobs is typed five times.
- Cache entries written before this release carry no `runId`, so the first
  regeneration of an older posting is charged as a new run.
- If a regeneration fails and you then switch tabs before retrying, the text you
  typed is lost — the draft is cleared when you navigate away from a posting.
  Retrying without leaving the posting keeps it.

---

## 2026-08-14 — Results layout, PDF download, and a per-posting cache

### Added

- **One-click PDF download.** The tailored resume downloads as a PDF from the
  panel, with no extra network request — the layout renders in the browser. The
  module that produces it moved to `shared/resume-pdf.tsx` and is now the single
  source for both the web app and the extension, so the layout is changed in one
  place. That shares the source, not the exact output — `@react-pdf/renderer`
  depends on its layout engine through a caret range, so the two packages can
  resolve different engine minors and break lines slightly differently.
- **Generated results survive tab switches and panel closes.** Each run is kept
  in `chrome.storage.local`, keyed by the posting's URL — the URL itself is
  part of what's stored, alongside the analysis and tailored resume. Returning
  shows it immediately, stamped `generated <relative time>`, with the primary
  button reading **Tailor again** so a cached result is never mistaken for a
  fresh one. The 20 most recent are kept; the oldest is evicted after that.
- **A clear-cache control** next to the resume card, labelled with the number of
  cached results, and a matching line on `/privacy`. The promise that nothing is
  stored unless you save it remains true of our servers; it is no longer true of
  your own browser, and the page now says so.

### Changed

- The results are ordered score → download → details. The change log,
  requirement matrix and honest gaps moved below the download button: they
  answer "why", which is the second question, and they were sitting between the
  decision and the artifact.
- **Copy tailored resume** is now **Copy as JSON** and lives in the details
  section. It always copied raw JSON; the old label promised what the PDF button
  now actually delivers.
- The cache key is the posting URL with `utm_*`, `ref`, `source`, `trk` and the
  fragment stripped, so the same posting reached from a search result and from a
  shared link is one entry rather than two.

### Known limits

- **Generation still takes about a minute.** Nothing here changes that. The next
  step is to read the per-task, per-model timings already being collected at
  `stats:<task>:<model>` and find out how that minute divides between
  `parse_jd`, `analyze` and `tailor` before swapping any model — guessing risks
  spending the effort for a few seconds while losing rewrite quality.
- The relative timestamp is computed when a result is painted and does not tick.
  It refreshes on the next tab switch back.
- The cache is per-device. It does not sync, by design.
- The extension's manifest now declares `'wasm-unsafe-eval'` in its
  `content_security_policy`. The PDF layout engine compiles to WebAssembly, and
  MV3's default extension-page policy blocks WASM outright — without it the
  download button fails on every click. It is not a permission and does not
  appear in the install prompt, but a Web Store reviewer may ask, and this is
  the answer.

---

## 2026-08-12 — Extension page access and resume review

**Fixes the bug that made the extension unusable.** The side panel could not read
any job posting. Chrome's error was
`Cannot access contents of the page. Extension manifest must request permission
to access the respective host.`

The cause was a seam between three individually-correct decisions: the side panel
is window-global (it outlives the tab it was opened from), page access came only
from `activeTab` (which grants one tab from the gesture that invoked the
extension and is dropped on navigation), and the panel follows tab switches. Any
two compose; all three do not.

### Added

- `host_permissions` for five job sites — LinkedIn, Greenhouse, Lever, Ashby and
  Workday's hosted domain. Postings there now read with no click and no prompt.
  The install prompt names these domains; it does **not** say "all websites".
- `optional_host_permissions` for `http://*/*` and `https://*/*`, **not** granted
  at install and **not** shown in the install prompt. A **Read this site** button
  in the panel requests them from a click, for sites outside the five above. The
  grant is global and persistent, so the button appears at most once.
- A read-only breakdown of the parsed resume, behind a **Review** disclosure on
  the resume card. Shows contact, summary, experience, projects, skills and
  education. A section the parser did not detect is shown as "Not detected"
  rather than hidden — a wrong parse is otherwise invisible, because the tailored
  output still reads fluently.
- **Parsed wrong? Paste your resume text instead** — posts to the existing
  `text` field of `/api/parse-resume`. Re-uploading the same PDF cannot help,
  because the failure happens during text extraction from that file.

### Changed

- Read failures are now typed. A missing host permission offers the grant button;
  a `chrome://` page, `file://` URL or the Web Store says the page cannot be read
  and offers nothing; anything unrecognised says "We couldn't read this page.
  Try reloading it." Previously every failure was diagnosed as a permission
  problem, which on a pre-granted site would prompt the user for the broadest
  possible grant to fix something it could not fix.

### Known limits

- A company white-labelling Workday, Greenhouse or Lever on its own domain
  (`careers.example.com`) is not covered by the five patterns and falls to the
  grant button.
- Job boards embedded in an `<iframe>` are not read — injection targets the top
  frame only.
- Adding a `host_permissions` entry after publishing disables the extension for
  existing users pending re-approval, so the five-site list is effectively frozen
  at publish time. Broaden coverage through the optional grant instead.

---

## 2026-08-11 — Chrome extension (B1)

A loadable MV3 side-panel extension in `extension/`, built with Vite + CRXJS.

### Added

- Side panel: company and role appear the instant it opens, with **zero network
  requests**. One button runs the tailor flow; results render in two stages —
  match score and per-requirement matrix first, then the rewrite and change log.
- The base resume is parsed once and kept in `chrome.storage.local`. It is never
  uploaded for storage — it travels in a request body and is not retained
  server-side.
- JD extraction from the live DOM: `schema.org/JobPosting` JSON-LD first, then
  in-page Readability. Under 300 characters counts as a failed extraction.
  Running in the user's own authenticated browser reaches postings the
  server-side fetcher cannot.
- Device-token lifecycle, an API client that refreshes once on `401` and never
  loops, and a run orchestrator that sends one `runId` to both `/api/analyze` and
  `/api/tailor` so a generate costs one unit of quota rather than two.

### Known limits

- **No sign-in.** Every user is the signed-out device tier: 3 runs per 30-day
  window, with no in-panel way forward once exhausted. Not shippable outside the
  team.
- Extraction is generic. Purpose-written extractors for the five job sites, SPA
  navigation handling, sign-in, and PDF/Markdown export are all still to come.
- Build with `npm --prefix extension run build:dev` to point at a local API;
  the default `build` compiles the production origin in and tree-shakes localhost
  out.

---

## 2026-08-10 — Server foundation for the extension

Hardened the API so a public extension can call it safely. No prompt or model
behaviour changed.

### Added

- **Server-signed device tokens** (`POST /api/device-token`, HS256, 24h).
  Extension code ships publicly and is trivially unpackable, so the previous
  client-generated identifier was not an identity.
- **Tiered quota.** Signed in: 5 per day. Extension device, signed out: 3 per
  30-day window. Web anonymous: 5 per 30-day window, unchanged. A per-IP ceiling
  of 20 per day applies on top, and a caller is blocked when either counter is
  exhausted.
- **One run costs one unit.** `/api/analyze` and `/api/tailor` share a
  client-supplied `runId`; the first leg to succeed charges and the other does
  not. Quota is consumed only on success. A replayed `runId` past the two legs
  charges normally — an unbounded free window would let one attacker-chosen id
  buy uncharged LLM calls.
- **A quota gate on `/api/analyze`**, which previously had only rate limiting.
- **CORS** for allowlisted `chrome-extension://` origins, handled once in
  middleware.
- **LLM instrumentation** — per-call timing and token counts, logged and rolled
  up per task and model. This is the data behind choosing faster models.
- A `/privacy` page, required before a Web Store listing.
- Vitest. The repository previously had no test runner at all.

### Changed

- JD parsing moved to its own `parse_jd` task on a fast model, so it stops
  sitting slowly on the critical path. Resume parsing is unaffected.
- The README's privacy section no longer claims anonymous use stores nothing —
  usage and rate-limit counters have always existed. The pipeline remains
  stateless: resumes and job descriptions are never written to storage, and a
  tailored result is persisted only when a signed-in user explicitly saves it.

### Deployment requirements

Two environment variables are new, and one existing pair became load-bearing:

- `DEVICE_TOKEN_SECRET` (≥32 chars) — without it `/api/device-token` returns 503
  and the extension degrades to anonymous.
- `ALLOWED_EXTENSION_IDS` — comma-separated; empty means no extension origin is
  accepted. Defence in depth rather than required, since MV3 fetches from
  extension pages to `host_permissions` hosts bypass CORS.
- **`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are now a hard
  precondition, not an optimisation.** Without them `getKV()` falls back to a
  per-process in-memory store; analyze and tailor are concurrent invocations that
  land on different instances, so the `runId` marker is not shared and **every
  generate charges twice**. The test suite runs entirely on the in-memory store
  and cannot detect this.
