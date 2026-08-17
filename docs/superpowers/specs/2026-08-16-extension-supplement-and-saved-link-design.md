# Extension: Supplementary Experience & Saved-Resumes Link — Design

- **Date:** 2026-08-16
- **Status:** Approved, ready for implementation planning
- **Scope:** Let the user answer a gap the analysis found by describing experience their resume does not mention, and regenerate from it without paying a second time. Plus a link out to the web app's saved resumes.

---

## 1. Context

Both changes come from the first real session with the finished panel.

**The analysis names gaps the user can often answer.** It reports "missing: PyTorch" against a resume that never mentioned PyTorch — but the user did use it, on a project they left off. Today the panel gives them nowhere to say so. The only recourse is to edit their resume elsewhere, re-upload, and start over.

**The server already accepts exactly this.** `/api/analyze` and `/api/tailor` both take an `extraInfo` string and fold it into their prompts (`buildAnalyzeMessages`, `buildTailorMessages` in `src/lib/analysis.ts`), and the web app has had a field for it since the beginning — a panel titled *"Anything not on your resume?"* with the subtitle *"Optional — projects, skills, or context you want considered."* The extension hardcodes `extraInfo: ""` in `extension/src/lib/run.ts`. So the feature is mostly wiring on the client, plus one deliberate change to how a run is charged.

**Saved resumes exist only on the web.** `/app/saved` lists what a signed-in user saved. The extension has no sign-in at all, so it cannot show that list — but it can point at it.

### A richer version was considered and deferred

The user's preferred design is a multi-turn conversation: the user says something, the model asks follow-up questions, and after a few turns they finalize the text together, then regenerate. That is feasible but it is a different project: a new endpoint and `LLMTask`, a new class of cheap metered call, conversation persistence in the cache, and — the real cost — prompt work to keep the model from proposing phrasings the user then rubber-stamps, which is precisely where a "we never fabricate" product breaks.

It is deferred, and deferring costs nothing: **the conversation's output is a block of text destined for the same `extraInfo` field this design builds.** The textarea is the foundation either way; the conversation is a later producer for it. Whether to build it should be decided on evidence — if users do not fill a plain textarea, they will not hold a conversation either.

---

## 2. Part 1 — Saved-resumes link

A small muted link at the bottom of the panel: **Your saved resumes ↗**, opening `${API_BASE}/app/saved` in a new tab.

A plain `<a target="_blank" rel="noreferrer">`. No `tabs` permission, no new configuration: `extension/src/lib/config.ts` already resolves `API_BASE` to localhost for a dev build and the deployed origin for a production build, and both are in `host_permissions`.

`/app/saved` is Clerk-gated, so a user who is not signed in lands on the sign-in prompt. That is the honest outcome — the extension has no session to carry over, and pretending otherwise would be worse than the extra click.

---

## 3. Part 2 — Supplementary experience, on the client

### Where it lives

At the **bottom of the details card**, below Honest gaps — not in the main flow. The panel's primary experience stays what it has always been: company and role, one button, results. This is a corrective affordance for someone who has read the analysis and disagrees with part of it.

A textarea plus a button. It appears once results exist, because it is a response to what the analysis said.

### The placeholder is generated from the actual gaps

Rather than a fixed example, the placeholder names the requirements this analysis marked `missing` — derived from `analysis.requirements_matrix`, data the panel already holds:

```
e.g. PyTorch, Kubernetes — tell us what you actually did with them.
```

This makes the feature explain itself and ties it to the specific thing the user is looking at. It costs nothing: no new request, no new state.

### What happens on submit

The same `runTailor` runs again, with `extraInfo` set to the text. The result replaces the posting's cache entry, and the supplement text is stored alongside it, so returning to the posting brings back both the result and what the user wrote.

### Two failure behaviours that must be right

- **A failed run must not clear the textarea.** The user may have just written a paragraph. The text lives in panel state and is only written to the cache on success.
- **Nothing is written to the cache unless the run completed.** Same rule the existing run already follows.

---

## 4. Part 3 — Refinement is free, but bounded

Regenerating from a supplement must not cost a second unit of quota, for signed-in and signed-out callers alike. Refining the current posting is free; starting a new posting costs.

### Why this is not simply "don't charge"

`consumeRun` (`src/lib/quota.ts`) charges once per `runId`, and both legs — analyze and tailor — share that id. A marker `run:<caller>:<runId>` is incremented atomically, and legs 2..`RUN_LEGS` ride free on leg 1's charge. Anything past `RUN_LEGS` charges again, and that bound is deliberate: extension code ships publicly and is trivially unpackable, so an unbounded free-ride window would let one attacker-chosen id buy uncharged LLM calls. The previous review rated exactly that Critical.

So the free refinement must be **bounded**, not unmetered.

### The change

- `RUN_LEGS = 2` becomes `LEGS_PER_GENERATE = 2` and `FREE_REFINES = 2`, giving `MAX_FREE_LEGS = LEGS_PER_GENERATE * (1 + FREE_REFINES) = 6`. One charged generate buys up to three versions of a posting.
- **`RUN_TTL_SECONDS` goes from 10 minutes to 48 hours.** This is the change without which the feature silently fails: the marker currently expires in ten minutes, while the result cache keeps postings for weeks. A user returning the next day to refine would be charged, with no way to understand why. 48 hours matches the daily counters' TTL; refining beyond that window costs a new unit, which in practice nobody will hit.

### Free of the business quota, not free of the abuse ceiling

The per-IP ceiling of 20 per day exists to bound spend, not to ration a user. If free refinements skipped it too, the real ceiling would silently become 60 LLM pairs per IP per day.

So the rule splits:

- `seen === 1` — charge the caller's tier **and** the IP counter.
- `seen % LEGS_PER_GENERATE === 1` and `seen <= MAX_FREE_LEGS` — charge the **IP counter only**. This is the first leg of a free refinement.
- otherwise `seen <= MAX_FREE_LEGS` — charge nothing. This is the second leg of a pair.
- `seen > MAX_FREE_LEGS` — charge normally. Replay protection, unchanged in spirit.

### The known imprecision, stated rather than discovered

The parity rule assumes legs arrive in pairs. They do not always: if analyze fails while tailor succeeds, only one leg is counted, and every subsequent pair's parity is shifted by one. The consequence is that the IP counter can be charged on the second leg of a refinement instead of the first — an off-by-one in abuse accounting under partial failure.

This is accepted. The security-relevant property is the **bound** `MAX_FREE_LEGS`, which holds regardless of parity. Exact IP accounting under partial failure is not worth the complexity of tracking leg identity server-side.

### The client's part

The `runId` must be stored in the cache entry alongside the result and reused when refining. Without it, closing the panel loses the id and the next refinement is charged as a new run.

---

## 5. Integrity: what is marked, and what is not

Because the supplement feeds analyze as well as tailor, `missing: PyTorch` becomes met and the score rises. That matches intuition, but it means the number is no longer derived solely from a parsed document.

**The panel says so.** A muted line under the score whenever the displayed result was generated with a supplement: *"Includes experience you added that isn't on your resume."*

**The downloaded PDF does not.** That is the user's resume, they are accountable for its contents, and stamping a disclosure onto the document they send to an employer oversteps. What must be honest is the score we show them, not the file they hand over.

---

## 6. Migration

`CachedRun` gains two fields, `extraInfo: string` and `runId: string`. Entries already in users' `chrome.storage.local` — including from the current testing session — have neither. Reads must tolerate that: a missing `extraInfo` reads as `""`, and a missing `runId` means the next generate mints a fresh one and is charged normally. No migration step, no version field; the absent case is simply handled.

---

## 7. Out of scope

Multi-turn conversation (§1) · a global supplement that applies to every posting · sign-in, and any in-panel list of saved resumes · editing the parsed resume directly · generation latency, which still awaits the `stats:<task>:<model>` measurement.

---

## 8. Success criteria

1. A link at the bottom of the panel opens the web app's saved-resumes page in a new tab, at the right origin for the build.
2. After a run, a textarea appears below Honest gaps, its placeholder naming requirements this analysis marked missing.
3. Submitting it regenerates the result, and the new result reflects the supplied experience.
4. That regeneration does **not** decrement the caller's remaining count.
5. A fourth generate on the same posting — one charged plus three refinements — does charge.
6. The IP counter increments once per generate, including free refinements.
7. Returning to the posting restores the result **and** the supplement text.
8. A failed regeneration leaves the typed text in place.
9. The panel marks a supplemented result under the score; the downloaded PDF carries no such mark.
10. A cache entry written before this change loads without error.
