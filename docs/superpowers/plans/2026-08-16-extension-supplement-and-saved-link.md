# Supplementary Experience & Saved-Resumes Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user answer a gap the analysis found by describing experience their resume omits, and regenerate from it without paying a second unit of quota.

**Architecture:** `consumeRun` in `src/lib/quota.ts` grants each charged run a bounded number of free re-runs under the same `runId`, free of the caller's tier but still counted against the per-IP ceiling. The extension stores that `runId` and the user's supplementary text with the cached result, so refining a posting reuses the id. A textarea at the bottom of the results details card feeds the existing `extraInfo` field that both API routes already accept.

**Tech Stack:** TypeScript, React 19, Vite 7 + `@crxjs/vite-plugin`, Vitest 3, Chrome MV3 `chrome.storage.local`, Next.js 15, Upstash Redis via `src/lib/kv.ts`.

**Source spec:** `docs/superpowers/specs/2026-08-16-extension-supplement-and-saved-link-design.md`

## Global Constraints

- **Work in this worktree only:** `/Users/tianzhang/Projects/careerpath/.claude/worktrees/ext-access`, branch `feat/extension-page-access`. Do not `cd` to the main checkout. Never use bare `git stash` / `git stash pop` — the stash stack is shared with other worktrees.
- **Free refinement must stay bounded.** `FREE_REFINES = 2`, so `MAX_FREE_LEGS = 6`. Removing the bound reintroduces a metered-resource bypass a previous review rated Critical: the routes check quota *before* the LLM work and charge *after* it, so an unbounded free-ride on a reused `runId` buys uncharged LLM calls.
- **Free of the tier, not free of the IP ceiling.** A free refinement must still increment the per-IP counter once per generate, or the real ceiling silently triples.
- **`RUN_TTL_SECONDS = 48 * 60 * 60`** — 48 hours, up from 10 minutes.
- **Nothing may be uploaded.** The supplement text lives in `chrome.storage.local` with the rest of the cache entry.
- **Copy, verbatim:** `Your saved resumes ↗` · `Add experience and regenerate` · `Regenerating…` · `Includes experience you added that isn't on your resume.`
- **The downloaded PDF carries no disclosure mark.** The panel marks a supplemented result; the user's own document does not.
- **Baseline to preserve:** root 76/76, extension 79/79, `npm run lint` and `npm --prefix extension run lint` clean, `npm run build` and `npm --prefix extension run build` green, `npx tsc --noEmit --project extension/tsconfig.json` clean.
- **The extension package has no React test harness** (`@testing-library/react` is not installed and this plan does not add it). Components cannot be unit-tested; say so plainly in the task report rather than implying coverage.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `extension/src/sidepanel/gapHint.ts` | Pure: turns a `GapAnalysis` into the supplement box's placeholder. Testable despite the missing React harness. |
| `extension/src/sidepanel/__tests__/gapHint.test.ts` | Its tests. |
| `extension/src/sidepanel/SupplementBox.tsx` | The textarea, its button, and its busy/disabled states. One responsibility, one call site. |

**Modified:**

| File | Change |
|---|---|
| `src/lib/quota.ts` | Bounded free refinements; `RUN_TTL_SECONDS` 10 min → 48 h; export it. |
| `src/lib/__tests__/quota.test.ts` | One existing test's semantics change deliberately; four new tests. |
| `extension/src/lib/cache.ts` | `CachedRun` gains `extraInfo` and `runId`, read back-compatibly. |
| `extension/src/lib/__tests__/cache.test.ts` | Round-trip and legacy-entry tests. |
| `extension/src/lib/run.ts` | `runTailor` gains an options bag; `newRunId` becomes exported. |
| `extension/src/lib/__tests__/run.test.ts` | Two new tests; the six existing ones keep passing untouched. |
| `extension/src/sidepanel/Results.tsx` | Renders the supplement box and the self-reported marker. |
| `extension/src/sidepanel/App.tsx` | Draft/applied supplement state, refine path, saved-resumes link. |
| `extension/src/styles.css` | One class for the outbound link. |
| `src/app/privacy/page.tsx` | Discloses that the supplement text is cached too. |
| `CHANGELOG.md` | New dated section. |

---

## Task 1: Bounded free refinements in `quota.ts`

**Why first and alone:** this is the only server change, it is the only part with real security consequences, and `src/lib/quota.ts` has already produced two Critical defects on this project (a global anonymous bucket, and an unbounded `runId` replay window). It gets its own reviewer gate before anything depends on it.

**Files:**
- Modify: `src/lib/quota.ts`
- Test: `src/lib/__tests__/quota.test.ts`

**Interfaces:**
- Consumes: `getKV` from `@/lib/kv`, `callerKey`/`Caller` from `@/lib/auth` — all already imported by this file.
- Produces: `consumeRun(caller: Caller, ip: string, runId: string): Promise<QuotaState>` — signature unchanged, behaviour changed. Newly exported: `RUN_TTL_SECONDS: number`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/__tests__/quota.test.ts`, add `RUN_TTL_SECONDS` to the existing import from `@/lib/quota`:

```ts
import {
  getQuota,
  consumeRun,
  DAILY_USER_LIMIT,
  DEVICE_TRIAL_LIMIT,
  LEGACY_ANON_LIMIT,
  DAILY_IP_LIMIT,
  RUN_TTL_SECONDS,
} from "@/lib/quota";
```

**Replace** the existing test named `"charges again when a runId is replayed beyond the two legs"`, together with the comment block directly above it, with the following. Its semantics change deliberately: the free-ride window is now the whole refinement window, not just the second leg. Do not try to keep the old assertion passing — it encodes the old bound.

```ts
  // Regression guard for a metered-resource bypass: the routes check quota
  // BEFORE the LLM work and charge AFTER it, so an UNBOUNDED free-ride on a
  // reused runId would let one attacker-chosen id buy uncharged LLM calls
  // until the marker expired. The window is deliberately bounded, not removed
  // — free refinement is a feature, unmetered refinement is a hole.
  it("charges again once a runId is replayed past the free-refinement window", async () => {
    // Legs 1-2 are the charged generate; 3-4 and 5-6 are two free refinements.
    for (let i = 0; i < 6; i++) await consumeRun(user, IP, "refined");
    expect((await getQuota(user, IP)).used).toBe(1);

    await consumeRun(user, IP, "refined");
    expect((await getQuota(user, IP)).used).toBe(2);
  });

  it("does not charge the tier for refinements inside the free window", async () => {
    await consumeRun(user, IP, "refined"); // leg 1 — charges
    await consumeRun(user, IP, "refined"); // leg 2 — the other half of the pair
    expect((await getQuota(user, IP)).used).toBe(1);

    await consumeRun(user, IP, "refined"); // refinement 1
    await consumeRun(user, IP, "refined");
    expect((await getQuota(user, IP)).used).toBe(1);

    await consumeRun(user, IP, "refined"); // refinement 2
    await consumeRun(user, IP, "refined");
    expect((await getQuota(user, IP)).used).toBe(1);
  });

  // Free of the caller's TIER is the feature. Free of the per-IP ceiling is
  // not: that ceiling bounds spend rather than rationing a user, and skipping
  // it here would silently raise the real ceiling from DAILY_IP_LIMIT pairs
  // per day to three times that.
  it("counts a free refinement against the per-IP ceiling", async () => {
    for (let i = 0; i < DAILY_IP_LIMIT - 2; i++) {
      await consumeRun({ kind: "user", userId: `filler${i}` }, IP, `f${i}`);
    }
    await consumeRun(user, IP, "refined"); // leg 1 — takes the IP to LIMIT - 1
    await consumeRun(user, IP, "refined"); // leg 2 — no IP charge

    const bystander: Caller = { kind: "user", userId: "bystander" };
    expect((await getQuota(bystander, IP)).exhausted).toBe(false);

    await consumeRun(user, IP, "refined"); // refinement 1 — IP only
    await consumeRun(user, IP, "refined");

    expect((await getQuota(user, IP)).used).toBe(1);
    expect((await getQuota(bystander, IP)).exhausted).toBe(true);
  });

  // The panel caches results for weeks and offers to refine a posting long
  // after the run that produced it. If this window shrinks back toward the
  // ten minutes it used to be, refinement silently starts charging and
  // nothing on screen explains why.
  it("keeps a runId refinable for well over a working session", () => {
    expect(RUN_TTL_SECONDS).toBeGreaterThanOrEqual(24 * 60 * 60);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/lib/__tests__/quota.test.ts
```

Expected: FAIL. `RUN_TTL_SECONDS` is not exported yet, so the file fails to resolve the import — that one error covers every new test. Record the actual output.

- [ ] **Step 3: Replace the constants in `quota.ts`**

In `src/lib/quota.ts`, change:

```ts
const RUN_TTL_SECONDS = 10 * 60;
```

to:

```ts
/**
 * How long a runId stays refinable.
 *
 * MUST stay well above a working session. The panel caches results for weeks
 * and offers to refine a posting long after the run; at the ten minutes this
 * used to be, a user returning the next day would be charged for a
 * refinement the product tells them is free, with nothing on screen to
 * explain it. There is a test asserting the floor.
 */
export const RUN_TTL_SECONDS = 48 * 60 * 60;
```

Then replace:

```ts
/** A run has exactly two legs: analyze and tailor. */
const RUN_LEGS = 2;
```

with:

```ts
/** A generate has exactly two legs: analyze and tailor. */
const LEGS_PER_GENERATE = 2;

/**
 * How many times a charged generate may be re-run for free.
 *
 * Refining a posting with supplementary experience must not cost a second
 * unit — but "free" cannot mean "unmetered". Extension code ships publicly
 * and is trivially unpackable, so an unbounded free-ride on a reused runId
 * would let one attacker-chosen id buy uncharged LLM calls until the marker
 * expired. This bound is what keeps that closed. Raising it raises the worst
 * case per IP per day proportionally.
 */
const FREE_REFINES = 2;

const MAX_FREE_LEGS = LEGS_PER_GENERATE * (1 + FREE_REFINES);
```

- [ ] **Step 4: Rewrite the free-ride branch of `consumeRun`**

In `src/lib/quota.ts`, replace this block inside `consumeRun`:

```ts
  // incr is atomic: exactly one caller sees 1, so exactly one charges.
  const seen = await kv.incr(marker, RUN_TTL_SECONDS);
  // Legs 2..RUN_LEGS ride free on leg 1's charge — that is the whole point of
  // the marker. Anything past that is a REPLAYED runId: the routes check quota
  // before doing the work and charge after, so an unbounded free-ride window
  // would let one id buy unlimited uncharged LLM calls until the marker
  // expires. Past the pair, charge normally.
  if (seen > 1 && seen <= RUN_LEGS) return getQuota(caller, ip);
```

with:

```ts
  // incr is atomic: exactly one caller sees 1, so exactly one charges.
  const seen = await kv.incr(marker, RUN_TTL_SECONDS);

  if (seen > 1 && seen <= MAX_FREE_LEGS) {
    // Inside the free window: the second leg of the charged generate, or
    // either leg of a free refinement. The caller's TIER is not charged —
    // that is the feature. The per-IP ceiling still is, once per generate,
    // because it bounds spend rather than rationing a user; skipping it here
    // would silently raise the real ceiling to (1 + FREE_REFINES) times
    // DAILY_IP_LIMIT.
    //
    // KNOWN IMPRECISION, accepted: this parity test assumes legs arrive in
    // pairs. They do not always — if analyze fails while tailor succeeds only
    // one leg is counted, and every later pair is shifted by one, so the IP
    // charge can land on a refinement's second leg instead of its first. The
    // security-relevant property is MAX_FREE_LEGS, which holds regardless of
    // parity; exact IP accounting under partial failure is not worth tracking
    // leg identity server-side.
    if (seen % LEGS_PER_GENERATE === 1 && hasIp(ip)) {
      await kv.incr(ipKey(ip), DAY_TTL_SECONDS);
    }
    return getQuota(caller, ip);
  }

  // Past the free window this is a REPLAYED runId. Charge normally.
```

Leave the rest of the function exactly as it is.

- [ ] **Step 5: Update the module docstring**

At the top of `src/lib/quota.ts`, replace:

```ts
 * One "run" = one analyze + tailor flow. Both endpoints send the same client-
 * generated runId; the first SUCCESSFUL one charges, the other does not.
```

with:

```ts
 * One "run" = one analyze + tailor flow. Both endpoints send the same client-
 * generated runId; the first SUCCESSFUL one charges, the other does not.
 *
 * Reusing that runId again refines the same result for free, up to
 * FREE_REFINES times, so a user can answer a gap the analysis found without
 * paying twice. Free of the caller's tier only — the per-IP ceiling still
 * counts every generate.
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run src/lib/__tests__/quota.test.ts
```

Expected: PASS. Record the actual output, including the count.

- [ ] **Step 7: Run the whole root suite, lint and build**

```bash
npm test && npm run lint && npm run build
```

Expected: 79 tests (76 baseline − 1 replaced + 4 new), lint clean, build green.

- [ ] **Step 8: Commit**

```bash
git add src/lib/quota.ts src/lib/__tests__/quota.test.ts
git commit -m "feat(quota): a charged run buys a bounded number of free refinements"
```

---

## Task 2: Cache the supplement and the run id

**Files:**
- Modify: `extension/src/lib/cache.ts`
- Test: `extension/src/lib/__tests__/cache.test.ts`

**Interfaces:**
- Consumes: `GapAnalysis`, `TailorResult` from `@shared/contract`.
- Produces: `CachedRun` gains two required fields:
  ```ts
  export interface CachedRun {
    analysis: GapAnalysis;
    tailored: TailorResult;
    generatedAt: string;
    extraInfo: string;
    runId: string;
  }
  ```
  `getCachedRun` / `putCachedRun` / `clearCachedRuns` / `countCachedRuns` / `cacheKey` / `MAX_CACHED_RUNS` keep their existing signatures.

- [ ] **Step 1: Write the failing tests**

In `extension/src/lib/__tests__/cache.test.ts`, replace the existing `run` helper with one that fills the new fields:

```ts
function run(score: number, extraInfo = "", runId = "rid"): CachedRun {
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
  };
}
```

Then add these tests inside the existing `describe("result cache", ...)` block:

```ts
  it("round-trips the supplement text and the run id", async () => {
    await putCachedRun("https://acme.com/jobs/1", run(62, "I used PyTorch on X", "run-7"));
    const hit = await getCachedRun("https://acme.com/jobs/1");
    expect(hit?.extraInfo).toBe("I used PyTorch on X");
    expect(hit?.runId).toBe("run-7");
  });

  // Entries written before these fields existed are already in real users'
  // browsers. A missing extraInfo must read as "" rather than undefined, or
  // the panel renders the string "undefined" in its textarea; a missing runId
  // must read as "" so the next generate mints a fresh one and is charged
  // normally, which is the right degradation.
  it("reads an entry written before these fields existed", async () => {
    await chrome.storage.local.set({
      cp_results: JSON.stringify([
        {
          key: "https://acme.com/jobs/legacy",
          analysis: run(50).analysis,
          tailored: run(50).tailored,
          generatedAt: "2026-08-13T09:00:00.000Z",
        },
      ]),
    });

    const hit = await getCachedRun("https://acme.com/jobs/legacy");
    expect(hit).not.toBeNull();
    expect(hit?.extraInfo).toBe("");
    expect(hit?.runId).toBe("");
    expect(hit?.analysis.overall_match_score).toBe(50);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm --prefix extension run test -- cache
```

Expected: FAIL — the `run` helper's object is not assignable to `CachedRun` (`extraInfo` and `runId` do not exist on the type), and the two new assertions fail. Record the actual output.

- [ ] **Step 3: Extend the stored shape in `cache.ts`**

In `extension/src/lib/cache.ts`, replace the `CachedRun` and `CacheEntry` declarations:

```ts
export interface CachedRun {
  analysis: GapAnalysis;
  tailored: TailorResult;
  /** ISO 8601, when the run finished. */
  generatedAt: string;
}

interface CacheEntry extends CachedRun {
  /** Normalized posting URL — see cacheKey. */
  key: string;
}
```

with:

```ts
export interface CachedRun {
  analysis: GapAnalysis;
  tailored: TailorResult;
  /** ISO 8601, when the run finished. */
  generatedAt: string;
  /** Experience the user said their resume omits. "" when they added none. */
  extraInfo: string;
  /**
   * The server-side run this result came from. Reusing it refines that run
   * for free; the server grants a bounded number of free refinements per
   * charged run. "" for entries written before this field existed — those
   * simply cost a new unit, which is the right degradation.
   */
  runId: string;
}

interface CacheEntry extends CachedRun {
  /** Normalized posting URL — see cacheKey. */
  key: string;
}

/**
 * What a stored entry may ACTUALLY look like. Entries written before
 * `extraInfo` and `runId` existed are already in real users' browsers, so
 * every read must treat them as optional even though the type above does not.
 */
type StoredEntry = Omit<CacheEntry, "extraInfo" | "runId"> &
  Partial<Pick<CacheEntry, "extraInfo" | "runId">>;
```

- [ ] **Step 4: Make the reads back-compatible**

Change `readAll`'s return type:

```ts
async function readAll(): Promise<StoredEntry[]> {
```

and its cast:

```ts
    return Array.isArray(parsed) ? (parsed as StoredEntry[]) : [];
```

Then change `getCachedRun`'s return to fill the defaults:

```ts
export async function getCachedRun(url: string): Promise<CachedRun | null> {
  const key = cacheKey(url);
  const hit = (await readAll()).find((e) => e.key === key);
  if (!hit) return null;
  return {
    analysis: hit.analysis,
    tailored: hit.tailored,
    generatedAt: hit.generatedAt,
    extraInfo: hit.extraInfo ?? "",
    runId: hit.runId ?? "",
  };
}
```

`putCachedRun` and `clearCachedRuns` need no change — `putCachedRun` spreads a full `CachedRun`, so it always writes both fields.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm --prefix extension run test -- cache
```

Expected: PASS, 14 tests in that file (12 existing + 2 new).

- [ ] **Step 6: Run the whole extension suite, type-check, lint and build**

```bash
npx tsc --noEmit --project extension/tsconfig.json && npm --prefix extension run test && npm --prefix extension run lint && npm --prefix extension run build
```

Expected: type-check clean. The suite will FAIL to type-check in `App.tsx` if anything there constructs a `CachedRun` — check the error, and if `App.tsx`'s `putCachedRun` call is now missing the two fields, leave it for Task 4 by passing `extraInfo: ""` and `runId: ""` there for now, with a `// filled in by Task 4` comment. Do not build the refine flow in this task.

Expected after that: 81 tests, lint clean, build green.

- [ ] **Step 7: Commit**

```bash
git add extension/src/lib/cache.ts extension/src/lib/__tests__/cache.test.ts extension/src/sidepanel/App.tsx
git commit -m "feat(extension): cache the supplement text and the run id"
```

---

## Task 3: `runTailor` accepts a supplement and a run id

**Files:**
- Modify: `extension/src/lib/run.ts`
- Test: `extension/src/lib/__tests__/run.test.ts`

**Interfaces:**
- Consumes: `apiPost` from `./api`, contract types from `@shared/contract`.
- Produces:
  ```ts
  export interface RunOptions {
    extraInfo?: string;
    runId?: string;
  }
  export function newRunId(): string;
  export async function runTailor(
    jd: ExtractedJD,
    resume: ParsedResume,
    onUpdate: (patch: Partial<RunState>) => void,
    opts?: RunOptions,
  ): Promise<void>;
  ```
  The fourth parameter is optional and defaults to `{}`, so all six existing tests in `run.test.ts` keep passing unchanged. Do not modify them.

- [ ] **Step 1: Write the failing tests**

Add to `extension/src/lib/__tests__/run.test.ts`, inside the existing `describe("runTailor", ...)` block:

```ts
  it("reuses a supplied runId instead of minting one", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes("parse-jd")) return json({ jd: {} });
      return json({ analysis: {}, tailored: {}, remaining: 4 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runTailor(JD, RESUME, () => {}, { runId: "reused-id" });

    const ids = fetchMock.mock.calls
      .filter((c) => !String(c[0]).includes("parse-jd"))
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)).runId);
    expect(ids).toEqual(["reused-id", "reused-id"]);
  });

  it("sends the supplement to both analyze and tailor", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes("parse-jd")) return json({ jd: {} });
      return json({ analysis: {}, tailored: {}, remaining: 4 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runTailor(JD, RESUME, () => {}, { extraInfo: "I used PyTorch on X" });

    const sent = fetchMock.mock.calls
      .filter((c) => !String(c[0]).includes("parse-jd"))
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)).extraInfo);
    expect(sent).toEqual(["I used PyTorch on X", "I used PyTorch on X"]);
  });
```

If the existing tests in this file build their fetch mocks differently, match the file's established pattern rather than the shape above — the assertions are what matter: two calls, both carrying the same `runId`, and both carrying the `extraInfo`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm --prefix extension run test -- run
```

Expected: FAIL — `runTailor` takes three arguments, so TypeScript rejects the fourth. Record the actual output.

- [ ] **Step 3: Export `newRunId` and add the options bag**

In `extension/src/lib/run.ts`, change the `newRunId` declaration from:

```ts
/** Collision-resistant enough for a per-run key, and defined everywhere. */
function newRunId(): string {
```

to:

```ts
/**
 * Collision-resistant enough for a per-run key, and defined everywhere.
 *
 * Exported because the PANEL decides whether a generate is new or a
 * refinement: a fresh run mints an id here, a refinement passes back the id
 * it cached, and the server charges accordingly.
 */
export function newRunId(): string {
```

Add above `runTailor`:

```ts
export interface RunOptions {
  /** Experience the user says their resume does not mention. */
  extraInfo?: string;
  /**
   * Reuse a previous run's id to refine that result for free — the server
   * grants a bounded number of free refinements per charged run. Omit to
   * start a fresh, charged run.
   */
  runId?: string;
}
```

Change the signature and the two lines that build the payload:

```ts
export async function runTailor(
  jd: ExtractedJD,
  resume: ParsedResume,
  onUpdate: (patch: Partial<RunState>) => void,
  opts: RunOptions = {},
): Promise<void> {
```

```ts
  const runId = opts.runId || newRunId();
  const payload = {
    structuredResume: resume,
    structuredJD: parsed.data.jd,
    extraInfo: opts.extraInfo ?? "",
    quality: "quality",
    runId,
  };
```

Everything else in the function stays exactly as it is, including the long comment about `runId` being minted once and sent to both legs — it is still true, and it is now also what makes refinement free.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm --prefix extension run test -- run
```

Expected: PASS — 8 tests in that file (6 existing, unchanged, plus 2 new).

- [ ] **Step 5: Type-check, test, lint and build**

```bash
npx tsc --noEmit --project extension/tsconfig.json && npm --prefix extension run test && npm --prefix extension run lint && npm --prefix extension run build
```

Expected: type-check clean, 83 tests, lint clean, build green.

- [ ] **Step 6: Commit**

```bash
git add extension/src/lib/run.ts extension/src/lib/__tests__/run.test.ts
git commit -m "feat(extension): runTailor accepts a supplement and a reusable run id"
```

---

## Task 4: The supplement box in the panel

**Files:**
- Create: `extension/src/sidepanel/gapHint.ts`, `extension/src/sidepanel/SupplementBox.tsx`
- Test: `extension/src/sidepanel/__tests__/gapHint.test.ts`
- Modify: `extension/src/sidepanel/Results.tsx`, `extension/src/sidepanel/App.tsx`

**Interfaces:**
- Consumes: `getCachedRun`/`putCachedRun` with the `CachedRun` shape from Task 2 (`{ analysis, tailored, generatedAt, extraInfo, runId }`); `runTailor(jd, resume, onUpdate, opts)`, `newRunId()`, `RunOptions` from Task 3.
- Produces:
  - `supplementPlaceholder(analysis: GapAnalysis | null): string`
  - `SupplementBox({ text, onChange, onSubmit, busy, placeholder })`, with
    ```ts
    export interface SupplementProps {
      text: string;
      onChange: (value: string) => void;
      onSubmit: () => void;
      busy: boolean;
    }
    ```
  - `Results` gains two required props: `appliedSupplement: string` and `supplement: SupplementProps`.

**Coverage note for the task report:** `SupplementBox.tsx`, `Results.tsx` and `App.tsx` are React components and this package has no React test harness. Only `gapHint.ts` is unit-tested here. Say this plainly; do not present a green build as coverage.

- [ ] **Step 1: Write the failing test for the placeholder**

Create `extension/src/sidepanel/__tests__/gapHint.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { supplementPlaceholder } from "../gapHint";
import type { GapAnalysis, RequirementRow } from "@shared/contract";

function row(requirement: string, status: RequirementRow["status"]): RequirementRow {
  return { requirement, kind: "must_have", status, evidence: "", suggestion: "" };
}

function analysis(rows: RequirementRow[]): GapAnalysis {
  return {
    overall_match_score: 60,
    rationale: "",
    requirements_matrix: rows,
    strengths: [],
    gaps: [],
  };
}

describe("supplementPlaceholder", () => {
  const GENERIC =
    "Anything not on your resume — projects, skills, or context you want considered.";

  it("falls back to the generic prompt when there is no analysis", () => {
    expect(supplementPlaceholder(null)).toBe(GENERIC);
  });

  it("falls back to the generic prompt when nothing is missing", () => {
    expect(supplementPlaceholder(analysis([row("Python", "met")]))).toBe(GENERIC);
  });

  it("names the requirements this analysis marked missing", () => {
    const got = supplementPlaceholder(
      analysis([row("Python", "met"), row("PyTorch", "missing"), row("Kubernetes", "missing")]),
    );
    expect(got).toBe("e.g. PyTorch, Kubernetes — tell us what you actually did with them.");
  });

  it("ignores partially met requirements", () => {
    const got = supplementPlaceholder(
      analysis([row("Go", "partially_met"), row("Rust", "missing")]),
    );
    expect(got).toBe("e.g. Rust — tell us what you actually did with them.");
  });

  // The panel is 400px wide. Naming every gap would wrap the placeholder into
  // a paragraph and stop it reading as an example.
  it("names at most three", () => {
    const got = supplementPlaceholder(
      analysis([
        row("A", "missing"),
        row("B", "missing"),
        row("C", "missing"),
        row("D", "missing"),
      ]),
    );
    expect(got).toBe("e.g. A, B, C — tell us what you actually did with them.");
  });

  it("skips blank requirement strings rather than emitting empty examples", () => {
    const got = supplementPlaceholder(analysis([row("  ", "missing"), row("Rust", "missing")]));
    expect(got).toBe("e.g. Rust — tell us what you actually did with them.");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm --prefix extension run test -- gapHint
```

Expected: FAIL — `Failed to resolve import "../gapHint"`.

- [ ] **Step 3: Implement `gapHint.ts`**

Create `extension/src/sidepanel/gapHint.ts`:

```ts
import type { GapAnalysis } from "@shared/contract";

const GENERIC =
  "Anything not on your resume — projects, skills, or context you want considered.";

/** Naming more than this wraps the placeholder in a 400px panel. */
const MAX_EXAMPLES = 3;

/**
 * The supplement box's placeholder, naming the requirements THIS analysis
 * marked missing.
 *
 * A fixed example would not tell the user what the box is for; their own gaps
 * do, and it costs nothing — the data is already on screen above the box.
 */
export function supplementPlaceholder(analysis: GapAnalysis | null): string {
  const missing = (analysis?.requirements_matrix ?? [])
    .filter((r) => r.status === "missing")
    .map((r) => r.requirement.trim())
    .filter(Boolean)
    .slice(0, MAX_EXAMPLES);

  if (missing.length === 0) return GENERIC;
  return `e.g. ${missing.join(", ")} — tell us what you actually did with them.`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm --prefix extension run test -- gapHint
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Write `SupplementBox.tsx`**

Create `extension/src/sidepanel/SupplementBox.tsx`:

```tsx
export interface SupplementProps {
  text: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
}

/**
 * Where a user answers a gap the analysis found.
 *
 * Free text on purpose. A per-gap "I have this" button would be one click to
 * assert an experience, and "we never fabricate" is the one claim this
 * product can make that its competitors cannot — making the user write what
 * they actually did is the guard, not a friction bug to file down later.
 */
export function SupplementBox({
  text,
  onChange,
  onSubmit,
  busy,
  placeholder,
}: SupplementProps & { placeholder: string }) {
  return (
    <>
      <div className="label">Something missing?</div>
      <textarea
        className="paste"
        rows={4}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={busy}
      />
      <button onClick={onSubmit} disabled={busy || text.trim().length === 0}>
        {busy ? "Regenerating…" : "Add experience and regenerate"}
      </button>
    </>
  );
}
```

- [ ] **Step 6: Render it from `Results.tsx`**

In `extension/src/sidepanel/Results.tsx`, add to the imports:

```tsx
import { SupplementBox, type SupplementProps } from "./SupplementBox";
import { supplementPlaceholder } from "./gapHint";
```

Change the component's props to:

```tsx
export function Results({
  state,
  company,
  generatedAt,
  appliedSupplement,
  supplement,
}: {
  state: RunState;
  company: string;
  generatedAt: string | null;
  /** What the DISPLAYED result was generated with, not what is typed below. */
  appliedSupplement: string;
  supplement: SupplementProps;
}) {
```

Inside the score card, directly after the `{generatedAt && (...)}` line and still inside the `{tailored && (<>...</>)}` fragment, add the marker:

```tsx
              {appliedSupplement.trim().length > 0 && (
                <p className="muted tiny center">
                  Includes experience you added that isn&rsquo;t on your resume.
                </p>
              )}
```

That line is why the supplement feeds analyze as well as tailor: the score rises, so the panel has to say the number is no longer derived from the parsed document alone. The downloaded PDF deliberately carries no such mark — that is the user's own document.

At the very end of the details card, after the `Copy as JSON` button and still inside the `{analysis && (<section className="card">...)}` block, add:

```tsx
          <SupplementBox {...supplement} placeholder={supplementPlaceholder(analysis)} />
```

- [ ] **Step 7: Wire it in `App.tsx`**

In `extension/src/sidepanel/App.tsx`, add `newRunId` to the existing import from `@/lib/run`:

```tsx
import { runTailor, newRunId, INITIAL_RUN_STATE, type RunState } from "@/lib/run";
```

Add two pieces of state next to `generatedAt`:

```tsx
  // What the DISPLAYED result was generated with. Distinct from the draft
  // below: the draft is what is typed but not yet sent.
  const [appliedSupplement, setAppliedSupplement] = useState("");
  const [supplementDraft, setSupplementDraft] = useState("");
  // The run this posting's displayed result came from. Reusing it makes a
  // regeneration free. "" means there is nothing to refine, so the next
  // generate mints a fresh id and is charged.
  const [runIdForPosting, setRunIdForPosting] = useState("");
```

In the JD-change effect, clear all three where `setGeneratedAt(null)` is called, and restore them from the cache hit. The effect's reset block becomes:

```tsx
    setState(INITIAL_RUN_STATE);
    setGeneratedAt(null);
    setAppliedSupplement("");
    setSupplementDraft("");
    setRunIdForPosting("");
```

and the restore inside the `.then` gains, after `setGeneratedAt(hit.generatedAt);`:

```tsx
      setAppliedSupplement(hit.extraInfo);
      setSupplementDraft(hit.extraInfo);
      setRunIdForPosting(hit.runId);
```

Replace `generate()` with a version that takes the supplement and decides whether to reuse the id. Note it does **not** reset the draft on entry — losing a paragraph the user just typed because their run failed would be worse than any bug this feature fixes:

```tsx
  async function generate(supplement: string) {
    if (!jd || !stored || busy) return;
    // Pin which posting this run is for. If the user switches tabs while a
    // run is in flight, activeJdUrlRef.current moves on; a patch that lands
    // after that point is for a posting the user is no longer looking at,
    // so drop it instead of painting stale results over the new page.
    const forUrl = cacheKey(jd.url);
    // Refining reuses this posting's run id, which is what makes it free.
    // A first generate — or one after a cache entry too old to carry an id —
    // mints a new one and is charged.
    const runId = supplement.trim().length > 0 && runIdForPosting
      ? runIdForPosting
      : newRunId();
    setState(INITIAL_RUN_STATE);
    setGeneratedAt(null);
    runningForUrlRef.current = forUrl;
    setBusy(true);
    // Accumulate the run's own result HERE rather than reading it back out of
    // `state` when the run finishes. The line below deliberately drops the
    // final patch from the DISPLAY when the user has switched tabs — so
    // `state` would hold nothing to cache, losing exactly the result this
    // cache exists to preserve, in exactly the case that motivated it.
    let latest: RunState = INITIAL_RUN_STATE;
    try {
      await runTailor(
        jd,
        stored.resume,
        (patch) => {
          latest = { ...latest, ...patch };
          if (activeJdUrlRef.current !== forUrl) return;
          setState((prev) => ({ ...prev, ...patch }));
        },
        { extraInfo: supplement, runId },
      );
      if (latest.phase === "done" && latest.analysis && latest.tailored) {
        const finishedAt = new Date().toISOString();
        await putCachedRun(forUrl, {
          analysis: latest.analysis,
          tailored: latest.tailored,
          generatedAt: finishedAt,
          extraInfo: supplement,
          runId,
        });
        setCachedCount(await countCachedRuns());
        setAppliedSupplement(supplement);
        setRunIdForPosting(runId);
        if (activeJdUrlRef.current === forUrl) {
          setState(latest);
          setGeneratedAt(finishedAt);
        }
      }
    } finally {
      runningForUrlRef.current = undefined;
      setBusy(false);
    }
  }
```

Add `cacheKey` to the cache import if Task 2 or an earlier task did not already leave it there.

Update the primary button's handler, which now has to pass an argument:

```tsx
      <button className="primary" onClick={() => void generate(supplementDraft)} disabled={!canRun}>
```

Update the `<Results />` call:

```tsx
      <Results
        state={state}
        company={jd?.company ?? ""}
        generatedAt={generatedAt}
        appliedSupplement={appliedSupplement}
        supplement={{
          text: supplementDraft,
          onChange: setSupplementDraft,
          onSubmit: () => void generate(supplementDraft),
          busy,
        }}
      />
```

Finally, remove the `extraInfo: ""` / `runId: ""` placeholder values Task 2 left in this file if they are still present anywhere.

- [ ] **Step 8: Type-check, test, lint and build**

```bash
npx tsc --noEmit --project extension/tsconfig.json && npm --prefix extension run test && npm --prefix extension run lint && npm --prefix extension run build
```

Expected: type-check clean, 89 tests (83 + 6 new), lint clean, build green.

- [ ] **Step 9: Commit**

```bash
git add extension/src/sidepanel/gapHint.ts extension/src/sidepanel/SupplementBox.tsx extension/src/sidepanel/__tests__/gapHint.test.ts extension/src/sidepanel/Results.tsx extension/src/sidepanel/App.tsx
git commit -m "feat(extension): answer a gap with experience your resume omits"
```

---

## Task 5: Saved-resumes link, privacy, changelog

**Files:**
- Modify: `extension/src/sidepanel/App.tsx`, `extension/src/styles.css`, `src/app/privacy/page.tsx`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `API_BASE` from `@/lib/config` — already exists, already resolves to localhost for a dev build and the deployed origin for a production build, and both origins are already in `host_permissions`.
- Produces: nothing new.

- [ ] **Step 1: Add the outbound link style**

Append to `extension/src/styles.css`:

```css
.outlink {
  align-self: center;
  color: var(--muted);
  font-size: 11px;
  text-decoration: none;
}
.outlink:hover { text-decoration: underline; }
```

- [ ] **Step 2: Add the link to the panel**

In `extension/src/sidepanel/App.tsx`, add to the imports:

```tsx
import { API_BASE } from "@/lib/config";
```

At the very end of the `<main>` element, after `<Results ... />`, add:

```tsx
      {/* A plain anchor, not chrome.tabs.create: opening a tab this way needs
          no `tabs` permission. The page is Clerk-gated, so a signed-out user
          lands on the sign-in prompt — the honest outcome, since the panel
          has no session to hand over. */}
      <a
        className="outlink"
        href={`${API_BASE}/app/saved`}
        target="_blank"
        rel="noreferrer"
      >
        Your saved resumes ↗
      </a>
```

- [ ] **Step 3: Disclose the supplement text on `/privacy`**

The cache paragraph currently lists what is stored per entry. In `src/app/privacy/page.tsx`, change:

```tsx
        The extension also keeps the results it generates — the match analysis
        and the tailored resume — in that same local storage, each one keyed by
```

to:

```tsx
        The extension also keeps the results it generates — the match analysis,
        the tailored resume, and anything you add about experience your resume
        omits — in that same local storage, each one keyed by
```

Re-read the whole paragraph afterwards and confirm it still reads as English.

Also update the date stamp:

```tsx
      <p className="mt-2 text-sm text-slate-500">Last updated: 2026-08-16</p>
```

- [ ] **Step 4: Add the changelog entry**

In `CHANGELOG.md`, insert directly after the `---` that follows the file header, above the existing `## 2026-08-14` section:

```markdown
## 2026-08-16 — Answer a gap without paying twice

### Added

- **Supplementary experience.** When the analysis reports a requirement as
  missing and you actually have it, a box at the bottom of the details takes
  what your resume left out and regenerates from it. The placeholder names the
  requirements *this* analysis marked missing rather than a fixed example. It
  is free text on purpose: a per-gap "I have this" button would be one click to
  assert an experience, and making you write what you actually did is the guard
  against the one thing this product promises never to do.
- **Refining is free.** A charged run now buys up to two regenerations of the
  same posting under the same `runId`, for signed-in and signed-out callers
  alike. Free of your allowance only — the per-IP ceiling still counts every
  generate, because it bounds spend rather than rationing a user. The bound is
  deliberate: extension code ships publicly, and an unlimited free-ride on a
  reused id would let one attacker-chosen id buy uncharged model calls.
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
```

- [ ] **Step 5: Verify the link's origin in both builds**

```bash
npm --prefix extension run build:dev
```

```bash
grep -c "localhost:3000/app/saved" extension/dist/assets/*.js
```

Expected: at least one match — the dev build compiles the localhost origin in.

```bash
npm --prefix extension run build
```

```bash
grep -c "localhost:3000" extension/dist/assets/*.js
```

Expected: **zero** matches. The production build tree-shakes the localhost branch out; a hit here means a dev origin would ship to users.

- [ ] **Step 6: Lint and build both packages**

```bash
npm run lint && npm run build && npm --prefix extension run lint && npm --prefix extension run test
```

Expected: lint clean both sides, web build green, extension 89 tests.

- [ ] **Step 7: Read the rendered privacy page**

```bash
npm run dev
```

Open `http://localhost:3000/privacy` and read the extension section end to end, confirming it describes what this branch actually stores. Stop the server afterwards.

If every route returns 404 HTML, an unrelated project is squatting port 3000 — check `lsof -nP -iTCP:3000 -sTCP:LISTEN` before debugging anything else; this has cost two sessions on this repo already. If you cannot render the page, say so plainly in your report rather than claiming you did.

- [ ] **Step 8: Commit**

```bash
git add extension/src/sidepanel/App.tsx extension/src/styles.css src/app/privacy/page.tsx CHANGELOG.md
git commit -m "feat(extension): saved-resumes link; document supplement storage"
```

---

## Live browser verification

Not a task — no subagent can do this. Run it before merging.

```bash
npm run dev
```

```bash
npm --prefix extension run build:dev
```

Load `.claude/worktrees/ext-access/extension/dist` at `chrome://extensions` → **Load unpacked** (`Cmd+Shift+G` to paste the path; the macOS picker hides dotted directories). **Remove any previously-loaded copy first** — two unpacked builds share the pinned extension ID and Chrome will keep serving the old one.

1. Tailor a posting. Note the remaining-runs count. The supplement box appears at the bottom of the details, its placeholder naming requirements the analysis marked missing.
2. Type an experience and regenerate. The result changes, the score moves, and the line *"Includes experience you added that isn't on your resume."* appears under the score.
3. **The remaining-runs count does not drop.** This is the point of Task 1 and the only way to see it working.
4. Download the PDF and confirm it carries no disclosure text.
5. Switch tabs and back: the result, the supplement text, and the marker all return.
6. Regenerate three more times on the same posting. The fourth *does* decrement the count.
7. Click **Your saved resumes ↗** — a new tab opens at the local app's saved page.

Also still outstanding from earlier work on this branch: the PDF download itself, "Read this site" on a non-listed site, a Workday posting reading with no click, and a `chrome://` page showing the message with no button.

---

## Self-Review

**Spec coverage:**

| Spec | Task |
|---|---|
| §2 saved-resumes link, `${API_BASE}/app/saved`, new tab | 5, Step 2 |
| §3 box at the bottom of the details card | 4, Step 6 |
| §3 placeholder generated from missing requirements | 4, Steps 1–3 |
| §3 result and supplement both cached | 2 + 4, Step 7 |
| §3 a failed run must not clear the textarea | 4, Step 7 (`generate()` never resets the draft) |
| §3 nothing cached unless the run completed | 4, Step 7 (the `latest.phase === "done"` guard) |
| §4 bounded free refinements, `FREE_REFINES = 2` | 1, Step 3 |
| §4 `RUN_TTL_SECONDS` 10 min → 48 h | 1, Step 3, with a floor test |
| §4 free of the tier, counted against the IP ceiling | 1, Step 4, tested |
| §4 the parity imprecision, stated | 1, Step 4 (comment) |
| §4 client reuses the cached `runId` | 2 (storage) + 4, Step 7 (reuse) |
| §5 panel marks a supplemented result | 4, Step 6 |
| §5 the PDF carries no mark | nothing touches `shared/resume-pdf.tsx`; asserted in Live verification step 4 |
| §6 legacy entries without the new fields | 2, Steps 3–4, tested |
| §8.1–8.10 success criteria | 8.4, 8.5, 8.6 in Task 1's tests; 8.10 in Task 2's; 8.2 in Task 4's; the rest in Live verification |

No gaps.

**Placeholder scan:** every code step carries literal code. The one conditional instruction — Task 2 Step 6's note about `App.tsx` failing to type-check — resolves to a specific stopgap (`extraInfo: ""`, `runId: ""`, removed in Task 4 Step 7), not an unwritten fix.

**Type consistency:** `CachedRun` is `{ analysis, tailored, generatedAt, extraInfo, runId }` in Task 2's implementation, its tests, and both call sites in Task 4. `RunOptions` is `{ extraInfo?, runId? }` in Task 3 and is constructed as `{ extraInfo: supplement, runId }` in Task 4. `newRunId()` is exported in Task 3 and called in Task 4. `supplementPlaceholder(analysis: GapAnalysis | null)` is defined in Task 4 Step 3 and called in Step 6 with `analysis`, which is `GapAnalysis | null` there. `SupplementProps` is declared in Task 4 Step 5 and consumed in Steps 6 and 7. `RUN_TTL_SECONDS` is exported in Task 1 Step 3 and imported by its test in Step 1.

**One ordering note:** Task 4 consumes Tasks 2 and 3. Do not start it before both are committed.
