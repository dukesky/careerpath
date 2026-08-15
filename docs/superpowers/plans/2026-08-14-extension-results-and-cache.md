# Extension Results Layout & Per-JD Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorder the side panel's results around a one-click PDF download, and keep each posting's generated result so switching tabs no longer destroys it.

**Architecture:** The PDF module moves from `src/lib/resume-pdf.tsx` to `shared/resume-pdf.tsx` so the web app and the extension render one identical layout from one source; the extension imports it dynamically so `@react-pdf/renderer` never loads with the panel. A new `extension/src/lib/cache.ts` persists each run's `analysis` + `tailored` + timestamp to `chrome.storage.local` under a tracking-parameter-stripped URL key, newest-first, capped at 20. `App.tsx` stops blanket-resetting on JD change and instead restores from that cache, and writes to it from the run's own accumulated result rather than from React state.

**Tech Stack:** TypeScript, React 19, Vite 7 + `@crxjs/vite-plugin`, Vitest 3, `@react-pdf/renderer` 4.5.1, Chrome MV3 `chrome.storage.local`, Next.js 15 (web app side).

**Source spec:** `docs/superpowers/specs/2026-08-14-extension-results-and-cache-design.md`

## Global Constraints

- **Work in this worktree only:** `/Users/tianzhang/Projects/careerpath/.claude/worktrees/ext-access`, branch `feat/extension-page-access`. Do not `cd` to the main checkout. Never use bare `git stash` / `git stash pop` — the stash stack is shared with other worktrees.
- **`shared/contract.ts` must never gain a runtime export.** That rule is about *that file*, not the `shared/` directory. `shared/resume-pdf.tsx` is a runtime module and that is fine and intended.
- **`@react-pdf/renderer` must be imported dynamically in the extension** — `await import("@shared/resume-pdf")` inside the click handler, never a top-level import. It is large; the panel must open without it.
- **Nothing in this plan may upload anything.** The cache is `chrome.storage.local` only. No sync storage, no server mirror.
- **Cache cap is exactly 20 entries**, newest first, oldest evicted.
- **Cache key is the URL with `utm_*`, `ref`, `source`, `trk` and the fragment removed** — those four names exactly.
- **Button copy, verbatim:** `Download PDF resume` · `Copy as JSON` · `Tailor again` · `Tailor my resume` · `Clear N cached results`. Timestamp line reads `generated <relative time>`, lowercase `g`.
- **Baseline to preserve:** root 71/71, extension 61/61, `npm run lint` and `npm --prefix extension run lint` clean, `npm run build` and `npm --prefix extension run build` green. Every task ends at or above this.
- **The extension package has no React test harness** (`@testing-library/react` is not installed and this plan does not add it). React components in `extension/src/sidepanel/` cannot be unit-tested. Where a task's deliverable is a component, say so plainly in the task report rather than implying coverage.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `shared/resume-pdf.tsx` | The one PDF layout, used by the web app and the extension. Moved from `src/lib/resume-pdf.tsx`. |
| `shared/__tests__/resume-pdf.test.ts` | Locks `resumePdfFilename` and proves the module imports from its new path. |
| `extension/src/lib/cache.ts` | Per-posting result cache: key normalization, read, write-with-eviction, clear, count. |
| `extension/src/lib/relativeTime.ts` | Pure `Date` → `"2 minutes ago"` formatter for the panel. |
| `extension/src/lib/__tests__/cache.test.ts` | Cache behaviour incl. tracking-param normalization and 21st-entry eviction. |
| `extension/src/lib/__tests__/relativeTime.test.ts` | Boundary cases incl. clock skew and an unparseable timestamp. |
| `extension/src/sidepanel/DownloadPdf.tsx` | The download button and its dynamic import. Isolated so the heavy import has exactly one call site. |

**Modified:**

| File | Change |
|---|---|
| `src/components/ResultsView.tsx:281` | Dynamic import re-points to `@shared/resume-pdf`. |
| `src/app/app/saved/page.tsx:125` | Same. |
| `extension/package.json` | Adds `@react-pdf/renderer` to `dependencies`. |
| `extension/tsconfig.json` | `include` gains `"../shared/resume-pdf.tsx"`. |
| `extension/src/sidepanel/Results.tsx` | Reordered: score + download first, everything explanatory second. |
| `extension/src/sidepanel/App.tsx` | Cache restore on JD change, cache write on run completion, `Tailor again`, clear control. |
| `extension/src/lib/storage.ts` | One comment pointing at `cache.ts` as the second persisted thing. |
| `extension/src/styles.css` | One new class for the clear-cache text button. |
| `src/app/privacy/page.tsx` | States that generated results are cached in the browser and can be cleared. |
| `CHANGELOG.md` | New dated section. |

**Deleted:** `src/lib/resume-pdf.tsx` (moved, not copied — a second copy of the layout would drift).

---

## Task 1: Move the PDF module to `shared/`

**Why first:** every later task depends on the module living at its new path, and this task changes no behaviour, so a regression here is unambiguous.

**Files:**
- Create: `shared/resume-pdf.tsx` (git-move of `src/lib/resume-pdf.tsx`)
- Delete: `src/lib/resume-pdf.tsx`
- Modify: `src/components/ResultsView.tsx:281`, `src/app/app/saved/page.tsx:125`
- Test: `shared/__tests__/resume-pdf.test.ts`

**Interfaces:**
- Consumes: `ParsedResume` from `shared/contract.ts` (already exists).
- Produces: `shared/resume-pdf.tsx` exporting exactly two things, signatures unchanged from today:
  - `resumePdfFilename(candidateName: string, company: string): string`
  - `generateResumePdf(resume: ParsedResume): Promise<Blob>`

- [ ] **Step 1: Write the failing test**

Create `shared/__tests__/resume-pdf.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resumePdfFilename, generateResumePdf } from "@shared/resume-pdf";

describe("resumePdfFilename", () => {
  it("joins a slugged name, company and Resume", () => {
    expect(resumePdfFilename("Jane Doe", "Adobe")).toBe("Jane_Doe_Adobe_Resume.pdf");
  });

  it("collapses punctuation into single underscores", () => {
    expect(resumePdfFilename("Jean-Luc  O'Brien", "Acme, Inc.")).toBe(
      "Jean_Luc_O_Brien_Acme_Inc_Resume.pdf",
    );
  });

  it("drops empty parts instead of leaving a dangling separator", () => {
    expect(resumePdfFilename("", "Adobe")).toBe("Adobe_Resume.pdf");
    expect(resumePdfFilename("Jane Doe", "")).toBe("Jane_Doe_Resume.pdf");
  });
});

describe("module surface", () => {
  it("still exports the PDF generator from the shared path", () => {
    expect(typeof generateResumePdf).toBe("function");
  });
});
```

Note on that last test: it deliberately does **not** call `generateResumePdf`. Importing the module is the assertion that matters — it proves `@react-pdf/renderer` resolves and the module-scope `Font.registerHyphenationCallback(...)` runs under the root Vitest node environment. Actually rendering a PDF here would add seconds to the suite to test a third-party library.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run shared/__tests__/resume-pdf.test.ts
```

Expected: FAIL — `Failed to resolve import "@shared/resume-pdf"`.

- [ ] **Step 3: Move the file with git so history follows it**

```bash
git mv src/lib/resume-pdf.tsx shared/resume-pdf.tsx
```

- [ ] **Step 4: Re-point the moved file's own type import**

In `shared/resume-pdf.tsx`, line 10 currently reads:

```tsx
import type { ParsedResume } from "./resume";
```

Replace it with:

```tsx
import type { ParsedResume } from "./contract";
```

`src/lib/resume.ts` re-exported this type from `@shared/contract` anyway, so this is the same type by a shorter path — and it keeps `shared/` from importing out of `src/`, which would defeat the point of the move. Change nothing else in the file.

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run shared/__tests__/resume-pdf.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Re-point the web app's two dynamic imports**

In `src/components/ResultsView.tsx`, inside `exportPdf()` around line 280:

```tsx
      // Dynamic import keeps the heavy PDF library out of the initial bundle.
      const { generateResumePdf, resumePdfFilename } = await import(
        "@shared/resume-pdf"
      );
```

In `src/app/app/saved/page.tsx`, inside `exportPdf()` around line 124:

```tsx
    const { generateResumePdf, resumePdfFilename } = await import(
      "@shared/resume-pdf"
    );
```

Both files keep every other line as-is. `@shared/*` is already mapped to `./shared/*` in the root `tsconfig.json`, so no config change is needed on the web app side.

- [ ] **Step 7: Verify nothing still points at the old path**

```bash
grep -rn "lib/resume-pdf" --include="*.ts" --include="*.tsx" . --exclude-dir=node_modules --exclude-dir=.next
```

Expected: **no output**. Any hit is a broken import that TypeScript will catch but the runtime would only hit on click.

- [ ] **Step 8: Run the full root suite, lint and build**

```bash
npm test && npm run lint && npm run build
```

Expected: 75/75 tests pass (71 baseline + 4 new), lint clean, build green.

- [ ] **Step 9: Commit**

```bash
git add shared/resume-pdf.tsx shared/__tests__/resume-pdf.test.ts src/components/ResultsView.tsx src/app/app/saved/page.tsx src/lib/resume-pdf.tsx
git commit -m "refactor: move the PDF resume layout to shared/ for extension reuse"
```

---

## Task 2: Result cache module and relative-time helper

**Why now:** both are pure, fully unit-testable modules with no UI. Building them ahead of the panel work means the panel task is only wiring, and a defect in eviction or key normalization is caught by a test rather than by clicking around a browser.

Nothing imports these two modules at the end of this task. That is expected — they are consumed in Tasks 3 and 4.

**Files:**
- Create: `extension/src/lib/cache.ts`, `extension/src/lib/relativeTime.ts`
- Modify: `extension/src/lib/storage.ts` (comment only)
- Test: `extension/src/lib/__tests__/cache.test.ts`, `extension/src/lib/__tests__/relativeTime.test.ts`

**Interfaces:**
- Consumes: `GapAnalysis`, `TailorResult` from `@shared/contract`.
- Produces:
  - `cacheKey(rawUrl: string): string`
  - `interface CachedRun { analysis: GapAnalysis; tailored: TailorResult; generatedAt: string }`
  - `const MAX_CACHED_RUNS = 20`
  - `getCachedRun(url: string): Promise<CachedRun | null>`
  - `putCachedRun(url: string, run: CachedRun): Promise<void>`
  - `clearCachedRuns(): Promise<void>`
  - `countCachedRuns(): Promise<number>`
  - `relativeTime(iso: string, now?: number): string`

- [ ] **Step 1: Write the failing cache test**

Create `extension/src/lib/__tests__/cache.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  cacheKey,
  getCachedRun,
  putCachedRun,
  clearCachedRuns,
  countCachedRuns,
  MAX_CACHED_RUNS,
  type CachedRun,
} from "@/lib/cache";
import type { GapAnalysis, ParsedResume, TailorResult } from "@shared/contract";

const RESUME: ParsedResume = {
  contact: { name: "Ada Lovelace", email: "", phone: "", location: "", links: [] },
  summary: "",
  experience: [],
  projects: [],
  skills: [],
  education: [],
};

function run(score: number): CachedRun {
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
  return { analysis, tailored, generatedAt: "2026-08-14T10:00:00.000Z" };
}

function fakeChromeStorage() {
  const data: Record<string, unknown> = {};
  return {
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => {
          const out: Record<string, unknown> = {};
          for (const k of keys) if (k in data) out[k] = data[k];
          return out;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(data, items);
        }),
        remove: vi.fn(async (keys: string[]) => {
          for (const k of keys) delete data[k];
        }),
      },
    },
  };
}

describe("cacheKey", () => {
  it("strips utm_* parameters", () => {
    expect(
      cacheKey("https://boards.greenhouse.io/acme/jobs/123?utm_source=linkedin&utm_campaign=x"),
    ).toBe("https://boards.greenhouse.io/acme/jobs/123");
  });

  it("strips ref, source and trk", () => {
    expect(cacheKey("https://jobs.lever.co/acme/abc?ref=twitter&source=feed&trk=public")).toBe(
      "https://jobs.lever.co/acme/abc",
    );
  });

  it("strips the fragment", () => {
    expect(cacheKey("https://acme.com/jobs/9#apply")).toBe("https://acme.com/jobs/9");
  });

  it("keeps parameters that identify the posting", () => {
    expect(cacheKey("https://acme.com/careers?gh_jid=456&utm_source=x")).toBe(
      "https://acme.com/careers?gh_jid=456",
    );
  });

  it("returns an unparseable url verbatim rather than dropping it", () => {
    expect(cacheKey("not a url")).toBe("not a url");
  });
});

describe("result cache", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", fakeChromeStorage());
  });

  it("returns null for a posting with no cached run", async () => {
    expect(await getCachedRun("https://acme.com/jobs/1")).toBeNull();
  });

  it("round-trips a run", async () => {
    await putCachedRun("https://acme.com/jobs/1", run(62));
    const hit = await getCachedRun("https://acme.com/jobs/1");
    expect(hit?.analysis.overall_match_score).toBe(62);
    expect(hit?.tailored.projected_match_score).toBe(72);
    expect(hit?.generatedAt).toBe("2026-08-14T10:00:00.000Z");
  });

  it("hits the same entry when the url carries tracking parameters", async () => {
    await putCachedRun("https://acme.com/jobs/1", run(62));
    const hit = await getCachedRun("https://acme.com/jobs/1?utm_source=linkedin#top");
    expect(hit?.analysis.overall_match_score).toBe(62);
  });

  it("replaces rather than duplicates when the same posting is tailored again", async () => {
    await putCachedRun("https://acme.com/jobs/1", run(62));
    await putCachedRun("https://acme.com/jobs/1", run(70));
    expect(await countCachedRuns()).toBe(1);
    expect((await getCachedRun("https://acme.com/jobs/1"))?.analysis.overall_match_score).toBe(70);
  });

  it("evicts the oldest once past the cap", async () => {
    for (let i = 0; i < MAX_CACHED_RUNS; i++) {
      await putCachedRun(`https://acme.com/jobs/${i}`, run(i));
    }
    expect(await countCachedRuns()).toBe(MAX_CACHED_RUNS);
    expect(await getCachedRun("https://acme.com/jobs/0")).not.toBeNull();

    await putCachedRun("https://acme.com/jobs/last", run(99));

    expect(await countCachedRuns()).toBe(MAX_CACHED_RUNS);
    expect(await getCachedRun("https://acme.com/jobs/0")).toBeNull();
    expect(await getCachedRun("https://acme.com/jobs/last")).not.toBeNull();
    expect(await getCachedRun("https://acme.com/jobs/1")).not.toBeNull();
  });

  it("clears everything", async () => {
    await putCachedRun("https://acme.com/jobs/1", run(62));
    await putCachedRun("https://acme.com/jobs/2", run(63));
    await clearCachedRuns();
    expect(await countCachedRuns()).toBe(0);
    expect(await getCachedRun("https://acme.com/jobs/1")).toBeNull();
  });

  it("treats a corrupt blob as empty instead of throwing", async () => {
    await chrome.storage.local.set({ cp_results: "{not json" });
    expect(await countCachedRuns()).toBe(0);
    expect(await getCachedRun("https://acme.com/jobs/1")).toBeNull();
    // and it recovers — a write over the corrupt value must still land
    await putCachedRun("https://acme.com/jobs/1", run(62));
    expect(await countCachedRuns()).toBe(1);
  });
});
```

- [ ] **Step 2: Write the failing relative-time test**

Create `extension/src/lib/__tests__/relativeTime.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { relativeTime } from "@/lib/relativeTime";

const NOW = Date.parse("2026-08-14T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  it("reads 'just now' under a minute", () => {
    expect(relativeTime(ago(0), NOW)).toBe("just now");
    expect(relativeTime(ago(59 * SEC), NOW)).toBe("just now");
  });

  it("reads 'just now' for a future timestamp rather than a negative count", () => {
    // Clock skew between the run and this render is normal; "-3 minutes ago"
    // is not something a user should ever see.
    expect(relativeTime(ago(-5 * MIN), NOW)).toBe("just now");
  });

  it("singularizes one minute and one hour and one day", () => {
    expect(relativeTime(ago(MIN), NOW)).toBe("1 minute ago");
    expect(relativeTime(ago(HOUR), NOW)).toBe("1 hour ago");
    expect(relativeTime(ago(DAY), NOW)).toBe("1 day ago");
  });

  it("pluralizes beyond one", () => {
    expect(relativeTime(ago(2 * MIN), NOW)).toBe("2 minutes ago");
    expect(relativeTime(ago(59 * MIN), NOW)).toBe("59 minutes ago");
    expect(relativeTime(ago(3 * HOUR), NOW)).toBe("3 hours ago");
    expect(relativeTime(ago(23 * HOUR), NOW)).toBe("23 hours ago");
    expect(relativeTime(ago(9 * DAY), NOW)).toBe("9 days ago");
  });

  it("falls back to 'recently' for an unparseable timestamp", () => {
    expect(relativeTime("banana", NOW)).toBe("recently");
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

```bash
npm --prefix extension run test -- cache relativeTime
```

Expected: FAIL — `Failed to resolve import "@/lib/cache"` and `"@/lib/relativeTime"`.

- [ ] **Step 4: Implement `relativeTime.ts`**

Create `extension/src/lib/relativeTime.ts`:

```ts
/**
 * "2 minutes ago" for the panel's `generated <relative time>` line.
 *
 * `now` is a parameter rather than a `Date.now()` call inside so the tests can
 * pin it. The panel does not re-render on a timer: this string is computed
 * when a result is painted, which is when the user is actually looking at it.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "recently";

  const secs = Math.floor((now - then) / 1000);
  // Negative means the stored timestamp is ahead of this clock. Show the
  // floor rather than a negative count.
  if (secs < 60) return "just now";

  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
```

- [ ] **Step 5: Implement `cache.ts`**

Create `extension/src/lib/cache.ts`:

```ts
import type { GapAnalysis, TailorResult } from "@shared/contract";

/**
 * Generated results, cached per posting in chrome.storage.local.
 *
 * This is the SECOND thing the extension persists on the user's machine — the
 * first is the base resume, in storage.ts. Nothing here is ever uploaded, and
 * /privacy says so in writing. If you change what this module stores, the
 * privacy page and the panel's clear control have to change with it.
 */

const RESULTS_KEY = "cp_results";

/** Postings go stale; keeping more would grow the blob without helping. */
export const MAX_CACHED_RUNS = 20;

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

/**
 * The posting URL with tracking parameters and the fragment removed.
 *
 * Without this, the same posting reached from a search result
 * (`?utm_source=...`) and from a shared link occupies two entries, and the
 * second visit looks uncached. Hashing the page content was considered and
 * rejected: job pages carry timestamps and rotating "similar jobs" rails, so
 * the same posting hashes differently between loads and would almost never
 * hit.
 */
export function cacheKey(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.hash = "";
    // Snapshot the names first: deleting while iterating a live URLSearchParams
    // skips entries.
    for (const name of [...u.searchParams.keys()]) {
      if (
        name.startsWith("utm_") ||
        name === "ref" ||
        name === "source" ||
        name === "trk"
      ) {
        u.searchParams.delete(name);
      }
    }
    return u.toString();
  } catch {
    // Not a parseable URL. Cache under it verbatim rather than dropping the
    // result — an exact repeat still hits.
    return rawUrl;
  }
}

/**
 * A corrupt or unreadable blob reads as empty rather than throwing. A cache is
 * expendable; a panel that cannot render because of one is not.
 */
async function readAll(): Promise<CacheEntry[]> {
  try {
    const got = await chrome.storage.local.get([RESULTS_KEY]);
    const raw = got[RESULTS_KEY];
    if (typeof raw !== "string") return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CacheEntry[]) : [];
  } catch {
    return [];
  }
}

export async function getCachedRun(url: string): Promise<CachedRun | null> {
  const key = cacheKey(url);
  const hit = (await readAll()).find((e) => e.key === key);
  if (!hit) return null;
  return {
    analysis: hit.analysis,
    tailored: hit.tailored,
    generatedAt: hit.generatedAt,
  };
}

/**
 * Newest first. Re-tailoring a posting replaces its entry rather than adding a
 * second one, so "Tailor again" cannot fill the cache with one posting.
 */
export async function putCachedRun(url: string, cached: CachedRun): Promise<void> {
  const key = cacheKey(url);
  const rest = (await readAll()).filter((e) => e.key !== key);
  const next = [{ key, ...cached }, ...rest].slice(0, MAX_CACHED_RUNS);
  await chrome.storage.local.set({ [RESULTS_KEY]: JSON.stringify(next) });
}

export async function clearCachedRuns(): Promise<void> {
  await chrome.storage.local.remove([RESULTS_KEY]);
}

export async function countCachedRuns(): Promise<number> {
  return (await readAll()).length;
}
```

`readAll` deliberately repeats `storage.ts`'s read-and-parse shape rather than sharing it: `storage.ts`'s helper returns `null` for absent-or-corrupt, and this one must return `[]` so callers can iterate without a guard. The eight duplicated lines are cheaper than a helper with two return contracts.

- [ ] **Step 6: Point `storage.ts` at the new module**

`extension/src/lib/storage.ts` opens with a comment claiming to describe everything the extension keeps. It no longer does. Replace lines 3–7:

```ts
/**
 * Everything the extension keeps lives here, in chrome.storage.local — on the
 * user's device, never uploaded for storage. The /privacy page commits to
 * this in writing; do not add a sync-storage or server-side mirror.
 */
```

with:

```ts
/**
 * The base resume and the device token, in chrome.storage.local — on the
 * user's device, never uploaded for storage. The /privacy page commits to
 * this in writing; do not add a sync-storage or server-side mirror.
 *
 * Generated results are also persisted, in lib/cache.ts. Both are covered by
 * the same promise, and both must stay local.
 */
```

- [ ] **Step 7: Run both tests to verify they pass**

```bash
npm --prefix extension run test -- cache relativeTime
```

Expected: PASS — 13 cache tests + 6 relative-time tests.

- [ ] **Step 8: Run the whole extension suite, lint and build**

```bash
npm --prefix extension run test && npm --prefix extension run lint && npm --prefix extension run build
```

Expected: 80/80 (61 baseline + 19 new), lint clean, build green.

- [ ] **Step 9: Commit**

```bash
git add extension/src/lib/cache.ts extension/src/lib/relativeTime.ts extension/src/lib/__tests__/cache.test.ts extension/src/lib/__tests__/relativeTime.test.ts extension/src/lib/storage.ts
git commit -m "feat(extension): per-posting result cache and relative-time helper"
```

---

## Task 3: PDF download button and results reorder

**Files:**
- Create: `extension/src/sidepanel/DownloadPdf.tsx`
- Modify: `extension/package.json`, `extension/tsconfig.json`, `extension/src/sidepanel/Results.tsx`

**Interfaces:**
- Consumes: `generateResumePdf(resume: ParsedResume): Promise<Blob>` and `resumePdfFilename(candidateName: string, company: string): string` from `@shared/resume-pdf` (Task 1); `relativeTime(iso: string, now?: number): string` from `@/lib/relativeTime` (Task 2); `RunState` from `@/lib/run`.
- Produces:
  - `DownloadPdf({ resume, company }: { resume: ParsedResume; company: string })` — a React component.
  - `Results` gains two required props: `company: string` and `generatedAt: string | null`. **Task 4 must pass both**, or the panel will not compile.

**Coverage note for the task report:** `DownloadPdf.tsx` and `Results.tsx` are React components and this package has no React test harness. They are not unit-tested. Say this plainly in the report — do not describe the build passing as coverage.

**`generatedAt` is `null` for the whole of this task.** Task 4 is what supplies it, so the `generated <relative time>` line will not appear yet. That is expected, not a defect.

- [ ] **Step 1: Add `@react-pdf/renderer` to the extension**

```bash
npm --prefix extension install @react-pdf/renderer@^4.5.1
```

Then confirm it landed in `dependencies` (not `devDependencies`) in `extension/package.json` — it ships in the panel bundle:

```bash
grep -n "react-pdf" extension/package.json
```

Expected: one line, inside the `"dependencies"` block.

Background if the build later misbehaves: the library's browser builds inline their own `Buffer` implementation and guard `global` with `typeof global !== "undefined"`, so **no Node polyfill and no `vite.config.ts` change is expected.** This was checked against `node_modules/@react-pdf/pdfkit/lib/pdfkit.browser.js` before this plan was written. If the build does fail on a Node global, stop and report rather than adding polyfills on your own initiative — it would mean the assumption behind the shared-module design is wrong.

- [ ] **Step 2: Add the shared PDF module to the extension's tsconfig**

`extension/tsconfig.json` names `shared/contract.ts` file-by-file. Change the last line's `include` array from:

```json
  "include": ["src", "vite.config.ts", "manifest.config.ts", "../shared/contract.ts"]
```

to:

```json
  "include": [
    "src",
    "vite.config.ts",
    "manifest.config.ts",
    "../shared/contract.ts",
    "../shared/resume-pdf.tsx"
  ]
```

Without this, `tsc --noEmit` (which `npm --prefix extension run build` runs first) does not type-check the shared PDF module against the extension's settings, and a type error there would only surface in the web app's build.

- [ ] **Step 3: Write the download button**

Create `extension/src/sidepanel/DownloadPdf.tsx`:

```tsx
import { useState } from "react";
import type { ParsedResume } from "@shared/contract";

/**
 * The one call site for the PDF library.
 *
 * The import is dynamic and must stay that way: @react-pdf/renderer is large,
 * and a top-level import would load it every time the panel opens — for every
 * user, including the ones who never click download. Here it loads on the
 * first click and the browser caches it for later ones.
 *
 * The layout itself lives in shared/resume-pdf.tsx and is the SAME module the
 * web app renders from, so a resume downloaded here and one downloaded from
 * the site are byte-for-byte the same document.
 */
export function DownloadPdf({
  resume,
  company,
}: {
  resume: ParsedResume;
  company: string;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function download() {
    setBusy(true);
    setFailed(false);
    try {
      const { generateResumePdf, resumePdfFilename } = await import(
        "@shared/resume-pdf"
      );
      const blob = await generateResumePdf(resume);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = resumePdfFilename(resume.contact.name, company);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="primary" onClick={() => void download()} disabled={busy}>
        {busy ? "Building PDF…" : "Download PDF resume"}
      </button>
      {failed && <p className="error">Couldn&rsquo;t build the PDF. Try again.</p>}
    </>
  );
}
```

- [ ] **Step 4: Reorder `Results.tsx`**

Replace the entire contents of `extension/src/sidepanel/Results.tsx` with:

```tsx
import type { RunState } from "@/lib/run";
import type { ReqStatus } from "@shared/contract";
import { relativeTime } from "@/lib/relativeTime";
import { DownloadPdf } from "./DownloadPdf";

const STATUS_MARK: Record<ReqStatus, string> = {
  met: "✅",
  partially_met: "⚠️",
  missing: "❌",
};

const PHASE_COPY: Record<string, string> = {
  reading: "Reading the role's requirements…",
  comparing: "Comparing against your experience…",
  writing: "Writing the tailored version…",
};

/**
 * Order is the point of this component: score, then the artifact, then the
 * explanation. The user's job is decide → download → apply; the requirement
 * matrix and change log answer "why", which is a question they ask second if
 * at all, so nothing explanatory sits between the score and the download.
 */
export function Results({
  state,
  company,
  generatedAt,
}: {
  state: RunState;
  company: string;
  generatedAt: string | null;
}) {
  const progress = PHASE_COPY[state.phase];
  const { analysis, tailored } = state;

  return (
    <div>
      {state.phase === "error" && state.error && (
        <p className="error">{state.error.message}</p>
      )}

      {progress && !analysis && <p className="muted">{progress}</p>}

      {analysis && (
        <section className="card">
          <div className="score">
            {analysis.overall_match_score}
            {tailored && <span className="after"> → {tailored.projected_match_score}</span>}
            <span className="muted tiny"> match</span>
          </div>
          {analysis.rationale && <p className="muted">{analysis.rationale}</p>}

          {/* The download cannot appear any earlier than this. It downloads the
              REWRITTEN resume, which only exists once the tailor leg returns —
              the slower of the two parallel calls. Until then the score card
              renders alone. That gap is expected; it is not a missing loading
              state, and moving this block will not make it shorter. */}
          {tailored && (
            <>
              <DownloadPdf resume={tailored.resume} company={company} />
              {generatedAt && (
                <p className="muted tiny center">generated {relativeTime(generatedAt)}</p>
              )}
            </>
          )}
        </section>
      )}

      {progress && analysis && !tailored && <p className="muted">{progress}</p>}

      {analysis && (
        <section className="card">
          <div className="label">Details</div>

          {tailored && (
            <>
              <div className="label">What changed</div>
              <ul className="reqs">
                {tailored.change_log.map((c, i) => (
                  <li key={i}>
                    <strong>{c.section}</strong>
                    <div className="muted tiny">{c.reason}</div>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="label">Requirements</div>
          <ul className="reqs">
            {analysis.requirements_matrix.map((row, i) => (
              <li key={i}>
                <span>{STATUS_MARK[row.status]}</span> <strong>{row.requirement}</strong>
                {row.evidence && <div className="muted tiny">{row.evidence}</div>}
              </li>
            ))}
          </ul>

          {analysis.gaps.length > 0 && (
            <>
              <div className="label">Honest gaps</div>
              <ul className="reqs">
                {analysis.gaps.map((g, i) => (
                  <li key={i}>
                    <strong>{g.gap}</strong>
                    {g.mitigation && <div className="muted tiny">{g.mitigation}</div>}
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* Was "Copy tailored resume". It copies raw JSON, which the old
              label did not admit and which the PDF button above now actually
              delivers. Kept as a developer affordance, demoted out of the
              primary path. */}
          {tailored && (
            <button
              onClick={() =>
                void navigator.clipboard.writeText(JSON.stringify(tailored.resume, null, 2))
              }
            >
              Copy as JSON
            </button>
          )}
        </section>
      )}
    </div>
  );
}
```

Two behaviours to preserve deliberately, both already encoded above: the details card is gated on `analysis`, **not** on `tailored`, so the requirement matrix still appears the moment the fast analyze leg lands, and it still appears if the tailor leg fails outright. The rationale stays under the score because it explains the number the user is deciding on, not the rewrite.

- [ ] **Step 5: Type-check to confirm `Results`' new props are enforced**

```bash
npx tsc --noEmit --project extension/tsconfig.json
```

Expected: FAIL, exactly one error in `src/sidepanel/App.tsx` — `Property 'company' is missing`. That failure is the point: it proves the new props are required and that Task 4 cannot forget them.

- [ ] **Step 6: Satisfy the compiler from `App.tsx` with a minimal change**

In `extension/src/sidepanel/App.tsx`, change the single `<Results ... />` line near the end of the component from:

```tsx
      <Results state={state} />
```

to:

```tsx
      <Results state={state} company={jd?.company ?? ""} generatedAt={null} />
```

`generatedAt` stays hard-`null` until Task 4 wires the cache. Change nothing else in `App.tsx` in this task.

- [ ] **Step 7: Type-check, test, lint and build**

```bash
npx tsc --noEmit --project extension/tsconfig.json && npm --prefix extension run test && npm --prefix extension run lint && npm --prefix extension run build
```

Expected: type-check clean, 80/80 tests, lint clean, build green.

- [ ] **Step 8: Confirm the PDF library is a separate chunk, not in the panel's entry**

```bash
ls -la extension/dist/assets/ | sort -k5 -n | tail -5
```

Expected: a chunk of roughly 1MB or more (the PDF library) that is **separate** from the side-panel entry chunk. If the panel entry itself is that large, the dynamic import was flattened and the panel now pays the cost on every open — stop and report.

- [ ] **Step 9: Commit**

```bash
git add extension/package.json extension/package-lock.json extension/tsconfig.json extension/src/sidepanel/DownloadPdf.tsx extension/src/sidepanel/Results.tsx extension/src/sidepanel/App.tsx
git commit -m "feat(extension): one-click PDF download, results ordered score-first"
```

---

## Task 4: Wire the cache into the panel

**Files:**
- Modify: `extension/src/sidepanel/App.tsx`, `extension/src/styles.css`

**Interfaces:**
- Consumes: `getCachedRun`, `putCachedRun`, `clearCachedRuns`, `countCachedRuns`, `type CachedRun` from `@/lib/cache` (Task 2); `Results` with props `{ state, company, generatedAt }` from `./Results` (Task 3); `runTailor`, `INITIAL_RUN_STATE`, `type RunState` from `@/lib/run` (unchanged).
- Produces: no new exported surface. This task is behaviour only.

**Coverage note for the task report:** `App.tsx` is a React component and this package has no React test harness, so none of this task's behaviour is unit-tested. The cache module underneath it is (Task 2). Say both plainly in the report.

- [ ] **Step 1: Add the style for the clear-cache control**

Append to `extension/src/styles.css`:

```css
.textbtn {
  align-self: center;
  background: none;
  border: 0;
  padding: 0;
  color: var(--muted);
  font-size: 11px;
  text-decoration: underline;
}
```

- [ ] **Step 2: Add the cache imports to `App.tsx`**

After the existing `import { hasBroadHostAccess, requestBroadHostAccess } from "@/lib/permissions";` line, add:

```tsx
import {
  clearCachedRuns,
  countCachedRuns,
  getCachedRun,
  putCachedRun,
} from "@/lib/cache";
```

- [ ] **Step 3: Add the two new pieces of state**

Immediately after the existing `const [state, setState] = useState<RunState>(INITIAL_RUN_STATE);` line, add:

```tsx
  // When the currently-displayed result was generated, ISO 8601. Non-null for
  // both a fresh run and a restored one — a result is a result.
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  // Drives the clear control, which stays hidden while there is nothing to
  // clear. Refreshed after every write and after clearing.
  const [cachedCount, setCachedCount] = useState(0);
```

Leave the `busy` state and its long comment block exactly as they are.

- [ ] **Step 4: Load the cache count on mount**

Change the mount effect from:

```tsx
  useEffect(() => {
    void getResume().then(setStored);
  }, []);
```

to:

```tsx
  useEffect(() => {
    void getResume().then(setStored);
    void countCachedRuns().then(setCachedCount);
  }, []);
```

- [ ] **Step 5: Replace the JD-change reset with a cache restore**

This is the defect the whole feature exists to fix. Replace the entire `activeJdUrlRef` effect — the block currently reading:

```tsx
  const activeJdUrlRef = useRef<string | undefined>(jd?.url);
  useEffect(() => {
    activeJdUrlRef.current = jd?.url;
    setState(INITIAL_RUN_STATE);
  }, [jd?.url]);
```

with:

```tsx
  // `jd` is re-read on tab switch/navigation (see useActiveJd), so its `url`
  // is the panel's source of truth for "which posting am I looking at now."
  // Track it in a ref (readable synchronously from the runTailor callback
  // below), keyed on `url` specifically — not the `jd` object, which is a
  // fresh reference on every read even when the posting hasn't changed.
  //
  // This used to reset and stop. That is what destroyed a result the user had
  // just paid for the moment they opened another tab. It now clears the
  // display and then restores whatever this posting already has.
  //
  // It intentionally leaves `busy` alone: switching tabs must clear what's on
  // screen, but must not make the button clickable again while generate() is
  // still running.
  const activeJdUrlRef = useRef<string | undefined>(jd?.url);
  useEffect(() => {
    const url = jd?.url;
    activeJdUrlRef.current = url;
    setState(INITIAL_RUN_STATE);
    setGeneratedAt(null);
    if (!url) return;
    void getCachedRun(url).then((hit) => {
      // chrome.storage reads are async and tab switches are fast, so this can
      // resolve after the user has already moved on. Painting it then would
      // show one posting's result underneath another posting's header.
      if (!hit || activeJdUrlRef.current !== url) return;
      setState({
        phase: "done",
        analysis: hit.analysis,
        tailored: hit.tailored,
        // Not cached: it is a live server-side count, and showing a stale one
        // is worse than showing none. The next run refreshes it.
        remaining: null,
        error: null,
      });
      setGeneratedAt(hit.generatedAt);
    });
  }, [jd?.url]);
```

- [ ] **Step 6: Cache the result from `generate()`**

Replace the whole `generate()` function with:

```tsx
  async function generate() {
    if (!jd || !stored || busy) return;
    // Pin which posting this run is for. If the user switches tabs while a
    // run is in flight, activeJdUrlRef.current moves on; a patch that lands
    // after that point is for a posting the user is no longer looking at,
    // so drop it instead of painting stale results over the new page.
    const forUrl = jd.url;
    setState(INITIAL_RUN_STATE);
    setGeneratedAt(null);
    setBusy(true);
    // Accumulate the run's own result HERE rather than reading it back out of
    // `state` when the run finishes. The line below deliberately drops the
    // final patch from the DISPLAY when the user has switched tabs — so
    // `state` would hold nothing to cache, losing exactly the result this
    // cache exists to preserve, in exactly the case that motivated it.
    let latest: RunState = INITIAL_RUN_STATE;
    try {
      await runTailor(jd, stored.resume, (patch) => {
        latest = { ...latest, ...patch };
        if (activeJdUrlRef.current !== forUrl) return;
        setState((prev) => ({ ...prev, ...patch }));
      });
      if (latest.phase === "done" && latest.analysis && latest.tailored) {
        const finishedAt = new Date().toISOString();
        await putCachedRun(forUrl, {
          analysis: latest.analysis,
          tailored: latest.tailored,
          generatedAt: finishedAt,
        });
        setCachedCount(await countCachedRuns());
        // Only stamp the display if the user is still on this posting.
        if (activeJdUrlRef.current === forUrl) setGeneratedAt(finishedAt);
      }
    } finally {
      setBusy(false);
    }
  }
```

- [ ] **Step 7: Add the clear handler**

After `grantAccess()`, add:

```tsx
  // Clearing wipes what is on screen too: a displayed result is, by this
  // point, also a cached one, so leaving it up would make the control look
  // like it did nothing. Disabled while a run is in flight (see the JSX) so
  // it cannot yank a run's output out from under it mid-flight.
  async function clearCache() {
    await clearCachedRuns();
    setCachedCount(0);
    setState(INITIAL_RUN_STATE);
    setGeneratedAt(null);
  }
```

- [ ] **Step 8: Update the JSX**

Add the clear control directly after `<ResumeBlock stored={stored} onChange={setStored} />`:

```tsx
      {cachedCount > 0 && (
        <button className="textbtn" onClick={() => void clearCache()} disabled={busy}>
          Clear {cachedCount} cached result{cachedCount === 1 ? "" : "s"}
        </button>
      )}
```

Change the primary button's label from:

```tsx
        {busy ? "Working…" : "Tailor my resume"}
```

to:

```tsx
        {busy ? "Working…" : state.tailored ? "Tailor again" : "Tailor my resume"}
```

Change the `<Results />` line from:

```tsx
      <Results state={state} company={jd?.company ?? ""} generatedAt={null} />
```

to:

```tsx
      <Results state={state} company={jd?.company ?? ""} generatedAt={generatedAt} />
```

- [ ] **Step 9: Type-check, test, lint and build**

```bash
npx tsc --noEmit --project extension/tsconfig.json && npm --prefix extension run test && npm --prefix extension run lint && npm --prefix extension run build
```

Expected: type-check clean, 80/80, lint clean, build green.

- [ ] **Step 10: Commit**

```bash
git add extension/src/sidepanel/App.tsx extension/src/styles.css
git commit -m "feat(extension): keep each posting's result across tab switches"
```

---

## Task 5: Privacy page, and changelog

**Why this is not optional and not deferrable:** until Task 4, `/privacy`'s claim that a tailored result is stored only when a signed-in user saves it was true of the user's browser as well as our servers. It no longer is. "Nothing stored unless you save" is the one claim this product can make that its competitors cannot; shipping the cache without the wording change would make it half-true, which is worse than not making it.

**Files:**
- Modify: `src/app/privacy/page.tsx`, `CHANGELOG.md`

**Interfaces:** none — copy only.

- [ ] **Step 1: Qualify the "what we never store" bullet**

In `src/app/privacy/page.tsx`, the third bullet currently reads:

```tsx
        <li>
          Tailored resumes — unless you sign in and click &ldquo;Save this
          version&rdquo;.
        </li>
```

Replace it with:

```tsx
        <li>
          Tailored resumes — unless you sign in and click &ldquo;Save this
          version&rdquo;. The browser extension keeps a copy on your own
          device; see below.
        </li>
```

- [ ] **Step 2: Say what the extension caches**

In the same file, in the "The browser extension" section, insert a new paragraph **after** the paragraph ending `…and is discarded once that request completes.` and **before** the paragraph beginning `The extension reads the job posting…`:

```tsx
      <p className="mt-3 text-sm leading-relaxed text-slate-600">
        The extension also keeps the results it generates — the match analysis
        and the tailored resume — in that same local storage, so returning to a
        job posting shows what it produced there before instead of charging you
        for it again. The most recent 20 are kept. They are never uploaded, and
        the panel has a &ldquo;Clear cached results&rdquo; button that removes
        all of them.
      </p>
```

- [ ] **Step 3: Update the page's date stamp**

Change:

```tsx
      <p className="mt-2 text-sm text-slate-500">Last updated: 2026-08-11</p>
```

to:

```tsx
      <p className="mt-2 text-sm text-slate-500">Last updated: 2026-08-14</p>
```

- [ ] **Step 4: Check the panel's own copy is still accurate**

`extension/src/sidepanel/ResumeBlock.tsx` ends with `Stored in this browser only — never uploaded for storage.` That line is about the resume, it sits inside the resume card, and it remains true. **Leave it unchanged.** Verify by eye that it has not drifted:

```bash
grep -n "never uploaded" extension/src/sidepanel/ResumeBlock.tsx
```

Expected: one line, inside the resume card's footer.

- [ ] **Step 5: Add the changelog entry**

In `CHANGELOG.md`, insert directly after the `---` on line 8 (above the `## 2026-08-12` heading):

```markdown
## 2026-08-14 — Results layout, PDF download, and a per-posting cache

### Added

- **One-click PDF download.** The tailored resume downloads as a PDF from the
  panel, with no extra network request — the layout renders in the browser. The
  module that produces it moved to `shared/resume-pdf.tsx` and is now the single
  source for both the web app and the extension, so the two cannot drift.
- **Generated results survive tab switches and panel closes.** Each run is kept
  in `chrome.storage.local` against the posting's URL. Returning shows it
  immediately, stamped `generated <relative time>`, with the primary button
  reading **Tailor again** so a cached result is never mistaken for a fresh one.
  The 20 most recent are kept; the oldest is evicted after that.
- **Clear cached results**, next to the resume card, and a matching line on
  `/privacy`. The promise that nothing is stored unless you save it remains true
  of our servers; it is no longer true of your own browser, and the page now
  says so.

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
```

- [ ] **Step 6: Build and lint the web app**

```bash
npm run lint && npm run build
```

Expected: lint clean, build green.

- [ ] **Step 7: Read the privacy page rendered**

```bash
npm run dev
```

Open `http://localhost:3000/privacy` and read the extension section end to end. It must be accurate about *this branch's behaviour*, not aspirational. Stop the server when done.

If port 3000 returns 404 HTML for everything, an unrelated project is squatting it — check `lsof -nP -iTCP:3000 -sTCP:LISTEN` before debugging anything else. This has cost two debugging sessions on this repo already.

- [ ] **Step 8: Commit**

```bash
git add src/app/privacy/page.tsx CHANGELOG.md
git commit -m "docs: privacy and changelog for the on-device result cache"
```

---

## Live browser verification

Not a task — no subagent can do this. Run it before merging, and record the outcome.

```bash
npm run dev
```

```bash
npm --prefix extension run build:dev
```

Then load `.claude/worktrees/ext-access/extension/dist` at `chrome://extensions` → **Load unpacked**. The macOS file picker hides dotted directories: press `Cmd+Shift+G` and paste the path, or `Cmd+Shift+.` to reveal them. **Remove any previously-loaded copy of this extension first** — two unpacked builds share the pinned extension ID and Chrome will keep serving the old one.

1. On a job posting, tailor. When the run finishes, the score is on top, **Download PDF resume** directly under it, details below. Click it — a PDF lands in Downloads and opens correctly.
2. Switch to another tab, then back. The result is still there, the timestamp reads `generated just now` (or similar), and the button reads **Tailor again**.
3. Close the side panel entirely, reopen it on the same posting. The result is still there.
4. Open the same posting via a link carrying `?utm_source=test`. It hits the same cached result — no re-run.
5. **Clear N cached results** appears under the resume card, and clearing empties the panel and hides the control.

Also still outstanding from the previous branch, unrelated to this plan but blocking the same merge: "Read this site" on a non-listed site, a Workday posting reading with no click, and a `chrome://` page showing the message with no button.

---

## Self-Review

**Spec coverage** — every section of `2026-08-14-extension-results-and-cache-design.md` maps to a task:

| Spec | Task |
|---|---|
| §2 order: score → download → details | 3, Step 4 |
| §2 download waits for tailor | 3, Step 4 (comment) — and stated in the changelog |
| §2 move to `shared/resume-pdf.tsx` | 1 |
| §2 web app dynamic import re-points | 1, Step 6 |
| §2 extension tsconfig gains the file | 3, Step 2 |
| §2 `@react-pdf/renderer` imported dynamically | 3, Steps 1 + 3, verified in Step 8 |
| §2 `Copy as JSON`, demoted | 3, Step 4 |
| §3 write to `chrome.storage.local` | 2 + 4 |
| §3 restore on return, relative time, **Tailor again** | 4, Steps 5 + 8 |
| §3 **Tailor again** overwrites silently | 2 (`putCachedRun` replaces by key) |
| §3 cap 20, oldest evicted | 2 (`MAX_CACHED_RUNS`, tested) |
| §3 key = URL minus `utm_*`/`ref`/`source`/`trk`/fragment | 2 (`cacheKey`, tested) |
| §3 cache analysis + tailored + timestamp, not JD text | 2 (`CachedRun`) |
| §4 `/privacy` line | 5, Step 2 |
| §4 **Clear cached results** control | 4, Steps 1 + 7 + 8 |
| §5 latency out of scope | recorded under "Known limits" in the changelog, no task |
| §7.1–7.8 success criteria | 7.1–7.6 in Live browser verification; 7.7 in Task 5; 7.8 in Task 1 Step 8 |

No gaps.

**Placeholder scan:** every code step carries the literal code. No "TBD", no "add error handling", no "similar to Task N". The one conditional instruction — Task 3 Step 1's note about Node globals — resolves to *stop and report*, not to an unwritten fix.

**Type consistency:** `CachedRun` is `{ analysis, tailored, generatedAt }` in Task 2's implementation, Task 2's tests, and both call sites in Task 4. `cacheKey`, `getCachedRun`, `putCachedRun`, `clearCachedRuns`, `countCachedRuns`, `MAX_CACHED_RUNS` are spelled identically in Tasks 2 and 4. `relativeTime(iso, now?)` is defined in Task 2 and called with one argument in Task 3. `Results`' props `{ state, company, generatedAt }` are declared in Task 3 Step 4 and supplied in Task 3 Step 6 and again in Task 4 Step 8. `DownloadPdf`'s props `{ resume, company }` match its one call site. `generateResumePdf` / `resumePdfFilename` keep the signatures they have today.

**One ordering note for the implementer of Task 3:** it consumes `relativeTime` from Task 2 and `@shared/resume-pdf` from Task 1. Do not run it before both are committed.
