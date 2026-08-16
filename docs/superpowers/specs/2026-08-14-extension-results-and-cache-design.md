# Extension Results Layout & Per-JD Cache — Design

- **Date:** 2026-08-14
- **Status:** Approved, ready for implementation planning
- **Scope:** Reorder the side panel's results around a one-click PDF download, and keep each posting's generated result so switching tabs no longer destroys it.

---

## 1. Context

Both changes come from the first real session with the extension.

**The result is ordered wrong for how it is used.** Today the panel renders the match score, then the requirement matrix and gaps, then the change log, and its only export is a **Copy tailored resume** button that copies raw JSON. The actual job is: decide whether this posting is worth applying to, get the tailored resume, apply. The deep analysis is what you read when you want to know *why* — it should not sit between the decision and the artifact.

**Switching tabs destroys the result.** `App.tsx` resets run state on every `jd?.url` change, so browsing to another posting discards a run the user just paid for, and coming back does not restore it. Closing the side panel loses it too, since panel state is entirely in memory.

A related proposal was considered and rejected: reading the page only on an explicit click, to "make it cheaper". **Extraction is free** — inject script, read DOM, return text, with no network call and no LLM call. The only paid step is the generate, which is already user-initiated. Disabling the automatic read would save nothing and would leave the header showing the previous company. The result loss is caused by the reset-on-JD-change, not by reading; caching results per posting is what fixes it, and it makes the automatic read purely beneficial.

---

## 2. Part 1 — Results layout and PDF download

### Order

```
Match 62 → 85                    score; appears when analyze returns
[ Download PDF resume ]          appears when tailor returns
generated 2 minutes ago

── details ──
What changed (change log)
Requirements (met / partial / missing, with evidence)
Honest gaps
```

The score answers "is this worth applying to". The download is the artifact. Everything else answers "why", and moves below both.

### The download cannot appear before the tailor call returns

It downloads the *rewritten* resume, which is what the slower of the two parallel calls produces. So the real sequence is: score appears, a pause, then the button. This matches the requested order but does **not** make anything faster — latency is §5's subject, deliberately separate.

### PDF generation

`src/lib/resume-pdf.tsx` already produces a `Blob` entirely client-side via `@react-pdf/renderer`, exporting `generateResumePdf(resume): Promise<Blob>` and `resumePdfFilename(...)`. Its only runtime dependency is that library; its one internal import is type-only. So the extension needs **no new endpoint and no extra network round trip**.

**Move the module to `shared/resume-pdf.tsx`** and have both the web app and the extension import it there. Copying it into the extension would create a second source of truth for how a resume looks on paper, and the two would drift.

This shares the layout source, not the rendered bytes: `@react-pdf/renderer` depends on `@react-pdf/layout` — the line-breaking and metrics engine — through a caret range, so the two packages can legitimately resolve different engine minors. Guaranteeing identical output would need the whole `@react-pdf/*` subtree pinned with `overrides` in both packages. That is deliberately not done here; one editable layout is the benefit being bought.

Consequences to handle:
- The web app's dynamic `import("@/lib/resume-pdf")` in `ResultsView.tsx` re-points at the shared path.
- The extension's tsconfig currently includes `../shared/contract.ts` specifically, not the directory; it gains the new file.
- `@react-pdf/renderer` becomes an extension dependency. It is large, so the extension must import it **dynamically**, the way the web app already does — it should load when the user clicks download, not when the panel opens.
- `shared/contract.ts` stays runtime-free. That rule is about that file, not the directory.

### Copy as JSON

The existing **Copy tailored resume** button, which copies raw JSON, stays but is relabelled **Copy as JSON** and moves into the details section. It is a developer affordance, not the primary export, and the current label promises something the PDF now actually delivers.

---

## 3. Part 2 — Per-JD result cache

### Behaviour

- Generated results are written to `chrome.storage.local`, keyed by the posting.
- Returning to a posting with a cached result **shows it immediately**, with `generated <relative time>` under the score, and the primary button reading **Tailor again** rather than **Tailor my resume** — so a cached result is never mistaken for a fresh one.
- **Tailor again** overwrites silently. The user asked for it by name.
- The most recent **20** results are kept; beyond that the oldest is evicted.

### Cache key

The **URL with tracking parameters stripped** (`utm_*`, `ref`, `source`, `trk`, and the fragment). Without normalization the same posting reached from a search result and from a shared link would occupy two entries and appear uncached on the second visit.

Content hashing was considered and rejected: job pages carry timestamps and rotating "similar jobs" rails, so the same posting hashes differently between loads and would almost never hit.

### What is cached

The `analysis`, the `tailored` result, and the timestamp — the same data the panel already holds in memory. Not the extracted JD text, which is re-derived locally for free on every read.

---

## 4. Privacy

This changes what the product stores on the user's machine, so the promise has to change with it.

Today `/privacy` says a tailored result is persisted only when a signed-in user explicitly saves it. That remains true of **our servers**. It is no longer true of the user's own browser: generated results will now sit in `chrome.storage.local` alongside the base resume.

Required:
- `/privacy` gains a line stating that generated results are cached in the browser, are never uploaded, and can be cleared.
- The panel gains a **Clear cached results** control near the resume card.

"Nothing stored unless you save" is the one claim this product can make that its competitors cannot. Adding a cache without updating the wording would make it half-true, which is worse than not making it.

---

## 5. Out of scope — generation latency

A run takes roughly a minute. That is real and worth fixing, but **not by guessing.**

`callLLM` already records per-call duration and token counts, rolled up at `stats:<task>:<model>` — instrumentation added in the server foundation for exactly this question, and the user's live runs have already populated it. The next step is to read that data and see how the minute divides between `parse_jd`, `analyze`, and `tailor`, then decide:

- `tailor` dominating → a faster model or a lower `maxTokens` (currently 8000)
- `parse_jd` unexpectedly slow → it is already on Haiku, so the input is too long and should be truncated
- all three slow → a model comparison across a fixed set of (resume, JD) pairs

Swapping models before measuring risks spending the effort for a few seconds while losing rewrite quality. This is a measurement task, not an implementation one, and it gets its own cycle.

## 6. Also out of scope

Editing the tailored resume in the panel · DOCX or Markdown export · syncing the cache across devices · SPA navigation detection (still deferred) · sign-in.

## 7. Success criteria

1. When tailoring finishes, one click downloads a PDF of the tailored resume, with no additional network request.
2. The score is visible above the download; the change log, requirements and gaps are below it.
3. Switching to another tab and back restores the earlier posting's result, with a relative timestamp and a **Tailor again** button.
4. Closing and reopening the side panel restores it too.
5. The same posting reached via a link carrying `utm_*` parameters hits the same cache entry.
6. A 21st result evicts the oldest.
7. `/privacy` states that results are cached in the browser, and the panel can clear them.
8. The web app's PDF download still works after the module moves.
