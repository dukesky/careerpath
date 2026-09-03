# career-path end-to-end evaluator

A Playwright harness that loads the **real** Chrome extension into **real**
Chromium, signs in with a **real** Clerk session, clicks the **real** "Tailor
my resume" button, and asserts the one thing no unit test can fake: **after a
signed-in user generates, does that user's own allowance go down?**

This exists because the project's characteristic failure is a feature that is
green in 391 unit tests, green in `tsc`/`lint`/`build`, deployed successfully,
and broken in a browser. Everything below is chosen to be observable from
outside the code under test.

**Nothing in here touches product code.** All harness code lives in
`evaluator/`; the only change outside it is four `.gitignore` lines.

---

## Running it

```bash
cd evaluator
npm install                     # first time only
npx playwright install chromium # first time only

node run-eval.mjs                          # the scored run (2 paid generates)
node run-eval.mjs --mutation=stale-build --skip-anonymous   # must FAIL
node run-eval.mjs --mutation=hang-tailor                    # must FAIL (timeout)
```

Each invocation writes `reports/<ISO timestamp>.json`, `.md`, and a
`-shots/` directory of screenshots. Exit code is 0 only for `PASS`.

The harness owns every process it needs and kills them on the way out
(including on Ctrl-C): the Next dev server, a recording proxy, a fixture web
server, and Chromium. It leaves nothing listening on a port and no git
worktree behind.

### Cost

Every scored generate is four real OpenRouter calls — parse-jd, analyze,
tailor, and the post-tailor **rescore** — about **$0.15**. Budget per
invocation:

| invocation | paid generates |
| --- | --- |
| no mutation | 2 (signed-in run + anonymous regression run) |
| no mutation `--skip-anonymous` | 1 |
| `--mutation=stale-build --skip-anonymous` | 1 |
| `--mutation=hang-tailor` | ~⅔ (tailor is never forwarded upstream) |

`--stub-llm` answers parse-jd/analyze/tailor/rescore from the proxy with canned JSON:
free, and useful for debugging the harness itself. It charges no quota, so it
**always** reports `CANNOT_MEASURE` and is never evidence about the product.

### Options

| flag | meaning |
| --- | --- |
| `--mutation=stale-build` | build the extension from `d19021d` (before the panel minted run tokens) and load that instead |
| `--mutation=hang-tailor` | accept `POST /api/tailor` and never answer it |
| `--headed` | headed Chromium (the default tries new headless first and falls back) |
| `--stub-llm` | canned LLM responses; debugging only |
| `--skip-anonymous` | skip A6, saving one paid generate |
| `--run-timeout-ms=N` | A5's ceiling (default 180000) |
| `--rescore-timeout-ms=N` | A7's ceiling for the post-tailor rescore leg (default 90000) |
| `--dev-port=N` / `--fixture-port=N` | move the internal ports |

---

## How the measurement is set up

Six pieces have to be arranged before the click means anything.

**The extension is the real dev build.** `npm run build:dev` in `extension/`,
loaded unpacked with `--load-extension`. The extension ID is *derived* from the
manifest's pinned `key` (SHA-256 of the DER public key, nibbles mapped to a–p),
so a build whose key drifted fails here rather than as an unexplained 404.

**The dev server is a child process, and it is not on port 3000.** Vite inlines
`http://localhost:3000` into the extension at build time, so port 3000 has to
be that origin. The Next dev server runs on **3001** and a **recording reverse
proxy** takes 3000.

*Why the proxy:* the four calls a generate makes (`parse-jd`, `analyze`,
`tailor`, and the post-tailor `rescore`) are made by the extension's **service
worker**. They never appear in the panel page's network log, and Chromium's
service-worker network events are experimental. A proxy on the wire sees every
request from every realm with its `Authorization` header intact — which is
assertion A2, the most decisive evidence available. The proxy forwards headers
verbatim and deliberately adds **no** `x-forwarded-for`, because that would
switch on the server's per-IP quota ceiling that a direct localhost request
does not trigger.

**The JD fixture is served on a greenhouse.io hostname.** The panel reads the
active tab by injecting a content script, which needs a host permission. The
manifest grants five job sites at install and everything else only through
`chrome.permissions.request`, which raises a **native Chrome dialog no
automation can dismiss**. So `fixtures/jd.html` is served by a local server and
`--host-resolver-rules=MAP boards.greenhouse.io 127.0.0.1:4599` points the
hostname at it. The panel reads it with no dialog and no click.

**Tab layout is load-bearing.** `useActiveJd` reads the **active** tab of the
panel's own window. If the panel tab is active, the tab it reads is a
`chrome-extension://` page, `executeScript` fails, and the panel sets `jd=null`
— which disables the button and resets the display. So the JD fixture tab is
kept **active** and the panel is driven as a **background tab** in the same
window. Consequently clicks are dispatched in-page rather than through
Playwright's input pipeline. That is safe here and only here: the single code
path in this extension needing a *trusted* gesture is
`chrome.permissions.request`, and the fixture's host permission means that path
is never reached. "Tailor my resume" is a plain React `onClick`.

**Sign-in is Clerk test mode, and nothing else.** The dev instance reports
`test_mode: true` and `first_factors: ["email_code"]` for email addresses — no
password first factor. The account is `evaluator+clerk_test@example.com`, whose
verification code is fixed at `424242` and whose mail is never sent. The
account is created once through the Clerk **Backend API** with
`skip_password_requirement`, using the `CLERK_SECRET_KEY` already in
`.env.local` — because driving the *sign-up form* would mean typing a password
and defeating a captcha, both out of bounds. **No real account, no password,
no Google OAuth is ever automated.**

**A fresh profile every run.** `cp_beta_code` lifts the quota cap entirely, so
a leftover one would void every quota assertion (see P3). The profile is
deleted afterwards.

---

## Reading a report

### Verdict

- `PASS` — every preflight passed and every assertion passed.
- `FAIL` — preflight was clean, so the measurement is trustworthy, and at
  least one assertion failed. **This is a useful result, not a broken run.**
- `CANNOT_MEASURE` — a preflight failed (or `--stub-llm` was set), so nothing
  the assertions say can be trusted. A run in this state is never reported as
  a pass.

### Preflight — any failure means the measurement is void

| id | check | why it gates |
| --- | --- | --- |
| P1 | `npm run build:dev` succeeded and the panel bundle greps for `api/run-token` **and** `localhost:3000` | measuring a stale or production-pointed build measures nothing. Reported as `N/A` (recorded, not gating) under `--mutation=stale-build`, where an old build is the whole point |
| P2 | dev server up; anonymous `GET /api/quota` is 2xx through the proxy | also forces Next to compile the route, so A5's budget is not spent on a cold compile |
| P3 | fresh profile, no `cp_beta_code`, and the panel states a **numeric** daily allowance of 5 | a beta code makes the allowance unlimited and every quota assertion vacuous |
| P4 | the panel shows the test account's email | a signed-out panel would exercise the anonymous path while claiming to test the signed-in one |

### Assertions

| id | assertion | evidence to look at |
| --- | --- | --- |
| A1 | the panel POSTs `/api/run-token` and gets a non-empty `token` | the proxy record for `/api/run-token`, plus the panel page's own response log |
| A2 | the **worker's** `/api/analyze` carries a `uid` claim and no `did` | `identityKinds` — `run-token(uid)` is the user, `device-token(did)` is an anonymous device. Decoded from the real header on the wire |
| A3 | **the one that matters**: the panel's allowance goes `5 runs left today` → `4 runs left today` | `panelBefore` / `panelAfter`, plus `serverReportedRemaining` from the server's own analyze/tailor/quota bodies |
| A4 | after signing out, the device trial still reads `3 runs left` | if it reads less, the signed-in run was billed to the device bucket — check `workerRequestsCarriedDeviceToken` |
| A5 | one generate reaches **first paint** (the run's `done` phase) within the ceiling | `elapsedMs` vs `ceilingMs`, and the phase sequence. Deliberately excludes the rescore leg, which starts only after that paint — see A7 |
| A6 | signed out, a generate still completes and the device trial goes `3` → `2` | signing in is an upgrade, never a gate — this is the hard-constraint regression |
| A7 | the post-tailor rescore: `POST /api/rescore` → 200 under the **same `uid`** as the other legs, the allowance still moves by exactly **one**, the panel's after-number **equals the rescore's own score**, and a forged `runId` is refused 4xx | `rescoreRequest` (identity + `facts.score`), `quota.usedDelta`, `panel.after` vs `panel.rescoreResponseScore`, `forgedRunId.status`, and `rescoreCallMs` vs its 90s ceiling — the LEG's own duration, not `msFromClickToRescoreSettled`, which includes the whole generate in front of it |

`UNMEASURED` means the harness could not observe the thing at all (it is not a
pass). `SKIPPED` means a flag or an earlier failure made the check moot.

The wording distinction in A3 vs A4 is deliberate and load-bearing: **"N runs
left today"** is the signed-in daily allowance; **"N runs left"** (no "today")
is the signed-out device trial. A panel showing the device bucket's number
under the signed-in wording is exactly the "the quota on screen is a lie"
failure — and it is what `--mutation=stale-build` reproduces.

### The API traffic table

Every request the extension made, in order, with the realm it came from
(`panel` / `worker`), the status, and the decoded identity. This is usually the
fastest way to see what actually happened. Read the claims as data, not as
proof of correctness: a `uid` on the wire says the run *claimed* to be the
user; only A3 says the user was *charged*.

---

## Self-falsification

An evaluator that has never produced a FAIL cannot be trusted to produce a
PASS. Two mutations exist to prove it can.

**`--mutation=stale-build`** builds the extension from commit `d19021d` in a
temporary `git worktree` (`node_modules` symlinked, worktree removed
afterwards) — the last commit before the extension side learned about run
tokens. This reproduces "the user's browser still has the old package"
exactly. Expected: A1 absent, A2 `device-token(did)`, A3 stuck, A4 showing the
device bucket drained, and A7 failing with no `/api/rescore` request on the
wire at all (that build predates the route). **If this reports PASS, the
evaluator is broken.**

**`--mutation=hang-tailor`** makes the proxy accept `POST /api/tailor` and
never answer it — the socket is held open, so the client sees a hang rather
than a connection error, and the request is never forwarded upstream (so no
tailor LLM call is paid for). Expected: A5 times out, run never reaches a
terminal state, A4/A6/A7 skipped. This is the class of failure a model-routing
accident produces, and A5 is the only assertion that catches it.

---

## Known limits

- **A2 measures the header, not the accounting.** A `uid` claim proves the
  request *claimed* to be the user. Only A3 proves the user was charged. Keep
  them separate when reading a report.
- **A7's identity check is stronger than A2's, by accident of the server.**
  `/api/rescore` gates on a run marker keyed on the caller, so a rescore that
  fell back to the device identity would be refused 403 rather than quietly
  succeed. A 200 there is therefore evidence about the accounting, not just
  about the header.
- **A7's forged-`runId` probe is sent by the harness, not the extension.** It
  appears in the traffic table as an unauthenticated `/api/rescore` with a 4xx
  status. That row is expected; it is the assertion, not a failure.
- **The KV store is in-memory.** With no Upstash env vars the server's quota
  store lives in the dev server's process, so each invocation starts from a
  clean slate because the harness restarts the server. Do not run two
  invocations against one server and expect `5 runs left today`.
- **`runLog` is not used.** It is documented as lossy and has misled previous
  rounds of this investigation. Run outcomes are read from `cp_results` /
  `cp_live_runs` in `chrome.storage`, which is the actual panel/worker
  contract.
- **Sign-out navigates the panel away.** `lib/clerk.ts` calls Clerk's
  `signOut({ redirectUrl })`, so the panel tab lands on the extension's
  sign-in page. The harness reopens the panel afterwards, which is what a user
  would do. Worth knowing before reading A4's evidence.
- **One posting, one resume.** The fixtures are deliberately small (each under
  2 KB) to keep token spend down. They are not a test of extraction quality.
- **Headless first, headed fallback.** New headless Chromium loads MV3
  extensions here; if it ever stops doing so, the harness detects the missing
  service worker and relaunches headed. The report's `config.headless` says
  which was used.

---

## Audit notes (2026-09-03, independent evaluator pass)

An independent audit re-ran the no-mutation eval and confirmed all three
verdicts. Two nuances it flagged, recorded here for the next reader:

- **Stale-build A3 shows a device number, not "stuck at 5".** Under the
  `d19021d` build the panel rendered `2 runs left today` — the DEVICE bucket
  (limit 3, one charge) mislabeled with daily wording, because that build's
  quota poll itself went out under a device token. The user-visible story
  varies by stale-build vintage; the invariant evidence is that the
  `quota:user:*` bucket is never touched and no `/api/run-token` request ever
  appears on the wire.
- **`computeVerdict` treats UNMEASURED as FAIL, not as the spec's graceful
  A2 degradation.** Safe direction (never a false PASS), and it has never
  fired because the reverse proxy always measures A2 — but if A2 ever reads
  UNMEASURED, read the report by hand instead of trusting the overall FAIL.
- **`realm` labels in proxy records are per-path constants, not measured.**
  Accurate by construction (only the worker calls parse-jd/analyze/tailor),
  but the empirical identity evidence is the decoded JWT claim, never the
  realm label.
