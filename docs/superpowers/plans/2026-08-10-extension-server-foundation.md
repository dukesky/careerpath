# Extension Server Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the career-path API so a public Chrome extension can call it safely — real bearer-token auth, a tiered per-account quota, shared wire types, and LLM latency/cost instrumentation — without changing any prompt or breaking the existing web app.

**Architecture:** Wire-format types move to a runtime-free `shared/contract.ts` that both the Next app and (later) the extension import. A new `src/lib/auth.ts` resolves every request into a `Caller` discriminated union (`user` / `device` / `anon`), with device identities carried by server-signed JWTs instead of the client-generated `x-anon-id`. `src/lib/quota.ts` is rewritten around `Caller` with per-tier keys, and gains a `runId` idempotency marker so a parallel `analyze` + `tailor` pair costs exactly one unit and only on success. `callLLM` gains a timing/token wrapper writing to logs and a rolling Redis aggregate.

**Tech Stack:** Next.js 15 (App Router), TypeScript (strict), Vitest, `jose` (JWT), Clerk v7, Upstash Redis via the existing `src/lib/kv.ts` abstraction.

**Source spec:** `docs/superpowers/specs/2026-08-10-chrome-extension-v1-design.md`

## Global Constraints

- **No prompt or model-behavior changes.** `buildParseMessages`, `buildJdParseMessages`, `buildAnalyzeMessages`, `buildTailorMessages` and every normalizer keep their current output. The only `llm.ts` model change permitted is the new `parse_jd` task in Task 8.
- **The existing web app must not regress.** Anonymous web users keep `quota:anon:<anonId>`, 5 total, 30-day TTL. The `x-anon-id` header path stays working.
- **Nothing new is persisted server-side.** The only server-persisted data remains: quota counters, rate-limit counters, saved versions (`saved:<userId>`), waitlist emails — plus the new `stats:*` aggregates. Resumes and JD text are never written to storage.
- **Quota allowances (exact):** signed-in `5` per day; extension device trial `3` per rolling 30-day window; legacy web anonymous `5` per rolling 30-day window; per-IP ceiling `20` per day. (The two 30-day tiers follow their keys' TTL — a device that returns after a month gets a fresh trial. That is accepted: the tier already cannot survive a reinstall, and permanent keys would grow without bound.)
- **TTLs (exact):** daily keys `48h` (172800s); device trial and legacy anon `30 days` (2592000s); `runId` marker `10 minutes` (600s); device JWT `24h`.
- **Blocking rule:** a caller is blocked when **either** its tier counter **or** the IP counter is exhausted.
- **Quota is consumed only on success**, exactly once per `runId`.
- **Beta bypass is preserved.** `hasBetaAccess(request)` still skips the business quota (never the rate limit).
- `runtime = "nodejs"` on every API route (unchanged).
- Run `npm run lint` before every commit; it must pass.

---

### Task 1: Test infrastructure

Nothing in this repo is currently testable — there is no test runner. This task installs Vitest, proves it works against existing code, and makes the KV singleton resettable so later tasks can test quota logic in isolation.

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Modify: `src/lib/kv.ts` (add a test-only reset)
- Create: `src/lib/__tests__/kv.test.ts`
- Create: `src/lib/__tests__/limits.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `resetKV(): void` exported from `src/lib/kv.ts` — clears the cached store so the next `getKV()` builds a fresh one. Every later test file calls it in `beforeEach`.

- [ ] **Step 1: Install Vitest**

```bash
npm install -D vitest@^3
```

- [ ] **Step 2: Add the test scripts**

In `package.json`, add to `"scripts"`:

```json
    "test": "vitest run",
    "test:watch": "vitest"
```

- [ ] **Step 3: Create the Vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "shared/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
});
```

The `@shared` alias is unused until Task 2 but is set up here so Task 2 does not have to touch this file.

- [ ] **Step 4: Write the failing tests**

Create `src/lib/__tests__/limits.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { capText, MAX_JD_CHARS } from "@/lib/limits";

describe("capText", () => {
  it("returns short text unchanged", () => {
    expect(capText("hello", 10)).toBe("hello");
  });

  it("truncates text longer than the cap", () => {
    expect(capText("abcdef", 3)).toBe("abc");
  });

  it("caps JD text at MAX_JD_CHARS", () => {
    const long = "x".repeat(MAX_JD_CHARS + 500);
    expect(capText(long, MAX_JD_CHARS)).toHaveLength(MAX_JD_CHARS);
  });
});
```

Create `src/lib/__tests__/kv.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { getKV, resetKV } from "@/lib/kv";

describe("in-memory KV store", () => {
  beforeEach(() => {
    resetKV();
  });

  it("counts up from zero", async () => {
    const kv = getKV();
    expect(await kv.getCount("a")).toBe(0);
    expect(await kv.incr("a", 60)).toBe(1);
    expect(await kv.incr("a", 60)).toBe(2);
    expect(await kv.getCount("a")).toBe(2);
  });

  it("isolates state between tests via resetKV", async () => {
    expect(await getKV().getCount("a")).toBe(0);
  });

  it("stores and deletes hash fields", async () => {
    const kv = getKV();
    await kv.hset("h", "f", "v");
    expect(await kv.hgetall("h")).toEqual({ f: "v" });
    await kv.hdel("h", "f");
    expect(await kv.hgetall("h")).toEqual({});
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npm test`
Expected: `limits.test.ts` passes; `kv.test.ts` FAILS with `"resetKV" is not exported by src/lib/kv.ts`.

- [ ] **Step 6: Add `resetKV` to the KV module**

In `src/lib/kv.ts`, immediately after the existing `getKV()` function, add:

```ts
/**
 * Test-only: drop the cached store so the next getKV() builds a fresh one.
 * Never call this from application code.
 */
export function resetKV(): void {
  store = null;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 6 tests across 2 files.

- [ ] **Step 8: Lint and commit**

```bash
npm run lint
git add package.json package-lock.json vitest.config.ts src/lib/kv.ts src/lib/__tests__/
git commit -m "test: add Vitest and make the KV singleton resettable"
```

---

### Task 2: Extract the shared wire contract

The extension needs the shapes that cross the wire, but must never pull in prompts, normalizers, or server code. This task moves the interfaces into a runtime-free module and re-exports them so no existing import breaks.

**Files:**
- Create: `shared/contract.ts`
- Create: `shared/__tests__/contract.test.ts`
- Modify: `src/lib/resume.ts` (remove interface declarations, re-export from `@shared/contract`)
- Modify: `src/lib/jd.ts` (same)
- Modify: `src/lib/analysis.ts` (same)
- Modify: `tsconfig.json` (add the `@shared/*` path, exclude `extension`)

**Interfaces:**
- Consumes: Task 1's Vitest setup and its `@shared` alias.
- Produces: `shared/contract.ts` exporting exactly these types, with the field names and shapes verbatim from today's `src/lib/*.ts`:
  `Contact`, `ExperienceEntry`, `ProjectEntry`, `EducationEntry`, `ParsedResume`, `ParsedJD`, `ReqStatus`, `ReqKind`, `RequirementRow`, `GapItem`, `GapAnalysis`, `ChangeLogEntry`, `TailorResult`.
  All are still re-exported from their current modules, so `import type { ParsedResume } from "@/lib/resume"` keeps working everywhere (including all components).

- [ ] **Step 1: Write the failing test**

Create `shared/__tests__/contract.test.ts`. This test asserts the runtime normalizers still produce objects matching the contract shape, and that the contract module has no runtime exports.

```ts
import { describe, it, expect } from "vitest";
import { normalizeResume } from "@/lib/resume";
import { normalizeJD } from "@/lib/jd";
import { normalizeGapAnalysis, normalizeTailorResult } from "@/lib/analysis";
import type {
  ParsedResume,
  ParsedJD,
  GapAnalysis,
  TailorResult,
} from "@shared/contract";
import * as contract from "@shared/contract";

describe("shared contract", () => {
  it("exports no runtime values", () => {
    expect(Object.keys(contract)).toHaveLength(0);
  });

  it("normalizeResume produces a ParsedResume", () => {
    const r: ParsedResume = normalizeResume({ summary: "hi" });
    expect(r.summary).toBe("hi");
    expect(r.contact.name).toBe("");
    expect(r.experience).toEqual([]);
    expect(r.skills).toEqual([]);
  });

  it("normalizeJD produces a ParsedJD", () => {
    const j: ParsedJD = normalizeJD({ company: "Acme" });
    expect(j.company).toBe("Acme");
    expect(j.must_have_requirements).toEqual([]);
    expect(j.keywords).toEqual([]);
  });

  it("normalizeGapAnalysis produces a GapAnalysis", () => {
    const a: GapAnalysis = normalizeGapAnalysis({ overall_match_score: 77 });
    expect(a.overall_match_score).toBe(77);
    expect(a.requirements_matrix).toEqual([]);
    expect(a.gaps).toEqual([]);
  });

  it("normalizeTailorResult produces a TailorResult", () => {
    const t: TailorResult = normalizeTailorResult({ projected_match_score: 88 });
    expect(t.projected_match_score).toBe(88);
    expect(t.change_log).toEqual([]);
    expect(t.resume.contact.email).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run shared`
Expected: FAIL — cannot resolve `@shared/contract`.

- [ ] **Step 3: Create the contract module**

Create `shared/contract.ts`. Copy each interface body **verbatim** from its current home — do not rename or reorder fields, and do not add fields.

```ts
/**
 * Wire-format types shared by the Next.js app and the Chrome extension.
 *
 * TYPES ONLY — this module must never gain a runtime export. The extension
 * imports it with `import type`, so anything with a runtime value here would
 * silently end up in the extension bundle.
 *
 * Prompts, normalizers, and model routing stay in src/lib/.
 */

// --- Resume (source of truth was src/lib/resume.ts) -----------------------

export interface Contact {
  name: string;
  email: string;
  phone: string;
  location: string;
  links: string[];
}

export interface ExperienceEntry {
  company: string;
  title: string;
  dates: string;
  bullets: string[];
}

export interface ProjectEntry {
  name: string;
  description: string;
  bullets: string[];
}

export interface EducationEntry {
  school: string;
  degree: string;
  dates: string;
}

export interface ParsedResume {
  contact: Contact;
  summary: string;
  experience: ExperienceEntry[];
  projects: ProjectEntry[];
  skills: string[];
  education: EducationEntry[];
}

// --- Job description (source of truth was src/lib/jd.ts) ------------------

export interface ParsedJD {
  company: string;
  role_title: string;
  must_have_requirements: string[];
  nice_to_have: string[];
  key_responsibilities: string[];
  keywords: string[];
  seniority_level: string;
  company_context_hints: string;
}

// --- Analysis & tailoring (source of truth was src/lib/analysis.ts) -------

export type ReqStatus = "met" | "partially_met" | "missing";
export type ReqKind = "must_have" | "nice_to_have";

export interface RequirementRow {
  requirement: string;
  kind: ReqKind;
  status: ReqStatus;
  evidence: string;
  suggestion: string;
}

export interface GapItem {
  gap: string;
  mitigation: string;
}

export interface GapAnalysis {
  overall_match_score: number; // 0-100
  rationale: string;
  requirements_matrix: RequirementRow[];
  strengths: string[];
  gaps: GapItem[];
}

export interface ChangeLogEntry {
  section: string;
  original: string;
  revised: string;
  reason: string;
}

export interface TailorResult {
  resume: ParsedResume;
  change_log: ChangeLogEntry[];
  /** The tailor model's estimate of how well the REWRITTEN resume now matches. */
  projected_match_score: number;
}
```

- [ ] **Step 4: Point tsconfig at `shared/` and exclude `extension/`**

In `tsconfig.json`, replace the `"paths"` block and the `"exclude"` block:

```json
    "paths": {
      "@/*": [
        "./src/*"
      ],
      "@shared/*": [
        "./shared/*"
      ]
    }
```

```json
  "exclude": [
    "node_modules",
    "extension"
  ]
```

`extension/` does not exist yet. Excluding it now means Plan B can add it without the Next.js build trying to typecheck Chrome-extension code against this config.

- [ ] **Step 5: Replace the interface declarations in `src/lib/resume.ts`**

Delete the `Contact`, `ExperienceEntry`, `ProjectEntry`, `EducationEntry`, and `ParsedResume` interface declarations (the block under the `Structured resume shape` header, above `EMPTY_RESUME`). Replace them with:

```ts
export type {
  Contact,
  ExperienceEntry,
  ProjectEntry,
  EducationEntry,
  ParsedResume,
} from "@shared/contract";

import type { ParsedResume } from "@shared/contract";
```

Keep `EMPTY_RESUME` and every normalizer exactly as they are. `export type` (not plain `export`) is required — the repo has `isolatedModules: true`.

- [ ] **Step 6: Replace the interface declaration in `src/lib/jd.ts`**

Delete the `ParsedJD` interface declaration and replace it with:

```ts
export type { ParsedJD } from "@shared/contract";

import type { ParsedJD } from "@shared/contract";
```

Keep `EMPTY_JD`, `normalizeJD`, and both prompt builders unchanged.

- [ ] **Step 7: Replace the interface declarations in `src/lib/analysis.ts`**

Delete the `ReqStatus`, `ReqKind`, `RequirementRow`, `GapItem`, `GapAnalysis`, `ChangeLogEntry`, and `TailorResult` declarations and replace them with:

```ts
export type {
  ReqStatus,
  ReqKind,
  RequirementRow,
  GapItem,
  GapAnalysis,
  ChangeLogEntry,
  TailorResult,
} from "@shared/contract";

import type {
  ReqStatus,
  ReqKind,
  GapAnalysis,
  TailorResult,
} from "@shared/contract";
```

Note the asymmetry: all seven types are **re-exported**, but only the four
referenced directly inside `analysis.ts` are **imported**. `RequirementRow`,
`GapItem`, and `ChangeLogEntry` appear in this file only as nested fields of
`GapAnalysis` / `TailorResult`, whose definitions now live in
`shared/contract.ts` — importing them locally would produce
`no-unused-vars` warnings for no benefit. `resume.ts` and `jd.ts` follow the
same rule.

Leave the existing `import { normalizeResume, type ParsedResume } from "./resume";` line and every normalizer and prompt builder untouched.

- [ ] **Step 8: Run the tests and the build**

Run: `npm test`
Expected: PASS — 5 new tests in `shared/__tests__/contract.test.ts`, plus Task 1's 6.

Run: `npm run build`
Expected: compiles with no type errors. This is the real check — it proves every component still resolves `ParsedResume` and friends through the re-exports.

- [ ] **Step 9: Lint and commit**

```bash
npm run lint
git add shared/ tsconfig.json src/lib/resume.ts src/lib/jd.ts src/lib/analysis.ts
git commit -m "refactor: move wire types to shared/contract.ts"
```

---

### Task 3: LLM call instrumentation

Model selection is an explicit ongoing goal, and it needs data. This task adds a timing/token wrapper around every `callLLM` completion.

**Files:**
- Create: `src/lib/llm-stats.ts`
- Create: `src/lib/__tests__/llm-stats.test.ts`
- Modify: `src/lib/llm.ts`

**Interfaces:**
- Consumes: `getKV()` and `resetKV()` from Task 1.
- Produces:
  - `interface LLMCallStats { task: string; model: string; quality?: string; durationMs: number; promptTokens: number; completionTokens: number; ok: boolean }`
  - `recordLLMCall(stats: LLMCallStats): Promise<void>`
  - `withStats<T>(meta: {task: string; model: string; quality?: string}, fn: () => Promise<{result: T; promptTokens: number; completionTokens: number}>): Promise<T>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/llm-stats.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { getKV, resetKV } from "@/lib/kv";
import { recordLLMCall, withStats } from "@/lib/llm-stats";

describe("recordLLMCall", () => {
  beforeEach(() => {
    resetKV();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("increments the per-task/model counters", async () => {
    await recordLLMCall({
      task: "analyze",
      model: "m1",
      durationMs: 1200,
      promptTokens: 100,
      completionTokens: 50,
      ok: true,
    });
    const kv = getKV();
    const keys = await kv.hgetall("stats:analyze:m1");
    expect(Number(keys.calls)).toBe(1);
    expect(Number(keys.totalMs)).toBe(1200);
    expect(Number(keys.promptTokens)).toBe(100);
    expect(Number(keys.completionTokens)).toBe(50);
    expect(Number(keys.failures)).toBe(0);
  });

  it("accumulates across calls and counts failures separately", async () => {
    const base = { task: "tailor", model: "m2", promptTokens: 10, completionTokens: 5 };
    await recordLLMCall({ ...base, durationMs: 100, ok: true });
    await recordLLMCall({ ...base, durationMs: 300, ok: false });
    const keys = await getKV().hgetall("stats:tailor:m2");
    expect(Number(keys.calls)).toBe(2);
    expect(Number(keys.totalMs)).toBe(400);
    expect(Number(keys.failures)).toBe(1);
  });

  it("emits one structured log line per call", async () => {
    const spy = vi.spyOn(console, "log");
    await recordLLMCall({
      task: "parse",
      model: "m3",
      durationMs: 42,
      promptTokens: 1,
      completionTokens: 2,
      ok: true,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(spy.mock.calls[0][0] as string);
    expect(payload).toMatchObject({ evt: "llm_call", task: "parse", model: "m3", ok: true });
  });

  it("never throws when the store fails", async () => {
    vi.spyOn(getKV(), "hset").mockRejectedValue(new Error("redis down"));
    await expect(
      recordLLMCall({
        task: "parse",
        model: "m4",
        durationMs: 1,
        promptTokens: 0,
        completionTokens: 0,
        ok: true,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("withStats", () => {
  beforeEach(() => {
    resetKV();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the inner result and records a successful call", async () => {
    const out = await withStats({ task: "analyze", model: "m5" }, async () => ({
      result: "hello",
      promptTokens: 7,
      completionTokens: 3,
    }));
    expect(out).toBe("hello");
    const keys = await getKV().hgetall("stats:analyze:m5");
    expect(Number(keys.calls)).toBe(1);
    expect(Number(keys.failures)).toBe(0);
  });

  it("records a failure and rethrows", async () => {
    await expect(
      withStats({ task: "analyze", model: "m6" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const keys = await getKV().hgetall("stats:analyze:m6");
    expect(Number(keys.calls)).toBe(1);
    expect(Number(keys.failures)).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/llm-stats.test.ts`
Expected: FAIL — cannot resolve `@/lib/llm-stats`.

- [ ] **Step 3: Implement the stats module**

Create `src/lib/llm-stats.ts`:

```ts
import { getKV } from "./kv";

/**
 * LLM call instrumentation — the data behind "which model is fast enough".
 *
 * Two cheap channels: one structured log line per call (queryable in Vercel
 * logs) and a rolling Redis aggregate per task+model. Recording must never
 * break a user-facing request, so every failure here is swallowed.
 */

export interface LLMCallStats {
  task: string;
  model: string;
  quality?: string;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  ok: boolean;
}

const statsKey = (task: string, model: string) => `stats:${task}:${model}`;

export async function recordLLMCall(stats: LLMCallStats): Promise<void> {
  console.log(
    JSON.stringify({
      evt: "llm_call",
      task: stats.task,
      model: stats.model,
      quality: stats.quality ?? null,
      durationMs: stats.durationMs,
      promptTokens: stats.promptTokens,
      completionTokens: stats.completionTokens,
      ok: stats.ok,
    }),
  );

  // Read every field once, then write them concurrently. This sits in the hot
  // path of every LLM call, so it must cost two round-trip layers, not ten:
  // KVStore has no atomic hash-increment, and awaiting five sequential
  // read-modify-write pairs would add real latency to every request.
  //
  // Still read-modify-write, so concurrent calls can lose an increment. That
  // is deliberate: these are trend aggregates for model comparison, not
  // billing. The per-call console.log above is the exact record.
  //
  // No TTL: the key space is bounded by the number of (task, model) pairs —
  // a dozen keys, not one per user — so these never need to expire.
  try {
    const kv = getKV();
    const key = statsKey(stats.task, stats.model);
    const current = await kv.hgetall(key);
    const next = (field: string, by: number) =>
      String(Number(current[field] ?? 0) + by);

    await Promise.all([
      kv.hset(key, "calls", next("calls", 1)),
      kv.hset(key, "totalMs", next("totalMs", stats.durationMs)),
      kv.hset(key, "promptTokens", next("promptTokens", stats.promptTokens)),
      kv.hset(
        key,
        "completionTokens",
        next("completionTokens", stats.completionTokens),
      ),
      kv.hset(key, "failures", next("failures", stats.ok ? 0 : 1)),
    ]);
  } catch {
    // Never let instrumentation break a user request.
  }
}

/**
 * Time `fn`, record the outcome, and return its result. Records a failure and
 * rethrows if `fn` throws.
 */
export async function withStats<T>(
  meta: { task: string; model: string; quality?: string },
  fn: () => Promise<{ result: T; promptTokens: number; completionTokens: number }>,
): Promise<T> {
  const started = Date.now();
  try {
    const { result, promptTokens, completionTokens } = await fn();
    await recordLLMCall({
      ...meta,
      durationMs: Date.now() - started,
      promptTokens,
      completionTokens,
      ok: true,
    });
    return result;
  } catch (err) {
    await recordLLMCall({
      ...meta,
      durationMs: Date.now() - started,
      promptTokens: 0,
      completionTokens: 0,
      ok: false,
    });
    throw err;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/__tests__/llm-stats.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Wrap the completion call in `llm.ts`**

In `src/lib/llm.ts`, add the import at the top:

```ts
import { withStats } from "./llm-stats";
```

Then replace the body of the inner `complete` function inside `callLLM`. It currently reads:

```ts
  async function complete(
    msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  ): Promise<string> {
    const res = await getClient().chat.completions.create({
      model,
      messages: msgs,
      temperature: temp,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    });
    return res.choices[0]?.message?.content?.trim() ?? "";
  }
```

Replace it with:

```ts
  async function complete(
    msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  ): Promise<string> {
    return withStats({ task, model, quality }, async () => {
      const res = await getClient().chat.completions.create({
        model,
        messages: msgs,
        temperature: temp,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
      });
      return {
        result: res.choices[0]?.message?.content?.trim() ?? "",
        promptTokens: res.usage?.prompt_tokens ?? 0,
        completionTokens: res.usage?.completion_tokens ?? 0,
      };
    });
  }
```

Nothing else in `llm.ts` changes. Note that the JSON-retry path calls `complete` a second time, which correctly records as two calls — that is the intended signal, since a retry is real extra cost.

- [ ] **Step 6: Verify the build and the full suite**

Run: `npm test && npm run build`
Expected: all tests PASS, build succeeds.

- [ ] **Step 7: Lint and commit**

```bash
npm run lint
git add src/lib/llm-stats.ts src/lib/llm.ts src/lib/__tests__/llm-stats.test.ts
git commit -m "feat: instrument LLM calls with timing and token counts"
```

---

### Task 4: Device tokens and caller resolution

The extension ships as public, unpackable code, so a client-generated id is not an identity. This task adds server-signed device JWTs and a single function that turns any request into a `Caller`.

**Files:**
- Create: `src/lib/auth.ts`
- Create: `src/lib/__tests__/auth.test.ts`
- Create: `src/app/api/device-token/route.ts`
- Modify: `src/lib/rate-limit.ts` (add a scoped bucket for identity minting)
- Modify: `src/lib/identity.ts` (export the anon-id cap so it has one definition)
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type Caller = { kind: "user"; userId: string } | { kind: "device"; deviceId: string } | { kind: "anon"; anonId: string }`
  - `type CallerResult = { ok: true; caller: Caller } | { ok: false; reason: "invalid_token" }`
  - `issueDeviceToken(): Promise<{ token: string; deviceId: string }>`
  - `verifyDeviceToken(token: string): Promise<string | null>` — returns the device id, or `null` when the token is missing, expired, tampered with, or signed with a different secret.
  - `resolveCaller(request: Request, clerkUserId: string | null): Promise<CallerResult>`
  - `callerKey(caller: Caller): string` — a stable string used to namespace quota keys.
  Task 5 and Task 6 consume all of these.

**Why `CallerResult` and not just `Caller`:** a request with *no* `Authorization`
header is the normal web-app case and must resolve to the anon tier. A request
carrying a bearer token that fails verification is a different situation — it is
the extension with an expired token, and it needs a `401` so its background
worker knows to refresh. Silently degrading it to anon would both mis-bill it
(anon tier keyed on an empty id) and leave the extension permanently unable to
discover that its token died.

- [ ] **Step 1: Install `jose`**

```bash
npm install jose@^6
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/__tests__/auth.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { decodeJwt } from "jose";
import {
  issueDeviceToken,
  verifyDeviceToken,
  resolveCaller,
  callerKey,
} from "@/lib/auth";

function req(headers: Record<string, string>): Request {
  return new Request("https://example.com/api/tailor", { headers });
}

// Vitest reuses worker processes across files, so an env var set here would
// otherwise leak into whichever file runs next in the same worker.
afterEach(() => {
  delete process.env.DEVICE_TOKEN_SECRET;
});

describe("device tokens", () => {
  beforeEach(() => {
    process.env.DEVICE_TOKEN_SECRET = "test-secret-value-at-least-32-chars-long";
  });

  it("round-trips a signed token back to its device id", async () => {
    const { token, deviceId } = await issueDeviceToken();
    expect(deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await verifyDeviceToken(token)).toBe(deviceId);
  });

  it("issues a distinct device id each time", async () => {
    const a = await issueDeviceToken();
    const b = await issueDeviceToken();
    expect(a.deviceId).not.toBe(b.deviceId);
  });

  it("rejects a tampered token", async () => {
    const { token } = await issueDeviceToken();
    const tampered = token.slice(0, -3) + "aaa";
    expect(await verifyDeviceToken(tampered)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const { token } = await issueDeviceToken();
    process.env.DEVICE_TOKEN_SECRET = "a-completely-different-secret-value-32ch";
    expect(await verifyDeviceToken(token)).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(await verifyDeviceToken("not-a-jwt")).toBeNull();
    expect(await verifyDeviceToken("")).toBeNull();
  });

  // The plan pins this TTL as an exact value, so assert it rather than
  // trusting the constant. Without this, changing "24h" to "240h" keeps the
  // suite green.
  it("issues a token that expires in exactly 24 hours", async () => {
    const { token } = await issueDeviceToken();
    const { iat, exp } = decodeJwt(token);
    expect(exp! - iat!).toBe(24 * 60 * 60);
  });

  // The most security-relevant invariant in this module: an absent secret
  // must fail loudly, never fall back to a guessable default. Every other
  // test sets the secret in beforeEach, so nothing else would catch a
  // `?? "dev-secret"` creeping into secret().
  it("refuses to sign without a secret", async () => {
    delete process.env.DEVICE_TOKEN_SECRET;
    await expect(issueDeviceToken()).rejects.toThrow(/DEVICE_TOKEN_SECRET/);
  });
});

describe("resolveCaller", () => {
  beforeEach(() => {
    process.env.DEVICE_TOKEN_SECRET = "test-secret-value-at-least-32-chars-long";
  });

  it("prefers a signed-in Clerk user over everything else", async () => {
    const { token } = await issueDeviceToken();
    const r = await resolveCaller(
      req({ authorization: `Bearer ${token}`, "x-anon-id": "abc" }),
      "user_123",
    );
    expect(r).toEqual({ ok: true, caller: { kind: "user", userId: "user_123" } });
  });

  it("falls back to a valid device token", async () => {
    const { token, deviceId } = await issueDeviceToken();
    const r = await resolveCaller(req({ authorization: `Bearer ${token}` }), null);
    expect(r).toEqual({ ok: true, caller: { kind: "device", deviceId } });
  });

  it("falls back to the legacy x-anon-id header when no token is present", async () => {
    const r = await resolveCaller(req({ "x-anon-id": "legacy-web-id" }), null);
    expect(r).toEqual({ ok: true, caller: { kind: "anon", anonId: "legacy-web-id" } });
  });

  it("REJECTS a present-but-invalid bearer token instead of degrading to anon", async () => {
    const r = await resolveCaller(
      req({ authorization: "Bearer garbage", "x-anon-id": "legacy-web-id" }),
      null,
    );
    expect(r).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("rejects a structurally invalid token even without an anon header", async () => {
    const r = await resolveCaller(req({ authorization: "Bearer a.b.c" }), null);
    expect(r).toEqual({ ok: false, reason: "invalid_token" });
  });

  // A header that is present but unusable is the extension misbehaving, not a
  // web visitor. It must get the 401 signal, not anon quota.
  it("rejects a non-Bearer scheme rather than degrading to anon", async () => {
    const r = await resolveCaller(
      req({ authorization: "Basic abc", "x-anon-id": "legacy-web-id" }),
      null,
    );
    expect(r).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("rejects a Bearer scheme with an empty token", async () => {
    const r = await resolveCaller(req({ authorization: "Bearer" }), null);
    expect(r).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("accepts a lowercase bearer scheme without corrupting the token", async () => {
    const { token, deviceId } = await issueDeviceToken();
    const r = await resolveCaller(req({ authorization: `bearer ${token}` }), null);
    expect(r).toEqual({ ok: true, caller: { kind: "device", deviceId } });
  });

  it("still prefers a signed-in user even when the bearer token is invalid", async () => {
    const r = await resolveCaller(
      req({ authorization: "Bearer garbage" }),
      "user_123",
    );
    expect(r).toEqual({ ok: true, caller: { kind: "user", userId: "user_123" } });
  });

  it("returns an empty anon caller when nothing identifies the request", async () => {
    expect(await resolveCaller(req({}), null)).toEqual({
      ok: true,
      caller: { kind: "anon", anonId: "" },
    });
  });

  it("caps an absurdly long anon id", async () => {
    const r = await resolveCaller(req({ "x-anon-id": "z".repeat(500) }), null);
    expect(r).toEqual({ ok: true, caller: { kind: "anon", anonId: "z".repeat(100) } });
  });
});

describe("callerKey", () => {
  it("namespaces each caller kind distinctly", () => {
    expect(callerKey({ kind: "user", userId: "u1" })).toBe("user:u1");
    expect(callerKey({ kind: "device", deviceId: "d1" })).toBe("device:d1");
    expect(callerKey({ kind: "anon", anonId: "a1" })).toBe("anon:a1");
    expect(callerKey({ kind: "anon", anonId: "" })).toBe("anon:none");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/auth.test.ts`
Expected: FAIL — cannot resolve `@/lib/auth`.

- [ ] **Step 4: Implement the auth module**

Create `src/lib/auth.ts`:

```ts
import { SignJWT, jwtVerify } from "jose";
// The anon header name and its length cap have exactly one definition, in
// identity.ts. Two copies of the rule that derives a live user's quota key
// would silently split their quota bucket the day the copies drift.
import { ANON_HEADER, MAX_ANON_ID_CHARS } from "./identity";

/**
 * Caller identity for quota purposes.
 *
 * - "user"   — signed in via Clerk (web or extension)
 * - "device" — extension, signed out; the device id is SERVER-issued and
 *              carried in a signed JWT, because extension code is public and
 *              a client-generated id (see anon.ts) resets by editing a string
 * - "anon"   — legacy web path, still keyed on the x-anon-id header
 */
export type Caller =
  | { kind: "user"; userId: string }
  | { kind: "device"; deviceId: string }
  | { kind: "anon"; anonId: string };

/**
 * No Authorization header is normal (the web app). A bearer token that fails
 * verification is NOT — it is an extension whose token expired, and it needs a
 * 401 so it knows to refresh rather than silently spending anon quota.
 */
export type CallerResult =
  | { ok: true; caller: Caller }
  | { ok: false; reason: "invalid_token" };

const DEVICE_TOKEN_TTL = "24h";

function secret(): Uint8Array {
  const value = process.env.DEVICE_TOKEN_SECRET;
  if (!value) {
    throw new Error(
      "DEVICE_TOKEN_SECRET is not set. Add it to .env.local (see .env.example).",
    );
  }
  return new TextEncoder().encode(value);
}

/** Mint a fresh device identity plus the signed token that carries it. */
export async function issueDeviceToken(): Promise<{
  token: string;
  deviceId: string;
}> {
  const deviceId = crypto.randomUUID();
  const token = await new SignJWT({ did: deviceId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(DEVICE_TOKEN_TTL)
    .sign(secret());
  return { token, deviceId };
}

/** Returns the device id, or null for any invalid/expired/forged token. */
export async function verifyDeviceToken(token: string): Promise<string | null> {
  if (!token) return null;
  try {
    // Pin the algorithm. A Uint8Array key already restricts jose to the HS
    // family, but stating it makes the intent explicit rather than an
    // emergent property of the key type.
    const { payload } = await jwtVerify(token, secret(), {
      algorithms: ["HS256"],
    });
    const did = payload.did;
    return typeof did === "string" && did.length > 0 ? did : null;
  } catch {
    return null;
  }
}

/**
 * Three distinct outcomes, and the difference matters:
 *   null — no Authorization header at all (the web app) → fall through to anon
 *   ""   — header present but unusable (wrong scheme, empty token) → reject
 *   else — the token to verify
 *
 * Note the case handling: the scheme test lowercases, but the token is sliced
 * from the original string. Lowercasing the token would corrupt base64url and
 * turn every valid extension request into an invalid one.
 */
function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return "";
  return trimmed.slice(7).trim();
}

/**
 * Resolve a request into a Caller. `clerkUserId` is passed in (rather than
 * read here) so this stays a pure, testable function; routes obtain it with
 * `const { userId } = await auth()`.
 *
 * Precedence: signed-in user > valid device token > legacy anon header.
 * A bearer token that is present but fails verification short-circuits to a
 * rejection — see the CallerResult doc comment.
 */
export async function resolveCaller(
  request: Request,
  clerkUserId: string | null,
): Promise<CallerResult> {
  if (clerkUserId) {
    return { ok: true, caller: { kind: "user", userId: clerkUserId } };
  }

  const token = bearer(request);
  if (token !== null) {
    // An Authorization header was sent. It is either good or it is a 401 —
    // never a silent downgrade to anon, or the extension can't learn its
    // token died.
    if (!token) return { ok: false, reason: "invalid_token" };
    const deviceId = await verifyDeviceToken(token);
    if (!deviceId) return { ok: false, reason: "invalid_token" };
    return { ok: true, caller: { kind: "device", deviceId } };
  }

  const anonId = (request.headers.get(ANON_HEADER) ?? "")
    .trim()
    .slice(0, MAX_ANON_ID_CHARS);
  return { ok: true, caller: { kind: "anon", anonId } };
}

/** Stable namespace for quota keys. */
export function callerKey(caller: Caller): string {
  switch (caller.kind) {
    case "user":
      return `user:${caller.userId}`;
    case "device":
      return `device:${caller.deviceId}`;
    case "anon":
      return `anon:${caller.anonId || "none"}`;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/__tests__/auth.test.ts`
Expected: PASS — 14 tests.

- [ ] **Step 5b: Give identity minting its own rate-limit bucket**

`rateLimitResponse` currently hardcodes one shared bucket (`ratelimit:<ip>`, 30
requests / 60s). Identity minting needs its own, so refresh traffic never
competes with tailoring requests. In `src/lib/rate-limit.ts`, add above
`checkRateLimit`:

```ts
export interface RateLimitScope {
  /** Key namespace. Omitted = the shared request bucket. */
  scope?: string;
  max?: number;
  windowSeconds?: number;
}

/**
 * Identity minting: a device token lasts 24h, so a healthy client mints two
 * or three a day. Kept deliberately loose enough for many users behind one
 * NAT, and still ~100x tighter than the shared bucket.
 */
export const DEVICE_TOKEN_RATE_LIMIT: RateLimitScope = {
  scope: "devicetoken",
  max: 20,
  windowSeconds: 60 * 60,
};
```

Then thread the option through both functions, defaulting to today's behavior:

```ts
export async function checkRateLimit(
  ip: string,
  opts: RateLimitScope = {},
): Promise<RateLimitResult> {
  const max = opts.max ?? MAX_REQUESTS;
  const windowSeconds = opts.windowSeconds ?? WINDOW_SECONDS;
  if (!ip || ip === "unknown") {
    return { ok: true, remaining: max, retryAfter: 0 };
  }
  const key = opts.scope ? `ratelimit:${opts.scope}:${ip}` : `ratelimit:${ip}`;
  const count = await getKV().incr(key, windowSeconds);
  const remaining = Math.max(0, max - count);
  return {
    ok: count <= max,
    remaining,
    retryAfter: count > max ? windowSeconds : 0,
  };
}

export async function rateLimitResponse(
  ip: string,
  opts: RateLimitScope = {},
): Promise<Response | null> {
  const result = await checkRateLimit(ip, opts);
  if (result.ok) return null;
  return NextResponse.json(
    { error: "Too many requests. Please slow down and try again shortly." },
    { status: 429, headers: { "Retry-After": String(result.retryAfter) } },
  );
}
```

Every existing call site passes no options and keeps its current behavior
exactly — verify that by leaving them untouched.

- [ ] **Step 6: Add the token-issuing route**

Create `src/app/api/device-token/route.ts`:

```ts
import { NextResponse } from "next/server";
import { issueDeviceToken } from "@/lib/auth";
import { getIdentity } from "@/lib/identity";
import { rateLimitResponse, DEVICE_TOKEN_RATE_LIMIT } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Mint a device identity for the extension. Called once on install and again
 * whenever the stored token nears expiry.
 *
 * Minting draws on its OWN tight per-IP bucket rather than the shared request
 * budget, for two reasons. It keeps token refresh from competing with real
 * work — a user mid-session must never be refused a refresh because they were
 * busy tailoring — and it stops one IP from minting identities at the shared
 * bucket's rate. Note what this does and does not buy: a fresh device id
 * carries a fresh trial allowance, but `quota:ip:<ip>:<day>` still caps what
 * any one IP can actually spend, so minting alone never yields unlimited runs.
 * The device token's real job is to make quota reset cost more than editing a
 * string in local storage.
 */
export async function POST(request: Request) {
  const { ip } = getIdentity(request);
  const limited = await rateLimitResponse(ip, DEVICE_TOKEN_RATE_LIMIT);
  if (limited) return limited;

  try {
    const { token } = await issueDeviceToken();
    return NextResponse.json({ token });
  } catch {
    return NextResponse.json(
      { error: "Device tokens are not configured." },
      { status: 503 },
    );
  }
}
```

The response deliberately returns only the token — the device id is inside it and the client has no reason to read it.

- [ ] **Step 7: Document the new env var**

Add to `.env.example`, following the style of the surrounding entries:

```
# Secret used to sign Chrome-extension device tokens (HS256). Server-side only.
# Generate one with: openssl rand -base64 32
DEVICE_TOKEN_SECRET=
```

- [ ] **Step 8: Verify the build and full suite**

Run: `npm test && npm run build`
Expected: all PASS.

- [ ] **Step 9: Lint and commit**

```bash
npm run lint
git add package.json package-lock.json src/lib/auth.ts src/lib/__tests__/auth.test.ts src/app/api/device-token/route.ts .env.example
git commit -m "feat: server-signed device tokens and caller resolution"
```

---

### Task 5: Tiered quota with run idempotency

Rewrite `quota.ts` around `Caller`. This is where the "one run costs one unit, only on success, even when analyze and tailor race" rule lives.

**Files:**
- Modify: `src/lib/quota.ts` (full rewrite)
- Create: `src/lib/__tests__/quota.test.ts`

**Interfaces:**
- Consumes: `Caller`, `callerKey` (Task 4); `getKV`, `resetKV` (Task 1).
- Produces:
  - `interface QuotaState { limit: number; used: number; remaining: number; exhausted: boolean }`
  - `getQuota(caller: Caller, ip: string): Promise<QuotaState>`
  - `consumeRun(caller: Caller, ip: string, runId: string): Promise<QuotaState>`
  - Exported constants `DAILY_USER_LIMIT = 5`, `DEVICE_TRIAL_LIMIT = 3`, `LEGACY_ANON_LIMIT = 5`, `DAILY_IP_LIMIT = 20`.
  Task 6 consumes `getQuota` and `consumeRun`; Task 8 consumes `getQuota`.
- **Removed:** the old `FREE_TAILOR_LIMIT` export and the old `getQuota(identity)` / `consumeQuota(identity)` signatures. Task 6 and Task 8 update every call site; no other file imports them (verify with `grep -rn 'from "@/lib/quota"' src` — only `api/quota/route.ts` and `api/tailor/route.ts` should appear).

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/quota.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { resetKV } from "@/lib/kv";
import {
  getQuota,
  consumeRun,
  DAILY_USER_LIMIT,
  DEVICE_TRIAL_LIMIT,
  LEGACY_ANON_LIMIT,
  DAILY_IP_LIMIT,
} from "@/lib/quota";
import type { Caller } from "@/lib/auth";

const user: Caller = { kind: "user", userId: "u1" };
const device: Caller = { kind: "device", deviceId: "d1" };
const anon: Caller = { kind: "anon", anonId: "a1" };
const IP = "1.2.3.4";

let run = 0;
const nextRun = () => `run-${run++}`;

describe("quota tiers", () => {
  beforeEach(() => {
    resetKV();
    run = 0;
  });

  it("gives a signed-in user the daily allowance", async () => {
    const q = await getQuota(user, IP);
    expect(q.limit).toBe(DAILY_USER_LIMIT);
    expect(q.remaining).toBe(DAILY_USER_LIMIT);
    expect(q.exhausted).toBe(false);
  });

  it("exhausts a signed-in user after the daily allowance", async () => {
    for (let i = 0; i < DAILY_USER_LIMIT; i++) {
      await consumeRun(user, IP, nextRun());
    }
    const q = await getQuota(user, IP);
    expect(q.used).toBe(DAILY_USER_LIMIT);
    expect(q.remaining).toBe(0);
    expect(q.exhausted).toBe(true);
  });

  it("gives an extension device the smaller trial allowance", async () => {
    expect((await getQuota(device, IP)).limit).toBe(DEVICE_TRIAL_LIMIT);
    for (let i = 0; i < DEVICE_TRIAL_LIMIT; i++) {
      await consumeRun(device, IP, nextRun());
    }
    expect((await getQuota(device, IP)).exhausted).toBe(true);
  });

  it("keeps the legacy web anonymous allowance unchanged", async () => {
    expect((await getQuota(anon, IP)).limit).toBe(LEGACY_ANON_LIMIT);
  });

  it("keeps tiers independent of one another", async () => {
    for (let i = 0; i < DEVICE_TRIAL_LIMIT; i++) {
      await consumeRun(device, IP, nextRun());
    }
    expect((await getQuota(device, IP)).exhausted).toBe(true);
    // Signing in grants a fresh daily allowance — no carry-over.
    expect((await getQuota(user, IP)).remaining).toBe(DAILY_USER_LIMIT);
  });

  it("blocks on the IP ceiling even when the tier has room", async () => {
    for (let i = 0; i < DAILY_IP_LIMIT; i++) {
      await consumeRun({ kind: "user", userId: `u${i}` }, IP, nextRun());
    }
    const q = await getQuota({ kind: "user", userId: "fresh" }, IP);
    expect(q.exhausted).toBe(true);
    expect(q.remaining).toBe(0);
  });

  it("does not apply the IP ceiling to an unknown IP", async () => {
    for (let i = 0; i < DAILY_IP_LIMIT + 5; i++) {
      await consumeRun({ kind: "user", userId: `u${i}` }, "unknown", nextRun());
    }
    expect((await getQuota({ kind: "user", userId: "fresh" }, "unknown")).exhausted).toBe(
      false,
    );
  });
});

describe("run idempotency", () => {
  beforeEach(() => {
    resetKV();
    run = 0;
  });

  it("charges one unit for repeated calls with the same runId", async () => {
    await consumeRun(user, IP, "same-run");
    await consumeRun(user, IP, "same-run");
    await consumeRun(user, IP, "same-run");
    expect((await getQuota(user, IP)).used).toBe(1);
  });

  it("charges one unit when analyze and tailor finish in parallel", async () => {
    await Promise.all([
      consumeRun(user, IP, "parallel-run"),
      consumeRun(user, IP, "parallel-run"),
    ]);
    expect((await getQuota(user, IP)).used).toBe(1);
  });

  it("charges separately for distinct runIds", async () => {
    await consumeRun(user, IP, "run-a");
    await consumeRun(user, IP, "run-b");
    expect((await getQuota(user, IP)).used).toBe(2);
  });

  it("scopes the run marker per caller", async () => {
    await consumeRun(user, IP, "shared-id");
    await consumeRun({ kind: "user", userId: "u2" }, IP, "shared-id");
    expect((await getQuota(user, IP)).used).toBe(1);
    expect((await getQuota({ kind: "user", userId: "u2" }, IP)).used).toBe(1);
  });

  it("returns the post-consumption state", async () => {
    const q = await consumeRun(user, IP, nextRun());
    expect(q.used).toBe(1);
    expect(q.remaining).toBe(DAILY_USER_LIMIT - 1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/quota.test.ts`
Expected: FAIL — `consumeRun` / `DAILY_USER_LIMIT` are not exported.

- [ ] **Step 3: Rewrite the quota module**

Replace the entire contents of `src/lib/quota.ts`:

```ts
import { getKV } from "./kv";
import { callerKey, type Caller } from "./auth";

/**
 * Business quota (separate from the abuse rate limit in rate-limit.ts).
 *
 * One "run" = one analyze + tailor flow. Both endpoints send the same client-
 * generated runId; the first SUCCESSFUL one charges, the other does not.
 *
 * A caller is blocked when EITHER its tier counter OR the per-IP ceiling is
 * exhausted.
 */

export const DAILY_USER_LIMIT = 5; // signed in, per day
export const DEVICE_TRIAL_LIMIT = 3; // extension, signed out, total
export const LEGACY_ANON_LIMIT = 5; // web, signed out, total — unchanged
export const DAILY_IP_LIMIT = 20; // abuse ceiling, per day

const DAY_TTL_SECONDS = 48 * 60 * 60;
const LONG_TTL_SECONDS = 30 * 24 * 60 * 60;
const RUN_TTL_SECONDS = 10 * 60;

export interface QuotaState {
  limit: number;
  used: number;
  remaining: number;
  exhausted: boolean;
}

/** UTC calendar day, so a "daily" allowance is well-defined server-side. */
function dayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

interface Tier {
  key: string;
  limit: number;
  ttl: number;
}

function tierFor(caller: Caller, ip: string): Tier {
  switch (caller.kind) {
    case "user":
      return {
        key: `quota:user:${caller.userId}:${dayKey()}`,
        limit: DAILY_USER_LIMIT,
        ttl: DAY_TTL_SECONDS,
      };
    case "device":
      return {
        key: `quota:device:${caller.deviceId}`,
        limit: DEVICE_TRIAL_LIMIT,
        ttl: LONG_TTL_SECONDS,
      };
    case "anon":
      // resolveCaller yields anonId: "" whenever the header is absent — a bot,
      // a direct API call, an extension that hasn't minted a token yet. Keying
      // those on `quota:anon:` would put every one of them in a SINGLE global
      // bucket, so five stray requests exhaust it and every header-less caller
      // worldwide reads 0 remaining for the next 30 days. Fall back to the IP,
      // at the same allowance a normal anonymous visitor gets — so omitting
      // the header is never more generous than sending one.
      return {
        key: caller.anonId
          ? `quota:anon:${caller.anonId}`
          : `quota:anon:ip:${ip}`,
        limit: LEGACY_ANON_LIMIT,
        ttl: LONG_TTL_SECONDS,
      };
  }
}

function hasIp(ip: string): boolean {
  return Boolean(ip) && ip !== "unknown";
}

const ipKey = (ip: string) => `quota:ip:${ip}:${dayKey()}`;

function toState(limit: number, used: number, ipUsed: number, ipCounts: boolean): QuotaState {
  const tierRemaining = Math.max(0, limit - used);
  const ipRemaining = ipCounts
    ? Math.max(0, DAILY_IP_LIMIT - ipUsed)
    : Number.POSITIVE_INFINITY;
  const remaining = Math.min(tierRemaining, ipRemaining);
  return { limit, used, remaining, exhausted: remaining <= 0 };
}

export async function getQuota(caller: Caller, ip: string): Promise<QuotaState> {
  const kv = getKV();
  const tier = tierFor(caller, ip);
  const ipCounts = hasIp(ip);
  const [used, ipUsed] = await Promise.all([
    kv.getCount(tier.key),
    ipCounts ? kv.getCount(ipKey(ip)) : Promise.resolve(0),
  ]);
  return toState(tier.limit, used, ipUsed, ipCounts);
}

/**
 * Charge one unit for `runId`, at most once. Call ONLY after the work
 * succeeded. Returns the resulting quota state either way.
 */
export async function consumeRun(
  caller: Caller,
  ip: string,
  runId: string,
): Promise<QuotaState> {
  const kv = getKV();
  const marker = `run:${callerKey(caller)}:${runId}`;

  // incr is atomic: exactly one caller sees 1, so exactly one charges.
  const seen = await kv.incr(marker, RUN_TTL_SECONDS);
  if (seen > 1) return getQuota(caller, ip);

  const tier = tierFor(caller, ip);
  const ipCounts = hasIp(ip);
  const [used, ipUsed] = await Promise.all([
    kv.incr(tier.key, tier.ttl),
    ipCounts ? kv.incr(ipKey(ip), DAY_TTL_SECONDS) : Promise.resolve(0),
  ]);
  return toState(tier.limit, used, ipUsed, ipCounts);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/__tests__/quota.test.ts`
Expected: PASS — 12 tests.

- [ ] **Step 5: Confirm the build is red for the expected reason**

Run: `npm run build`
Expected: FAIL — `src/app/api/tailor/route.ts` and `src/app/api/quota/route.ts` still import the removed `getQuota(identity)` / `consumeQuota` signatures. Task 6 and Task 8 fix them. Do not patch them here.

- [ ] **Step 6: Commit**

The build is intentionally red between this task and Task 6; the unit tests are green.

```bash
git add src/lib/quota.ts src/lib/__tests__/quota.test.ts
git commit -m "feat: tiered quota keyed on Caller with runId idempotency"
```

---

### Task 6: Wire quota into analyze and tailor

`/api/analyze` currently has no quota gate at all — only `tailor` charges. In the extension `analyze` is independently callable, so this closes the hole and switches both routes onto the new model.

**Files:**
- Modify: `src/app/api/analyze/route.ts`
- Modify: `src/app/api/tailor/route.ts`
- Create: `src/lib/api-auth.ts`
- Create: `src/lib/__tests__/api-auth.test.ts`

**Interfaces:**
- Consumes: `resolveCaller`, `Caller`, `CallerResult` (Task 4); `getQuota`, `consumeRun` (Task 5); `hasBetaAccess`, `getIdentity` (existing `src/lib/identity.ts`).
- Produces:
  - `readRunId(body: unknown): string` — extracts and validates a `runId` from a parsed JSON body, returning `""` when absent or malformed.
  - `getCaller(request: Request): Promise<CallerResult>` — the Clerk-aware wrapper routes call.
  - `unauthorized(): Response` — the shared `401` body returned when `getCaller` rejects.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/api-auth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readRunId } from "@/lib/api-auth";

describe("readRunId", () => {
  it("accepts a plausible run id", () => {
    expect(readRunId({ runId: "3f1a-9c2b" })).toBe("3f1a-9c2b");
  });

  it("returns empty string when absent", () => {
    expect(readRunId({})).toBe("");
    expect(readRunId(null)).toBe("");
    expect(readRunId(undefined)).toBe("");
    expect(readRunId("not an object")).toBe("");
  });

  it("rejects non-string values", () => {
    expect(readRunId({ runId: 42 })).toBe("");
    expect(readRunId({ runId: { a: 1 } })).toBe("");
  });

  it("trims and caps the length", () => {
    expect(readRunId({ runId: "  abc  " })).toBe("abc");
    expect(readRunId({ runId: "z".repeat(200) })).toBe("z".repeat(64));
  });

  it("strips characters outside the safe key charset", () => {
    expect(readRunId({ runId: "abc:def*ghi" })).toBe("abcdefghi");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/api-auth.test.ts`
Expected: FAIL — cannot resolve `@/lib/api-auth`.

- [ ] **Step 3: Implement the route helper**

Create `src/lib/api-auth.ts`:

```ts
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { resolveCaller, type CallerResult } from "./auth";

const MAX_RUN_ID_CHARS = 64;

/**
 * Resolve the Clerk session (if any) and turn the request into a Caller.
 * Clerk failures degrade to signed-out rather than failing the request.
 */
export async function getCaller(request: Request): Promise<CallerResult> {
  let userId: string | null = null;
  try {
    ({ userId } = await auth());
  } catch {
    userId = null;
  }
  return resolveCaller(request, userId);
}

/**
 * 401 for a present-but-invalid bearer token. The extension treats this as
 * "refresh the device token and retry once".
 */
export function unauthorized(): Response {
  return NextResponse.json(
    { error: "Your session token is invalid or expired." },
    { status: 401 },
  );
}

/**
 * Pull the client-generated runId out of a parsed body. It becomes part of a
 * Redis key, so the charset is restricted. Returns "" when absent — callers
 * treat that as "this request is its own run".
 */
export function readRunId(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const raw = (body as Record<string, unknown>).runId;
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, MAX_RUN_ID_CHARS);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/__tests__/api-auth.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Add the quota gate to `/api/analyze`**

In `src/app/api/analyze/route.ts`, replace the import block and the handler's opening. The imports become:

```ts
import { NextResponse } from "next/server";
import { callLLM } from "@/lib/llm";
import { normalizeResume } from "@/lib/resume";
import { normalizeJD } from "@/lib/jd";
import { buildAnalyzeMessages, normalizeGapAnalysis } from "@/lib/analysis";
import { getIdentity, hasBetaAccess } from "@/lib/identity";
import { getCaller, readRunId, unauthorized } from "@/lib/api-auth";
import { rateLimitResponse } from "@/lib/rate-limit";
import { getQuota, consumeRun } from "@/lib/quota";
import { capText, MAX_EXTRA_INFO_CHARS } from "@/lib/limits";
```

Replace `const { ip } = getIdentity(request);` and the lines up to the body parse with:

```ts
  const { ip } = getIdentity(request);
  const limited = await rateLimitResponse(ip);
  if (limited) return limited;

  const beta = hasBetaAccess(request);
  const resolved = await getCaller(request);
  if (!resolved.ok) return unauthorized();
  const caller = resolved.caller;

  if (!beta) {
    const quota = await getQuota(caller, ip);
    if (quota.exhausted) {
      return NextResponse.json(
        { error: "You've used all your free runs.", remaining: 0 },
        { status: 402 },
      );
    }
  }
```

Add `runId` to the body type:

```ts
  let body: {
    structuredResume?: unknown;
    structuredJD?: unknown;
    extraInfo?: unknown;
    quality?: unknown;
    runId?: unknown;
  };
```

And capture it after the body parses successfully:

```ts
  const runId = readRunId(body);
```

Finally, replace the success return. It currently reads:

```ts
    return NextResponse.json({ analysis: normalizeGapAnalysis(parsed) });
```

with:

```ts
    const analysis = normalizeGapAnalysis(parsed);
    if (beta) {
      return NextResponse.json({ analysis, remaining: null });
    }
    const after = await consumeRun(caller, ip, runId || crypto.randomUUID());
    return NextResponse.json({ analysis, remaining: after.remaining });
```

A missing `runId` falls back to a fresh UUID, so an old client that does not send one is charged per request rather than escaping the quota.

- [ ] **Step 6: Switch `/api/tailor` to the new quota**

In `src/app/api/tailor/route.ts`, change the imports:

```ts
import { getIdentity, hasBetaAccess } from "@/lib/identity";
import { getCaller, readRunId, unauthorized } from "@/lib/api-auth";
import { getQuota, consumeRun } from "@/lib/quota";
```

Replace the opening of the handler — currently `const identity = getIdentity(request);` through the quota check — with:

```ts
  const { ip } = getIdentity(request);

  // Abuse protection (per-IP) — applies to everyone, including beta users.
  const limited = await rateLimitResponse(ip);
  if (limited) return limited;

  // Beta testers with a valid access code bypass the business quota entirely.
  const beta = hasBetaAccess(request);
  const resolved = await getCaller(request);
  if (!resolved.ok) return unauthorized();
  const caller = resolved.caller;

  // Business quota — block before doing any expensive work.
  if (!beta) {
    const quota = await getQuota(caller, ip);
    if (quota.exhausted) {
      return NextResponse.json(
        { error: "You've used all your free runs.", remaining: 0 },
        { status: 402 },
      );
    }
  }
```

Add `runId?: unknown;` to the body type, and after the body parses:

```ts
  const runId = readRunId(body);
```

Replace the final consumption line — currently `const after = await consumeQuota(identity);` — with:

```ts
  const after = await consumeRun(caller, ip, runId || crypto.randomUUID());
```

The beta early-return above it stays exactly as it is.

- [ ] **Step 7: Verify the build is green again and the suite passes**

Run: `npm run build`
Expected: still RED, and now confined to `src/app/api/quota/route.ts` alone — it is the last caller of the old `getQuota(identity)` signature, and Task 8 fixes it. `src/app/api/tailor/route.ts` must have dropped off the failure list. If any other file errors, that is a real problem: fix it before committing.

Run: `npm test`
Expected: all PASS.

- [ ] **Step 8: Understand what is and is not true yet**

At the end of this task a single generate action still costs **two** units, not
one. The web client sends the same payload to both routes and that payload
carries no `runId` until Task 8, so each route mints its own UUID and the
idempotency marker never matches. A related consequence: with `remaining === 1`
both routes pass their `getQuota` check concurrently and both consume, pushing
`used` past `limit`.

This is transitional, and Task 8 closes it by sending one `runId` to both
fetches. Do not try to fix it here by removing the UUID fallback — passing an
empty `runId` would make every request from a caller share one marker, so only
the first would ever charge, which is a total quota escape.

**Branch-level requirement:** the final review must confirm the client passes
the *same* `runId` to **both** the analyze and tailor fetches. A `runId` wired
to only one of them looks correct in isolation and silently double-charges.

The live smoke test this step originally called for needs an
`OPENROUTER_API_KEY`, which is not present in local `.env.local`. Step 9's
route-level tests exist because of that gap — they are the verification, not a
supplement to it.

- [ ] **Step 9: Route-level charge-once tests**

`readRunId` is unit-tested, but the charging decision lives in the routes and
has no coverage at all — and no live smoke test is possible without an API key.
The composed two-route behavior described in Step 8 is exactly the class of
defect these catch and per-route reading does not.

Create `src/app/api/__tests__/charging.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

// Must be hoisted above the route imports.
vi.mock("@/lib/llm", () => ({ callLLM: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: null })),
}));

import { callLLM } from "@/lib/llm";
import { resetKV } from "@/lib/kv";
import { getQuota } from "@/lib/quota";
import type { Caller } from "@/lib/auth";
import { POST as analyze } from "@/app/api/analyze/route";
import { POST as tailor } from "@/app/api/tailor/route";

const IP = "5.5.5.5";
const ANON = "charging-test-anon";
const caller: Caller = { kind: "anon", anonId: ANON };

const used = async () => (await getQuota(caller, IP)).used;

function post(
  url: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-anon-id": ANON,
      "x-forwarded-for": IP,
      ...headers,
    },
    body: JSON.stringify(payload),
  });
}

const inputs = (runId?: string) => ({
  structuredResume: { contact: { name: "A" } },
  structuredJD: { company: "B" },
  ...(runId ? { runId } : {}),
});

describe("charging", () => {
  beforeEach(() => {
    resetKV();
    vi.mocked(callLLM).mockReset();
    vi.mocked(callLLM).mockResolvedValue({} as never);
    delete process.env.BETA_ACCESS_CODES;
  });

  it("charges one unit for a successful analyze", async () => {
    const res = await analyze(post("https://x/api/analyze", inputs("r1")));
    expect(res.status).toBe(200);
    expect(await used()).toBe(1);
  });

  it("charges nothing when the LLM call fails", async () => {
    vi.mocked(callLLM).mockRejectedValue(new Error("upstream down"));
    const res = await analyze(post("https://x/api/analyze", inputs("r2")));
    expect(res.status).toBe(502);
    expect(await used()).toBe(0);
  });

  it("charges nothing for a malformed body", async () => {
    const res = await analyze(post("https://x/api/analyze", { runId: "r3" }));
    expect(res.status).toBe(400);
    expect(await used()).toBe(0);
  });

  // THE invariant this task exists for: analyze + tailor sharing one runId is
  // one run. Task 8 makes the client send a shared id; this locks it in.
  it("charges one unit total for analyze + tailor sharing a runId", async () => {
    await Promise.all([
      analyze(post("https://x/api/analyze", inputs("shared"))),
      tailor(post("https://x/api/tailor", inputs("shared"))),
    ]);
    expect(await used()).toBe(1);
  });

  it("treats two requests with no shared runId as two runs", async () => {
    await analyze(post("https://x/api/analyze", inputs()));
    await tailor(post("https://x/api/tailor", inputs()));
    expect(await used()).toBe(2);
  });

  it("returns 402 and charges nothing once exhausted", async () => {
    for (let i = 0; i < 5; i++) {
      await analyze(post("https://x/api/analyze", inputs(`fill-${i}`)));
    }
    expect(await used()).toBe(5);
    const res = await analyze(post("https://x/api/analyze", inputs("over")));
    expect(res.status).toBe(402);
    expect(await used()).toBe(5);
  });

  it("charges nothing for a beta caller", async () => {
    process.env.BETA_ACCESS_CODES = "letmein";
    const res = await analyze(
      post("https://x/api/analyze", inputs("beta"), { "x-access-code": "letmein" }),
    );
    expect(res.status).toBe(200);
    expect(await used()).toBe(0);
  });

  it("401s on a present-but-invalid bearer token, before any LLM call", async () => {
    const res = await analyze(
      post("https://x/api/analyze", inputs("bad"), { authorization: "Bearer nope" }),
    );
    expect(res.status).toBe(401);
    expect(vi.mocked(callLLM)).not.toHaveBeenCalled();
    expect(await used()).toBe(0);
  });
});
```

Run: `npx vitest run src/app/api/__tests__/charging.test.ts`
Expected: 8 passing.

- [ ] **Step 10: Lint and commit**

```bash
npm run lint
git add src/lib/api-auth.ts src/lib/__tests__/api-auth.test.ts src/app/api/__tests__/charging.test.ts src/app/api/analyze/route.ts src/app/api/tailor/route.ts
git commit -m "feat: quota-gate analyze and charge one unit per run"
```

---

### Task 7: CORS for the extension origin

The extension's origin is `chrome-extension://<id>`, which no API route currently accepts. Preflight requests would fail before any of the work above ever runs.

**Files:**
- Create: `src/lib/cors.ts`
- Create: `src/lib/__tests__/cors.test.ts`
- Modify: `src/middleware.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `isAllowedOrigin(origin: string | null): boolean` — true for any `chrome-extension://<id>` listed in `ALLOWED_EXTENSION_IDS`.
  - `corsHeaders(origin: string): Record<string, string>`
  - `preflightResponse(origin: string): Response`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/cors.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { isAllowedOrigin, corsHeaders, preflightResponse } from "@/lib/cors";

describe("isAllowedOrigin", () => {
  beforeEach(() => {
    process.env.ALLOWED_EXTENSION_IDS = "aaaabbbbccccddddeeeeffffgggghhhh";
  });

  it("allows a listed extension id", () => {
    expect(
      isAllowedOrigin("chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh"),
    ).toBe(true);
  });

  it("rejects an unlisted extension id", () => {
    expect(isAllowedOrigin("chrome-extension://someotherextensionidhere00")).toBe(
      false,
    );
  });

  it("rejects a website pretending to be an extension", () => {
    expect(
      isAllowedOrigin("https://evil.com/chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh"),
    ).toBe(false);
  });

  it("rejects null and empty origins", () => {
    expect(isAllowedOrigin(null)).toBe(false);
    expect(isAllowedOrigin("")).toBe(false);
  });

  it("allows any listed id when several are configured", () => {
    process.env.ALLOWED_EXTENSION_IDS = "idone, idtwo ,idthree";
    expect(isAllowedOrigin("chrome-extension://idtwo")).toBe(true);
    expect(isAllowedOrigin("chrome-extension://idfour")).toBe(false);
  });

  it("rejects everything when nothing is configured", () => {
    delete process.env.ALLOWED_EXTENSION_IDS;
    expect(isAllowedOrigin("chrome-extension://anything")).toBe(false);
  });
});

describe("corsHeaders", () => {
  it("echoes the origin and allows the headers we send", () => {
    const h = corsHeaders("chrome-extension://abc");
    expect(h["Access-Control-Allow-Origin"]).toBe("chrome-extension://abc");
    expect(h["Access-Control-Allow-Headers"]).toContain("authorization");
    expect(h["Access-Control-Allow-Headers"]).toContain("x-anon-id");
    expect(h["Vary"]).toBe("Origin");
  });
});

describe("preflightResponse", () => {
  it("returns 204 with the CORS headers", () => {
    const res = preflightResponse("chrome-extension://abc");
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "chrome-extension://abc",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/cors.test.ts`
Expected: FAIL — cannot resolve `@/lib/cors`.

- [ ] **Step 3: Implement the CORS module**

Create `src/lib/cors.ts`:

```ts
/**
 * CORS for the Chrome extension. The allowlist is an env var of extension IDs
 * rather than a wildcard, so a random extension cannot spend a user's quota.
 */

const PREFIX = "chrome-extension://";

function allowedIds(): string[] {
  return (process.env.ALLOWED_EXTENSION_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin || !origin.startsWith(PREFIX)) return false;
  const id = origin.slice(PREFIX.length);
  if (!id || id.includes("/")) return false;
  return allowedIds().includes(id);
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers":
      "content-type, authorization, x-anon-id, x-access-code",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function preflightResponse(origin: string): Response {
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}
```

`isAllowedOrigin` checks `startsWith` on the full origin and rejects ids containing `/`, which is what makes the `https://evil.com/chrome-extension://…` case fail.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/__tests__/cors.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Apply CORS in middleware**

Handling this once in middleware avoids adding an `OPTIONS` export to nine route files. Replace `src/middleware.ts` entirely:

```ts
import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { corsHeaders, isAllowedOrigin, preflightResponse } from "@/lib/cors";

// Makes auth available everywhere but protects nothing by default — anonymous
// use must keep working. Individual routes check `auth()` themselves.
//
// Also answers CORS preflights from allowlisted Chrome-extension origins and
// stamps the CORS headers onto API responses, so route files stay untouched.
export default clerkMiddleware(async (_auth, request) => {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin)) return;

  const allowed = origin as string;
  if (request.method === "OPTIONS") {
    return preflightResponse(allowed);
  }

  const response = NextResponse.next();
  for (const [key, value] of Object.entries(corsHeaders(allowed))) {
    response.headers.set(key, value);
  }
  return response;
});

export const config = {
  matcher: [
    // Run on everything except Next internals and static assets…
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|gif|png|svg|ico|webp|woff2?|ttf|map)).*)",
    // …and always on API routes.
    "/(api|trpc)(.*)",
  ],
};
```

- [ ] **Step 6: Document the new env var**

Add to `.env.example`:

```
# Comma-separated Chrome extension IDs allowed to call the API (CORS).
# Leave empty until the extension is published; empty means no extension origin
# is accepted.
ALLOWED_EXTENSION_IDS=
```

- [ ] **Step 7: Verify preflight behavior**

Run `npm run dev`, then in another terminal:

```bash
curl -i -X OPTIONS http://localhost:3000/api/device-token -H "Origin: chrome-extension://testid" -H "Access-Control-Request-Method: POST"
```

Expected with `ALLOWED_EXTENSION_IDS` unset: no `Access-Control-Allow-Origin` header.
Then set `ALLOWED_EXTENSION_IDS=testid` in `.env.local`, restart, and re-run: expect `204` with `Access-Control-Allow-Origin: chrome-extension://testid`.

- [ ] **Step 8: Run the full suite and build**

Run: `npm test && npm run build`
Expected: all PASS.

- [ ] **Step 9: Lint and commit**

```bash
npm run lint
git add src/lib/cors.ts src/lib/__tests__/cors.test.ts src/middleware.ts .env.example
git commit -m "feat: allowlisted CORS for the Chrome extension origin"
```

---

### Task 8: Quota endpoint, fast JD parsing, and web client wiring

Finishes the migration: `/api/quota` reports the new tiered state, JD parsing moves off the resume-parsing model so it stops sitting slowly on the critical path, and the web client sends a `runId` so a generate action charges once.

**Files:**
- Modify: `src/app/api/quota/route.ts`
- Modify: `src/lib/llm.ts` (add the `parse_jd` task)
- Modify: `src/app/api/parse-jd/route.ts`
- Modify: `src/app/app/page.tsx` (send `runId`)

**Interfaces:**
- Consumes: `getCaller` (Task 6), `getQuota` (Task 5).
- Produces: `GET /api/quota` returns `{ remaining, used, limit }`, or `{ remaining: null, unlimited: true }` for beta callers — the same response shape the existing UI already reads, so no component changes are needed beyond the `runId` addition.

- [ ] **Step 1: Update the quota endpoint**

Replace `src/app/api/quota/route.ts` entirely:

```ts
import { NextResponse } from "next/server";
import { getIdentity, hasBetaAccess } from "@/lib/identity";
import { getCaller, unauthorized } from "@/lib/api-auth";
import { getQuota } from "@/lib/quota";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (hasBetaAccess(request)) {
    return NextResponse.json({ remaining: null, unlimited: true });
  }
  const { ip } = getIdentity(request);
  const resolved = await getCaller(request);
  if (!resolved.ok) return unauthorized();
  try {
    const q = await getQuota(resolved.caller, ip);
    return NextResponse.json({
      remaining: q.remaining,
      used: q.used,
      limit: q.limit,
    });
  } catch {
    // If the store is unreachable, don't block the UI — report full quota.
    return NextResponse.json({ remaining: null });
  }
}
```

- [ ] **Step 2: Add a dedicated JD-parsing task to the model map**

In `src/lib/llm.ts`:

Change the task union:

```ts
export type LLMTask = "parse" | "parse_jd" | "analyze" | "tailor" | "ocr";
```

Add the entry to `MODEL_MAP`, leaving `parse` untouched so resume parsing quality is unaffected:

```ts
const MODEL_MAP: Record<LLMTask, string> = {
  parse: "deepseek/deepseek-chat", // resume parsing — unchanged
  parse_jd: "anthropic/claude-haiku-4.5", // on the critical path; must be fast
  analyze: "anthropic/claude-sonnet-4.6",
  tailor: "anthropic/claude-sonnet-4.6",
  ocr: "anthropic/claude-sonnet-4.6", // vision-capable; hardcoded, ignores `quality`
};
```

Add the temperature:

```ts
const DEFAULT_TEMPERATURE: Record<LLMTask, number> = {
  parse: 0.1,
  parse_jd: 0.1,
  analyze: 0.3,
  tailor: 0.4,
  ocr: 0,
};
```

`resolveModel` needs no change — `quality` only overrides `analyze`/`tailor`, and `parse_jd` should never be routed to a slow model.

- [ ] **Step 3: Point the JD route at the new task**

In `src/app/api/parse-jd/route.ts`, change the `callLLM` call's task from `"parse"` to `"parse_jd"`:

```ts
    const parsed = await callLLM({
      task: "parse_jd",
      json: true,
      messages: buildJdParseMessages(capText(text, MAX_JD_CHARS)),
      maxTokens: 2000,
    });
```

Nothing else in the route changes. Because Task 3's instrumentation keys on task name, `stats:parse_jd:*` now accumulates separately from resume parsing — which is exactly the comparison needed later.

- [ ] **Step 4: Send a runId from the web client**

In `src/app/app/page.tsx`, find the function that fires the analyze and tailor requests (search for `"/api/tailor"`). Generate one id and include it in **both** request bodies:

```ts
const runId = crypto.randomUUID();
```

Add `runId` as a field in the JSON body of the `/api/analyze` fetch and the `/api/tailor` fetch. Both must use the **same** value within one generate action — that is what makes the pair cost a single unit.

- [ ] **Step 5: Verify end to end in the browser**

Run `npm run dev`, sign out, and run one full generate at `/app`.

Expected: the remaining count drops by exactly 1 (not 2). Sign in and run again: the count reflects the 5-per-day signed-in allowance rather than the anonymous counter.

- [ ] **Step 6: Run the full suite and build**

Run: `npm test && npm run build`
Expected: all PASS, build succeeds with no type errors.

- [ ] **Step 7: Lint and commit**

```bash
npm run lint
git add src/app/api/quota/route.ts src/lib/llm.ts src/app/api/parse-jd/route.ts src/app/app/page.tsx
git commit -m "feat: tiered quota endpoint, dedicated fast JD parse task, client runId"
```

---

### Task 9: Privacy page and documentation

The Chrome Web Store requires a published privacy policy URL before an extension can be listed. This also records the data boundary the extension work must not break.

**Files:**
- Create: `src/app/privacy/page.tsx`
- Modify: `README.md`
- Modify: `.env.example` (verify both new vars are present)

**Interfaces:**
- Consumes: nothing.
- Produces: a `/privacy` route to be referenced from the Web Store listing in Plan B.

- [ ] **Step 1: Create the privacy page**

Create `src/app/privacy/page.tsx`. Match the styling conventions of the existing landing page in `src/app/page.tsx` (Tailwind v4 utility classes, same container widths and prose treatment).

```tsx
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy — career-path",
  description:
    "What career-path stores, what it doesn't, and how the browser extension handles your resume.",
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Privacy</h1>

      <p className="mt-6 text-sm leading-relaxed">
        career-path is built so your resume stays yours. This page lists exactly
        what is stored and what is not.
      </p>

      <h2 className="mt-10 text-xl font-semibold">What we never store</h2>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-relaxed">
        <li>Your resume file, or the text extracted from it.</li>
        <li>Job descriptions you paste, link, or screenshot.</li>
        <li>Tailored resumes — unless you sign in and click “Save this version”.</li>
      </ul>
      <p className="mt-3 text-sm leading-relaxed">
        These pass through our servers to reach the language model that
        processes them, and are not written to any database.
      </p>

      <h2 className="mt-10 text-xl font-semibold">What we do store</h2>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-relaxed">
        <li>Usage counters, so free allowances and rate limits can be enforced.</li>
        <li>An anonymous device identifier for signed-out extension users.</li>
        <li>Versions you explicitly save while signed in — deletable at any time from “My resumes”.</li>
        <li>Your email address, if you joined the waitlist.</li>
        <li>Aggregate model timing and token counts, with no user content attached.</li>
      </ul>

      <h2 className="mt-10 text-xl font-semibold">The browser extension</h2>
      <p className="mt-3 text-sm leading-relaxed">
        The extension stores your resume in your browser’s local extension
        storage. It is never uploaded to our servers for storage — it is sent
        with a request only when you ask for an analysis, and is discarded once
        that request completes.
      </p>
      <p className="mt-3 text-sm leading-relaxed">
        The extension reads the job posting on the page you are viewing, and
        only when you open the panel there. It does not read any other page, it
        does not collect browsing history, and it does not run in the
        background.
      </p>

      <h2 className="mt-10 text-xl font-semibold">Third parties</h2>
      <p className="mt-3 text-sm leading-relaxed">
        Language models are accessed through OpenRouter. Sign-in is handled by
        Clerk. Counters and saved versions live in Upstash Redis. The site is
        hosted on Vercel.
      </p>
    </main>
  );
}
```

- [ ] **Step 2: Verify the page renders**

Run `npm run dev` and open `http://localhost:3000/privacy`.
Expected: the page renders with site styling and no console errors.

- [ ] **Step 3: Document the new environment variables in the README**

In the environment-variables table in `README.md`, add two rows in the existing style:

```markdown
| `DEVICE_TOKEN_SECRET`       | Prod     | Secret for signing Chrome-extension device tokens (HS256). Generate with `openssl rand -base64 32`. |
| `ALLOWED_EXTENSION_IDS`     | Optional | Comma-separated Chrome extension IDs permitted to call the API (CORS). Empty means no extension origin is accepted. |
```

- [ ] **Step 4: Update the README's quota description**

The "Quota, rate limiting & abuse protection" section still describes the old model. Replace its quota bullet with:

```markdown
- **Quota** (`src/lib/quota.ts`) — business logic. One "run" = one analyze +
  tailor flow, charged once via a client-supplied `runId` and only on success.
  Allowances by caller: **5 per day** signed in, **3 total** for a signed-out
  extension device, **5 total** for a signed-out web visitor (`x-anon-id`,
  unchanged). A per-IP ceiling of **20 per day** applies on top, and a caller is
  blocked when either counter is exhausted. Beta testers with a code in
  `BETA_ACCESS_CODES` bypass the quota (rate limiting still applies).
  Extension callers are identified by a server-signed device JWT rather than a
  client-generated id — see `src/lib/auth.ts`.
```

- [ ] **Step 5: Add a privacy-page link to the README**

In the Privacy section of `README.md`, add a final line:

```markdown
The full policy lives at [`/privacy`](https://careerpath-hazel.vercel.app/privacy).
```

- [ ] **Step 6: Confirm both env vars are in `.env.example`**

Run: `grep -E "DEVICE_TOKEN_SECRET|ALLOWED_EXTENSION_IDS" .env.example`
Expected: both present (added in Tasks 4 and 7).

- [ ] **Step 7: Run the full suite and build**

Run: `npm test && npm run build`
Expected: all PASS.

- [ ] **Step 8: Lint and commit**

```bash
npm run lint
git add src/app/privacy/page.tsx README.md
git commit -m "docs: add privacy page and document the new quota model"
```

---

## Verification checklist

Run after Task 9. Every item must pass before Plan B starts.

- [ ] `npm test` — all suites green
- [ ] `npm run build` — no type errors
- [ ] `npm run lint` — clean
- [ ] Signed-out web generate at `/app` decrements remaining by exactly 1
- [ ] Signed-in web generate reports a limit of 5 and resets the next UTC day
- [ ] `curl -X POST localhost:3000/api/device-token` returns a token; pasting it into jwt.io shows a `did` claim and a 24h expiry
- [ ] A request to `/api/tailor` with `Authorization: Bearer <device token>` and no Clerk session is charged against the 3-run device tier
- [ ] A request with `Authorization: Bearer garbage` returns `401` (so the extension knows to refresh), while a request with **no** `Authorization` header still works on the anon tier (so the web app is unaffected)
- [ ] `OPTIONS` preflight from an allowlisted `chrome-extension://` origin returns `204` with CORS headers; an unlisted one gets none
- [ ] Terminal logs show one `evt: "llm_call"` line per model call, including `parse_jd` with its own model
- [ ] `/privacy` renders
