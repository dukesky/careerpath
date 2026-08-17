# Match Score Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze the "before" match score per posting, discard cached results computed from a resume the user has replaced, and stop claiming more precision than the scores have.

**Architecture:** `CachedRun` gains `baselineScore` and `resumeFingerprint`. `getCachedRun` takes the current resume's fingerprint and returns an entry only when it can confirm the entry's provenance and that provenance matches — one rule, no fallbacks, which also discards pre-existing entries. `App.tsx` carries the restored baseline forward instead of recomputing it, and `Results.tsx` rounds both displayed scores to the nearest 5. `analyze` drops to temperature 0.

**Tech Stack:** TypeScript, React 19, Vite 7 + `@crxjs/vite-plugin`, Vitest 3 (jsdom), Chrome MV3 `chrome.storage.local`, Next.js 15 (the one server-side line).

**Source spec:** `docs/superpowers/specs/2026-08-17-match-score-stability-design.md`

## Global Constraints

- **Work in this worktree only:** `/Users/tianzhang/Projects/careerpath/.claude/worktrees/ext-access`, branch `feat/extension-page-access`. Do not `cd` to the main checkout. Never use bare `git stash` / `git stash pop` — the stash stack is shared with other worktrees.
- **One rule governs cache reads.** An entry counts only if it has a `resumeFingerprint`, has a numeric `baselineScore`, and the fingerprint equals the current resume's. Otherwise it is treated as absent — nothing displayed, no `runId` reused. **No fallbacks and no special cases**; migration is a consequence of this rule, not an exception to it.
- **The baseline is measured once per (posting, resume) pair** and carried forward unchanged on every later run.
- **Both displayed scores are rounded to the nearest 5.**
- **`analyze` temperature becomes `0`. `tailor` stays at `0.4`** — its call produces the rewritten prose and the projected score together, so cooling it would flatten the writing.
- **Nothing may be uploaded.** The fingerprint is computed and stored on-device.
- **`/privacy` needs no change.** The fingerprint is derived from the resume already stored locally and introduces no new category of stored data. Do not add a clause for it.
- **`App.tsx`'s concurrency machinery is load-bearing** — `activeJdUrlRef`, `runningForUrlRef`, `runningSupplementRef`, `busy`, and the `latest` accumulator each exist because of a specific shipped bug. Thread new state through them; do not restructure them.
- **Baseline to preserve:** root 80/80, extension 92/92, `npx tsc --noEmit --project extension/tsconfig.json`, `npm run lint`, `npm --prefix extension run lint`, `npm run build`, `npm --prefix extension run build` all clean.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `extension/src/sidepanel/score.ts` | `roundToFive` — a display concern, kept out of the cache layer. |
| `extension/src/sidepanel/__tests__/score.test.ts` | Its tests. |
| `extension/src/lib/fingerprint.ts` | `resumeFingerprint` — identifies which resume produced a cached run. |
| `extension/src/lib/__tests__/fingerprint.test.ts` | Its tests. |

**Modified:**

| File | Change |
|---|---|
| `extension/src/lib/cache.ts` | `CachedRun` gains two fields; `getCachedRun` takes a fingerprint and enforces the one rule. |
| `extension/src/lib/__tests__/cache.test.ts` | Fixtures gain the fields; three new cases. |
| `extension/src/sidepanel/App.tsx` | Memoized fingerprint, baseline state, both threaded through restore and generate. |
| `extension/src/sidepanel/Results.tsx` | Takes `baselineScore`; rounds both numbers. |
| `extension/src/sidepanel/__tests__/App.test.tsx` | One case: the baseline does not move across a regeneration. |
| `src/lib/llm.ts` | `analyze` temperature `0.3` → `0`. |
| `CHANGELOG.md` | New dated section. |

---

## Task 1: The two pure helpers

**Why first:** both are pure, both are fully testable, and Tasks 2 and 3 consume them. Nothing imports them at the end of this task — that is expected, not an omission.

**Files:**
- Create: `extension/src/sidepanel/score.ts`, `extension/src/lib/fingerprint.ts`
- Test: `extension/src/sidepanel/__tests__/score.test.ts`, `extension/src/lib/__tests__/fingerprint.test.ts`

**Interfaces:**
- Consumes: `ParsedResume` from `@shared/contract`.
- Produces: `roundToFive(score: number): number` and `resumeFingerprint(resume: ParsedResume): string`.

- [ ] **Step 1: Write the failing score test**

Create `extension/src/sidepanel/__tests__/score.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { roundToFive } from "../score";

describe("roundToFive", () => {
  it("leaves multiples of five alone", () => {
    expect(roundToFive(70)).toBe(70);
    expect(roundToFive(0)).toBe(0);
    expect(roundToFive(100)).toBe(100);
  });

  it("rounds to the nearer multiple", () => {
    expect(roundToFive(72)).toBe(70);
    expect(roundToFive(73)).toBe(75);
    expect(roundToFive(78)).toBe(80);
  });

  it("rounds a midpoint up", () => {
    expect(roundToFive(72.5)).toBe(75);
  });

  it("does not push a score past 100", () => {
    expect(roundToFive(99)).toBe(100);
    expect(roundToFive(100)).toBe(100);
  });

  // The whole point of rounding is to stop a meaningless wobble reading as a
  // real change. Two scores inside the same bucket must render identically.
  it("collapses a wobble inside one bucket", () => {
    expect(roundToFive(71)).toBe(roundToFive(73));
  });
});
```

- [ ] **Step 2: Write the failing fingerprint test**

Create `extension/src/lib/__tests__/fingerprint.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resumeFingerprint } from "@/lib/fingerprint";
import type { ParsedResume } from "@shared/contract";

function resume(overrides: Partial<ParsedResume> = {}): ParsedResume {
  return {
    contact: { name: "Ada Lovelace", email: "", phone: "", location: "", links: [] },
    summary: "Engineer",
    experience: [{ company: "Acme", title: "SWE", dates: "2020", bullets: ["Shipped X"] }],
    projects: [],
    skills: ["Python"],
    education: [],
    ...overrides,
  };
}

describe("resumeFingerprint", () => {
  it("is stable across separate objects with the same content", () => {
    expect(resumeFingerprint(resume())).toBe(resumeFingerprint(resume()));
  });

  it("changes when a skill is added", () => {
    expect(resumeFingerprint(resume({ skills: ["Python", "Rust"] }))).not.toBe(
      resumeFingerprint(resume()),
    );
  });

  // The case that motivates the whole feature: the user replaces their resume,
  // and every cached result computed from the old one must stop counting.
  it("changes when a bullet is edited", () => {
    const edited = resume({
      experience: [
        { company: "Acme", title: "SWE", dates: "2020", bullets: ["Shipped Y"] },
      ],
    });
    expect(resumeFingerprint(edited)).not.toBe(resumeFingerprint(resume()));
  });

  it("returns a short hex string", () => {
    expect(resumeFingerprint(resume())).toMatch(/^[0-9a-f]{8}$/);
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

```bash
npm --prefix extension run test -- score fingerprint
```

Expected: FAIL — `Failed to resolve import "../score"` and `"@/lib/fingerprint"`. Record the actual output.

- [ ] **Step 4: Implement `score.ts`**

Create `extension/src/sidepanel/score.ts`:

```ts
/**
 * Match scores are rendered in multiples of five.
 *
 * An integer on a 0-100 scale claims a precision this instrument does not
 * have: the two numbers the panel shows come from two different model calls,
 * and the right-hand one is resampled on every regeneration. Rounding is the
 * cheapest honest response — it stops a meaningless three-point wobble from
 * reading as a real change. The cost is accepted in the other direction: a
 * small genuine improvement can round up to look like ten points.
 */
export function roundToFive(score: number): number {
  return Math.round(score / 5) * 5;
}
```

- [ ] **Step 5: Implement `fingerprint.ts`**

Create `extension/src/lib/fingerprint.ts`:

```ts
import type { ParsedResume } from "@shared/contract";

/**
 * Identifies which resume produced a cached run.
 *
 * The result cache is keyed on the posting alone, so without this a user who
 * replaces their resume keeps seeing analyses and rewrites computed from the
 * old one, with nothing on screen saying so. Every cache entry carries this,
 * and an entry whose fingerprint does not match the resume loaded now is
 * treated as absent.
 *
 * FNV-1a over the serialized resume: synchronous, dependency-free, and
 * adequate here. This needs neither collision resistance nor secrecy — a
 * collision would surface one stale entry, which is exactly today's behaviour,
 * at a probability irrelevant across the 20 entries the cache holds. Do not
 * "upgrade" it to crypto.subtle: that is async, and it would make every cache
 * read await a digest for no benefit.
 */
export function resumeFingerprint(resume: ParsedResume): string {
  const json = JSON.stringify(resume);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
```

- [ ] **Step 6: Run both tests to verify they pass**

```bash
npm --prefix extension run test -- score fingerprint
```

Expected: PASS — 5 score tests and 4 fingerprint tests.

- [ ] **Step 7: Type-check, test, lint and build**

```bash
npx tsc --noEmit --project extension/tsconfig.json && npm --prefix extension run test && npm --prefix extension run lint && npm --prefix extension run build
```

Expected: type-check clean, 101 tests (92 + 9), lint clean, build green. Report the actual total if it differs.

- [ ] **Step 8: Commit**

```bash
git add extension/src/sidepanel/score.ts extension/src/lib/fingerprint.ts extension/src/sidepanel/__tests__/score.test.ts extension/src/lib/__tests__/fingerprint.test.ts
git commit -m "feat(extension): score rounding and resume fingerprint helpers"
```

---

## Task 2: The cache enforces provenance

**Files:**
- Modify: `extension/src/lib/cache.ts`
- Test: `extension/src/lib/__tests__/cache.test.ts`

**Interfaces:**
- Consumes: `resumeFingerprint` is **not** imported here — the cache does not know the current resume. Callers pass a fingerprint in.
- Produces:
  ```ts
  export interface CachedRun {
    analysis: GapAnalysis;
    tailored: TailorResult;
    generatedAt: string;
    extraInfo: string;
    runId: string;
    baselineScore: number;
    resumeFingerprint: string;
  }
  export function getCachedRun(url: string, fingerprint: string): Promise<CachedRun | null>;
  ```
  `putCachedRun`, `clearCachedRuns`, `countCachedRuns`, `cacheKey`, `MAX_CACHED_RUNS` keep their current signatures. **`getCachedRun` gains a second required parameter** — Task 3 must pass it.

- [ ] **Step 1: Update the test fixture and add the new cases**

In `extension/src/lib/__tests__/cache.test.ts`, replace the `run` helper with one that fills the new fields:

```ts
const FP = "aaaaaaaa";

function run(
  score: number,
  extraInfo = "",
  runId = "rid",
  fingerprint = FP,
): CachedRun {
  const analysis: GapAnalysis = {
    overall_match_score: score,
    rationale: "",
    requirements_matrix: [],
    strengths: [],
    gaps: [],
  };
  const tailored: TailorResult = {
    resume: RESUME,
    change_log: [],
    projected_match_score: score + 10,
  };
  return {
    analysis,
    tailored,
    generatedAt: "2026-08-14T10:00:00.000Z",
    extraInfo,
    runId,
    baselineScore: score,
    resumeFingerprint: fingerprint,
  };
}
```

Every existing `getCachedRun(url)` call in this file becomes `getCachedRun(url, FP)`. Do not change any assertion — only the argument.

Then replace the existing legacy-entry test (the one named `"reads an entry written before these fields existed"`) with these three. The old one asserted that a fieldless entry still loads; under the new rule it must not, so keeping it would encode behaviour this task deliberately removes.

```ts
  it("round-trips the baseline and the fingerprint", async () => {
    await putCachedRun("https://acme.com/jobs/1", run(62, "", "rid", "beef1234"));
    const hit = await getCachedRun("https://acme.com/jobs/1", "beef1234");
    expect(hit?.baselineScore).toBe(62);
    expect(hit?.resumeFingerprint).toBe("beef1234");
  });

  // The point of the fingerprint: the user replaced their resume, so this
  // entry describes a document that no longer exists. Showing it would tell
  // them we analysed their current resume when we did not.
  it("ignores an entry whose fingerprint does not match the current resume", async () => {
    await putCachedRun("https://acme.com/jobs/1", run(62, "", "rid", "oldresum"));
    expect(await getCachedRun("https://acme.com/jobs/1", "newresum")).toBeNull();
  });

  // Entries written before these fields existed carry no provenance, so we
  // cannot vouch for which resume produced them. Discarding them is the
  // intended outcome of the one rule, not a migration gap.
  it("ignores an entry written before the fingerprint existed", async () => {
    await chrome.storage.local.set({
      cp_results: JSON.stringify([
        {
          key: "https://acme.com/jobs/legacy",
          analysis: run(50).analysis,
          tailored: run(50).tailored,
          generatedAt: "2026-08-13T09:00:00.000Z",
          extraInfo: "",
          runId: "old-run",
        },
      ]),
    });

    expect(await getCachedRun("https://acme.com/jobs/legacy", FP)).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm --prefix extension run test -- cache
```

Expected: FAIL — the fixture's object is not assignable to `CachedRun` (`baselineScore` and `resumeFingerprint` do not exist on the type), and `getCachedRun` takes one argument. Record the actual output.

- [ ] **Step 3: Extend the stored shape**

In `extension/src/lib/cache.ts`, add the two fields to `CachedRun`, after `runId`:

```ts
  /**
   * The analyze score from the FIRST run for this (posting, resume) pair,
   * carried forward unchanged by every later run. "Before" means what the
   * word says — it does not move because the user told us more about
   * themselves. Recomputing it per run is what made the panel show a score
   * DROPPING after the user added experience.
   */
  baselineScore: number;
  /**
   * Which resume produced this run — see lib/fingerprint.ts. An entry whose
   * fingerprint does not match the resume loaded now is treated as absent.
   */
  resumeFingerprint: string;
```

and widen `StoredEntry` to make all four newer fields optional on the read path:

```ts
/**
 * What a stored entry may ACTUALLY look like. Entries predating each of these
 * fields are already in real users' browsers, so every read must treat them as
 * optional even though the type above does not.
 */
type StoredEntry = Omit<
  CacheEntry,
  "extraInfo" | "runId" | "baselineScore" | "resumeFingerprint"
> &
  Partial<
    Pick<CacheEntry, "extraInfo" | "runId" | "baselineScore" | "resumeFingerprint">
  >;
```

- [ ] **Step 4: Enforce the one rule in `getCachedRun`**

Replace `getCachedRun` entirely:

```ts
/**
 * A cached run for this posting, or null.
 *
 * ONE rule decides: an entry counts only if it carries provenance we can
 * check — a fingerprint and a numeric baseline — and that provenance matches
 * the resume loaded now. Everything else is treated as absent: nothing
 * displayed, no runId reused, the posting regenerates from scratch.
 *
 * No fallbacks, no special cases. One comprehensible predicate is worth more
 * than three rules that each handle a variant, and this one subsumes
 * migration: entries written before these fields existed have no fingerprint,
 * so they are discarded here. That is the intended outcome. We cannot confirm
 * which resume produced them, and not showing what we cannot vouch for is the
 * rule this whole design exists to establish.
 */
export async function getCachedRun(
  url: string,
  fingerprint: string,
): Promise<CachedRun | null> {
  const key = cacheKey(url);
  const hit = (await readAll()).find((e) => e.key === key);
  if (!hit) return null;
  if (!hit.resumeFingerprint || typeof hit.baselineScore !== "number") return null;
  if (hit.resumeFingerprint !== fingerprint) return null;
  return {
    analysis: hit.analysis,
    tailored: hit.tailored,
    generatedAt: hit.generatedAt,
    extraInfo: hit.extraInfo ?? "",
    runId: hit.runId ?? "",
    baselineScore: hit.baselineScore,
    resumeFingerprint: hit.resumeFingerprint,
  };
}
```

`putCachedRun` needs no change — it spreads a whole `CachedRun`, so it always writes both new fields.

- [ ] **Step 5: Run the cache tests to verify they pass**

```bash
npm --prefix extension run test -- cache
```

Expected: PASS, 16 tests in that file (13 kept + 3 new; the removed legacy test is replaced by the three above).

- [ ] **Step 6: Type-check and see App.tsx fail**

```bash
npx tsc --noEmit --project extension/tsconfig.json
```

Expected: FAIL in `extension/src/sidepanel/App.tsx` — `getCachedRun` now expects two arguments. **That failure is the point**: it proves Task 3 cannot forget to pass the fingerprint. Record it, then apply the minimal stopgap so the tree builds — pass `""` at the one call site with a `// Task 3 passes the real fingerprint` comment. `""` never matches a real fingerprint, so the cache reads as empty until Task 3 wires it, which is the safe direction to be wrong in.

- [ ] **Step 7: Type-check, test, lint and build**

```bash
npx tsc --noEmit --project extension/tsconfig.json && npm --prefix extension run test && npm --prefix extension run lint && npm --prefix extension run build
```

Expected: type-check clean, 104 tests, lint clean, build green. `App.test.tsx` may now fail because its fixtures lack the new fields — if so, add `baselineScore` and `resumeFingerprint` to those fixtures **only** as far as needed to compile and pass; the behavioural case belongs to Task 3.

- [ ] **Step 8: Commit**

```bash
git add extension/src/lib/cache.ts extension/src/lib/__tests__/cache.test.ts extension/src/sidepanel/App.tsx extension/src/sidepanel/__tests__/App.test.tsx
git commit -m "feat(extension): cache entries carry their baseline and resume fingerprint"
```

---

## Task 3: The panel carries the baseline forward

**Files:**
- Modify: `extension/src/sidepanel/App.tsx`, `extension/src/sidepanel/Results.tsx`
- Test: `extension/src/sidepanel/__tests__/App.test.tsx`

**Interfaces:**
- Consumes: `roundToFive` from `./score`; `resumeFingerprint` from `@/lib/fingerprint`; `getCachedRun(url, fingerprint)` and the `CachedRun` shape from `@/lib/cache`.
- Produces: `Results` gains one required prop, `baselineScore: number | null`.

**Coverage note for the task report:** `Results.tsx` has no direct unit test. `App.tsx` is covered by `App.test.tsx`, which this task extends. Say plainly which behaviour is covered by a test and which is not.

- [ ] **Step 1: Write the failing App test**

Add to `extension/src/sidepanel/__tests__/App.test.tsx`, following the file's existing patterns for faking `chrome.storage`, mocking `./useActiveJd`, and stubbing `@/lib/run`:

```tsx
  // The bug this whole plan exists for: the user generated once, added
  // experience, regenerated — and the LEFT number moved, reading as "adding
  // information made my resume worse". It was resampling, not a real change.
  it("keeps the baseline fixed when the same posting is regenerated", async () => {
    // First run: analyze says 72. That becomes this posting's baseline.
    // Second run: analyze says 62 — the same drift the user hit. The panel
    // must still show 70 on the left (72 rounded), not 60.
  });
```

Replace that comment body with a real test using the file's established harness: render `App`, drive one completed run whose `analysis.overall_match_score` is 72, assert the score card's left number, then drive a second run on the **same** posting whose `analysis.overall_match_score` is 62, and assert the left number is unchanged. Assert on the rendered DOM, not on the mock.

The assertion must be on the **rounded** value the panel actually renders (72 → `70`), because Step 4 makes the display round. Write the test against what the user sees.

- [ ] **Step 2: Run it to verify it fails**

```bash
npm --prefix extension run test -- App
```

Expected: FAIL — the second run's baseline is recomputed, so the left number changes. Record the actual output, including both values.

- [ ] **Step 3: Add the fingerprint and baseline state to `App.tsx`**

Add the imports:

```tsx
import { resumeFingerprint } from "@/lib/fingerprint";
```

Add, near the other state declarations:

```tsx
  // Recomputed only when the stored resume object changes, because it walks
  // the whole resume. It is also the effect dependency below, which is what
  // makes replacing a resume wipe the displayed result.
  const fingerprint = useMemo(
    () => (stored ? resumeFingerprint(stored.resume) : ""),
    [stored],
  );
  // This posting's frozen baseline, restored from cache or set by the first
  // run. Null means "not measured yet", and the display falls back to the
  // current analyze score — which is the value about to become the baseline,
  // so nothing jumps when the run completes.
  const [baselineForPosting, setBaselineForPosting] = useState<number | null>(null);
```

Add `useMemo` to the `react` import if it is not already there.

- [ ] **Step 4: Thread it through the restore effect**

In the JD-change effect, add the baseline to the reset block, next to `setRunIdForPosting("")`:

```tsx
    setBaselineForPosting(null);
```

Change the guard that precedes the cache read so a missing fingerprint stops the restore — there is nothing to validate against until the resume has loaded:

```tsx
    if (!url || !fingerprint) return;
    void getCachedRun(url, fingerprint).then((hit) => {
```

and inside the `.then`, next to `setRunIdForPosting(hit.runId)`:

```tsx
      setBaselineForPosting(hit.baselineScore);
```

Then add `fingerprint` to the effect's dependency array:

```tsx
  }, [jd?.url, fingerprint]);
```

That dependency is not incidental — it is the mechanism for success criterion 5. When the user replaces their resume the fingerprint changes, the effect re-runs, the display is wiped, and the now-invalid entry fails the rule and is not restored. Add a comment saying so, directly above the dependency array.

- [ ] **Step 5: Carry the baseline forward in `generate()`**

Inside the `latest.phase === "done"` block, before `putCachedRun`:

```tsx
        // Carry the existing baseline forward; only a posting with no valid
        // cached entry gets a fresh measurement. This is the whole fix — the
        // alternative, recomputing it per run, is what made the left number
        // fall from 72 to 62 after the user added experience.
        const baseline = baselineForPosting ?? latest.analysis.overall_match_score;
```

Add both new fields to the `putCachedRun` call:

```tsx
          baselineScore: baseline,
          resumeFingerprint: fingerprint,
```

and set the state inside the existing `activeJdUrlRef.current === forUrl` guard, next to `setRunIdForPosting(runId)`:

```tsx
          setBaselineForPosting(baseline);
```

Finally, remove the `""` stopgap Task 2 left at the `getCachedRun` call site if it is still present anywhere.

- [ ] **Step 6: Round both numbers in `Results.tsx`**

Add the import:

```tsx
import { roundToFive } from "./score";
```

Add the prop to the component's signature, after `generatedAt`:

```tsx
  /** This posting's frozen baseline, or null before it has been measured. */
  baselineScore: number | null;
```

Replace the score line:

```tsx
          <div className="score">
            {roundToFive(baselineScore ?? analysis.overall_match_score)}
            {tailored && (
              <span className="after"> → {roundToFive(tailored.projected_match_score)}</span>
            )}
            <span className="muted tiny"> match</span>
          </div>
```

The fallback matters during the first run: analyze lands before tailor, so there is briefly no stored baseline, and the value shown is the one that is about to become it.

- [ ] **Step 7: Pass the prop from `App.tsx`**

In the `<Results ... />` call, add:

```tsx
        baselineScore={baselineForPosting}
```

- [ ] **Step 8: Run the App test to verify it passes**

```bash
npm --prefix extension run test -- App
```

Expected: PASS.

- [ ] **Step 9: Type-check, test, lint and build**

```bash
npx tsc --noEmit --project extension/tsconfig.json && npm --prefix extension run test && npm --prefix extension run lint && npm --prefix extension run build
```

Expected: type-check clean, 105 tests, lint clean, build green.

- [ ] **Step 10: Commit**

```bash
git add extension/src/sidepanel/App.tsx extension/src/sidepanel/Results.tsx extension/src/sidepanel/__tests__/App.test.tsx
git commit -m "feat(extension): freeze the baseline score per posting and resume"
```

---

## Task 4: Cool the analyze call, and record the change

**Files:**
- Modify: `src/lib/llm.ts`, `CHANGELOG.md`

**Interfaces:** none — a constant and prose.

- [ ] **Step 1: Set the analyze temperature to zero**

In `src/lib/llm.ts`, the `DEFAULT_TEMPERATURE` map currently reads:

```ts
// Sensible default sampling temperature per task.
const DEFAULT_TEMPERATURE: Record<LLMTask, number> = {
  parse: 0.1,
  parse_jd: 0.1,
  analyze: 0.3,
  tailor: 0.4,
  ocr: 0,
};
```

Replace it with:

```ts
// Sensible default sampling temperature per task.
//
// `analyze` is 0 deliberately. It is a judgment task whose output includes a
// 0-100 match score the panel shows as a "before" number, and at 0.3 the same
// resume against the same posting scored 72 on one run and 62 on the next —
// which read to the user as "adding information made my resume worse".
// Reproducibility is the property worth having here; raise this and that
// drift comes back.
//
// `tailor` stays at 0.4 even though it also emits a score, because the same
// call writes the rewritten prose. Cooling it to stabilise one number would
// flatten the writing, which is the thing the product is actually for.
const DEFAULT_TEMPERATURE: Record<LLMTask, number> = {
  parse: 0.1,
  parse_jd: 0.1,
  analyze: 0,
  tailor: 0.4,
  ocr: 0,
};
```

No test accompanies this. `DEFAULT_TEMPERATURE` is module-private, and exporting it so a test can assert a literal against itself would buy less than the comment above does — the comment is what a future editor reads before changing the value. Say this explicitly in your report rather than leaving the absence unexplained.

- [ ] **Step 2: Run the root suite, lint and build**

```bash
npm test && npm run lint && npm run build
```

Expected: 80/80, lint clean, build green. No test asserts this constant, so the count does not change.

- [ ] **Step 3: Add the changelog entry**

In `CHANGELOG.md`, insert directly after the `---` that follows the file header, above the existing `## 2026-08-16` section:

```markdown
## 2026-08-17 — The match score stops moving

### Fixed

- **The "before" score is measured once per posting and never recomputed.**
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

- Both scores render in multiples of five. An integer on a 0-100 scale claimed
  a precision these numbers do not have: they come from two different model
  calls that never see each other, and the right-hand one is genuinely
  recomputed on every regeneration. Rounding stops a meaningless three-point
  wobble reading as a real change.

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
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/llm.ts CHANGELOG.md
git commit -m "fix(llm): run analyze at temperature 0; document the score changes"
```

---

## Live browser verification

Not a task — no subagent can do this.

```bash
npm run dev
```

```bash
npm --prefix extension run build:dev
```

Load `.claude/worktrees/ext-access/extension/dist` at `chrome://extensions` → **Load unpacked** (`Cmd+Shift+G` to paste the path). **Remove any previously-loaded copy first.**

1. Generate on a posting. Both numbers are multiples of five.
2. Add experience and regenerate. **The left number is identical.** This is the bug being fixed.
3. Regenerate again with the box emptied. The left number is still identical.
4. Replace your resume with a different file. Return to that posting: the panel is empty, not showing the old result. Generate — a new baseline is measured.
5. Any posting cached before this build shows nothing until regenerated.

---

## Self-Review

**Spec coverage:**

| Spec | Task |
|---|---|
| §2 keep `baseline → projected` framing | 3, Step 6 (the display keeps both numbers) |
| §3 `baselineScore` on the cache entry | 2, Step 3 |
| §3 carried forward, measured once per (posting, resume) | 3, Step 5 |
| §3 first-run fallback so nothing jumps | 3, Step 6 |
| §4 `resumeFingerprint` field | 2, Step 3 |
| §4 FNV-1a over `JSON.stringify`, synchronous | 1, Step 5 |
| §4 one rule, no fallbacks; migration as a consequence | 2, Step 4, with three tests |
| §5 both numbers rounded to five | 1, Step 4 + 3, Step 6 |
| §6 `analyze` → 0, `tailor` unchanged | 4, Step 1 |
| §7 out of scope | nothing implements these; the changelog records why |
| §8.1 resume replacement invalidates 20 entries | changelog, Task 4 Step 3 |
| §8.2 clear-count still counts hidden entries | changelog, Task 4 Step 3 |
| §9.1 baseline unchanged across regeneration | 3, Steps 1–2, tested |
| §9.2 multiples of five | 1, tested |
| §9.3 mismatched fingerprint not displayed, runId not reused | 2, tested (the same `getCachedRun` return feeds both) |
| §9.4 pre-existing entry not displayed | 2, tested |
| §9.5 replace resume ⇒ fresh panel | 3, Step 4 (the `fingerprint` dependency) |
| §9.6 restored posting shows its stored baseline | 3, Step 4 |
| §9.7 analyze at temperature 0 | 4, Step 1 |
| §9.8 `App.test.tsx` covers §9.1 | 3, Step 1 |

No gaps.

**Placeholder scan:** every code step carries literal code. Task 3 Step 1 describes a test rather than pasting it, because it must follow the harness already established in `App.test.tsx` (mock shapes, deferred-promise plumbing) that this plan's author cannot reproduce blind — the required assertions and values are stated exactly. Task 2 Step 6's conditional instruction resolves to a specific stopgap (`""`, removed in Task 3 Step 5), not an unwritten fix.

**Type consistency:** `CachedRun` is `{ analysis, tailored, generatedAt, extraInfo, runId, baselineScore, resumeFingerprint }` in Task 2's implementation, its fixture, and both call sites in Task 3. `getCachedRun(url, fingerprint)` is declared in Task 2 and called with two arguments in Task 3 Step 4. `resumeFingerprint(resume)` is defined in Task 1 and called in Task 3 Step 3. `roundToFive(score)` is defined in Task 1 and called twice in Task 3 Step 6. `baselineScore: number | null` is declared on `Results` in Task 3 Step 6 and supplied in Step 7.

**Ordering:** Task 3 consumes Tasks 1 and 2. Task 4 is independent and could run at any point.
