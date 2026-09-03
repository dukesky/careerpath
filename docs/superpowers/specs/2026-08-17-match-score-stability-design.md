# Match Score Stability — Design

- **Date:** 2026-08-17
- **Status:** Approved, ready for implementation planning
- **Scope:** Stop the "before" match score moving between runs of the same posting, and stop showing cached results that were computed from a resume the user has since replaced.

---

## 1. Context

Live testing found this: a first run showed **72 → 72**. The user added supplementary experience and regenerated, and it showed **62 → 72**. Adding information appeared to make their resume *worse*.

Reading the code explains both halves, and neither is what the panel implies:

- `overall_match_score` comes from the **analyze** call (Sonnet, temperature **0.3**).
- `projected_match_score` comes from the **tailor** call (Sonnet, temperature **0.4**), and in the extension's flow tailor receives **no analysis** — `run.ts`'s payload has no `analysis` key, so `tailor/route.ts` sets `analysis = null`. Tailor never sees the number analyze produced.

So the two numbers are independent estimates from two calls that cannot see each other, and both are re-derived from scratch on every run. **72 → 72 does not mean "no improvement"** — it means two calls happened to guess the same number. **72 dropping to 62 is almost certainly sampling noise**, not a consequence of the supplement: a ±10 swing on a subjective 0–100 judgment at temperature 0.3 is ordinary.

**This defect predates the supplement feature; that feature is what made it visible.** Before it, each posting was generated once, so there was never a second measurement to compare against. Adding "regenerate this posting" turned a stable-looking number into an observable random walk.

A second problem surfaced while designing the fix. The result cache is keyed on the posting URL alone, with no reference to the resume. Replacing your resume therefore leaves every cached analysis and rewrite on screen, computed from the **old** resume, with nothing indicating it. That is the same class of harm as the drifting score — the panel implies it is describing your current resume when it is not — and freezing a baseline would add one more stale number to each entry.

---

## 2. What the two numbers mean

The panel keeps the story it tells today — *we rewrote your resume and it now matches better* — so the two displayed numbers remain "the score before" and "the score after the rewrite".

Two alternatives were considered and rejected:

- **Show `frozen baseline → current analyze score`.** Both numbers would come from the same instrument, making the delta trustworthy for the first time. Rejected because it measures only the value of the *supplement*, not of the *rewrite*, and the rewrite is what the product sells.
- **Show one current score and the requirement matrix, with no before/after.** The most honest option, and it gives up the product's central claim. Rejected.

The consequence of keeping the current framing is accepted explicitly: **the two numbers still come from two uncalibrated instruments, so the delta carries real noise.** §5 reduces how much precision the display claims, rather than pretending the noise is gone.

---

## 3. The frozen baseline

`CachedRun` gains:

```ts
baselineScore: number;
```

Captured on the first successful run for a posting and never recomputed. On a later run, if the posting already has a **valid** cache entry (see §4), that entry's `baselineScore` is carried forward; otherwise this run's `analysis.overall_match_score` becomes the baseline.

So each **(posting, resume)** pair is measured once. "Before" means what the phrase says: the score of your resume as it stood, and it does not move because you told us more about yourself.

An accepted consequence: supplementary experience still feeds the analyze call, so the requirement matrix legitimately updates — a requirement can go from `missing` to `met` while the baseline stays put. That is correct rather than contradictory. The baseline measures what the résumé document conveyed; the matrix measures what the candidate has.

**During the first run** analyze lands before tailor, so there is briefly no stored baseline. The panel shows that run's `overall_match_score` — the value that is about to *become* the baseline — so nothing jumps when the run completes.

---

## 4. The resume fingerprint

`CachedRun` also gains:

```ts
resumeFingerprint: string;
```

computed from the `ParsedResume` the run used: `JSON.stringify` through a small synchronous non-cryptographic hash (FNV-1a or similar). No `crypto.subtle` — it is async, and this needs neither collision resistance nor secrecy. A collision would surface one stale entry, which is exactly today's behaviour, at a probability irrelevant across 20 entries.

**One rule governs reads.** A cache entry counts only if it has a fingerprint, has a baseline, and the fingerprint matches the current resume. Otherwise it is treated as absent: nothing displayed, no `runId` reused, the posting regenerates from scratch.

No fallbacks, no special cases. One comprehensible predicate is worth more here than three rules that each handle a variant — and this rule subsumes migration: entries written before these fields existed have no fingerprint, so they are discarded. That is the right outcome, not a compromise. We cannot confirm which resume produced them, and "do not show what you cannot vouch for" is the rule this whole design exists to establish.

---

## 5. Rounding

Both displayed numbers are rounded to the nearest 5.

An integer on a 0–100 scale claims a precision this instrument does not have. With the baseline frozen the left number stops moving, but the right one is still recomputed on every regeneration at temperature 0.4 — and it *should* move, since each run produces a genuinely new rewrite. There is no way to separate that real movement from sampling noise without chaining the two calls, which §7 rules out.

Rounding is the cheapest honest response: it stops a meaningless three-point wobble from reading as a real change. The cost is accepted — a small genuine improvement can round up to look like ten points.

---

## 6. Temperature

`DEFAULT_TEMPERATURE.analyze` goes from `0.3` to `0`. Analyze is a judgment task; reproducibility is the property worth having, and 0.3 is where the ±10 baseline swing came from.

`tailor` stays at `0.4`. Its call produces the rewritten prose *and* the projected score in one response, so the score cannot be cooled without flattening the writing. That trade is not worth making, and with the baseline frozen the projected score is no longer being compared against a moving target.

---

## 7. Out of scope

Chaining tailor after analyze so the projected score is anchored to the baseline — it would fix the two-instruments problem, and it would serialize two calls that currently run in parallel, roughly doubling a generation time that is already the top complaint. · Changing what `extraInfo` feeds. · Any further treatment of noise in the projected score beyond §5. · The per-tier cost of invalidation (see §8).

---

## 8. Known consequences

1. **Replacing the resume invalidates all 20 cached postings**, each costing a run to regenerate. That is the price of §4 and it is accepted, but it falls hardest on the signed-out extension tier — 3 runs per 30 days — which is one more reason extension sign-in is the natural next cycle.
2. **The "Clear N cached results" count still counts every stored entry**, including ones hidden by a fingerprint mismatch. The control is about what occupies storage and it does delete all of them, so the count is correct for what the button does — but N can exceed the number of results the user can currently see.

---

## 9. Success criteria

1. Generating a posting, then regenerating it with supplementary experience, leaves the left-hand number unchanged.
2. ~~Both displayed numbers are multiples of 5.~~ Superseded by the 2026-09-03 addendum below: both displayed numbers are raw integers.
3. A cache entry whose fingerprint does not match the current resume is not displayed, and its `runId` is not reused.
4. A cache entry written before this change (no fingerprint) is not displayed.
5. Replacing the resume and returning to a previously generated posting shows a fresh panel, not the old result.
6. Restoring a posting whose fingerprint matches shows its stored baseline, not a freshly computed one.
7. `analyze` runs at temperature 0.
8. `App.test.tsx` covers criterion 1 — two runs on one posting, asserting the baseline is stable.

---

## Addendum — 2026-09-03: the right-hand number is now a measurement

**Superseded here:** §7's "chaining out of scope", and with it §5's rounding
and success criterion 2. §§3, 4, 6 are unchanged and still govern.

Since 2026-09-03 the panel's right-hand number is the **tailored resume scored
by the analyze call itself** — the same system prompt, the same schema, the
same model, temperature 0 — fetched from a new `POST /api/rescore` after the
run's `done` patch has already painted. `projected_match_score` remains the
fallback and is shown until the rescore lands, and forever if it fails.

**Why this was not visible in 2026-08-17.** §7 rejected chaining, and it was
right to: putting analyze in front of tailor serializes two calls and doubles
the wall clock to first result. But it framed the choice as "one instrument or
current latency", and there is a third option the discussion never reached — a
**third call, after first paint**. The user reads a complete result at the same
moment they do today; twenty to thirty seconds later one number on that screen
becomes more accurate. The cost is real (about +40% in LLM spend, roughly
$0.04 a generate) and it buys the delta the product has always claimed to be
selling.

**What this changes about §5.** Rounding to the nearest five existed because
the two numbers came from two uncalibrated instruments, where a three-point
difference means nothing. That premise is gone: both numbers now come from the
same instrument at temperature 0. What rounding does now is destroy real
signal — an honest 87 → 88 renders as 85 → 90, wrong in both halves — so
`roundToFive` is deleted and both numbers render as raw integers. **If the
right-hand number ever reverts to another model's self-assessment, the
rounding has to come back with it.**

**What it does not change.** The baseline is still frozen per (posting,
resume) exactly as §3 describes — the left number is a historical fact about
the document the user arrived with, and a rescore of the rewrite is not a
reason to re-measure it. §4's one-rule provenance check is untouched:
`rescoredScore` is an OPTIONAL cache field, and an entry lacking it (written
before this change, or from a run whose rescore failed) is still perfectly
valid and displayed with the projection.

**Honesty.** A rescore below the baseline is displayed as it is. No `max()`,
no floor. A number invented to look like progress is worse than one that shows
none, and this is the same rule as the product's no-fabrication constraint on
the resume itself.

**Not paid for by the user.** The rescore consumes no quota — a generate is
still one unit. It is gated instead: the run marker `consumeRun` already
writes must exist for that caller and runId (read-only — the marker's parity
is load-bearing for quota.ts's leg accounting), plus a per-run rescore ceiling,
the standard per-IP rate limit, and the same beta bypass the other routes have.

**Revised success criteria** (criterion 2 in §9 is superseded as marked there;
9 and 10 are new):

9. After a generate, exactly one `POST /api/rescore` is made, under the same
   identity as analyze/tailor and with the same `runId`, and the allowance
   still moves by one.
10. The right-hand number equals the rescore's score once it lands, and the
    tailor model's projection before that and if it fails. Evaluator assertion
    **A7** measures 9 and 10 end to end in a real browser.
