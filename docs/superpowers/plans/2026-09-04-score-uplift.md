# 诚实提分链路（Score Uplift Pipeline）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** tailor 之后面板右侧的测量分要诚实地高于左侧原简历分：done 首绘后自动发一次 matrix-informed 免费 refine，再让用户通过问题卡片补充真实素材触发第二次免费 refine，全程 rescore 用同一把 analyze 尺子测量。

**Architecture:** 三段一条线——首屏 analyze∥tailor 并行不动；第一段在 `runTailor` 尾部自动 refine（tailor 带上 gap analysis，runId 复用免费，rescore 后只在分数不降时采纳）；第二段复用现有 supplement→refine 通路，把 matrix 的 missing/partially_met 行渲染成问题卡片。`/api/rescore` 一行不动。

**Tech Stack:** Next.js App Router（API routes）、Chrome MV3 extension（React sidepanel + service worker）、vitest、evaluator/bench（tsx + OpenRouter，未跟踪目录）。

## Global Constraints

- **No-fabrication 至上**：任何 prompt 改动不得削弱 `TAILOR_SYSTEM` 的可追溯性测试；新指令必须显式从属于它（spec §代码改动面 1）。
- **`/api/rescore` 路由一行不动**：`buildAnalyzeMessages` 逐字调用、`extraInfo` 传空串、同模型同温度（该文件头注释是硬约束）。
- **首绘顺序不动**：`done` patch 之前不得增加任何 LLM 调用；refine 全部发生在 done 之后（run.ts 第 78–84 行注释是硬约束）。
- **限额恰好用满不超**：每个 charged run 至多 2 次免费 refine（`FREE_REFINES=2`）、3 次 rescore（`MAX_RESCORES_PER_RUN=3`）。本设计：charged run = 初始 rescore + 自动 refine（免费#1 + rescore#2）；用户回答 = 免费#2 的完整 refine run（其内部 rescore = #3，且该 run 不再自动 refine）。
- 代码与注释用英文；测试跑 `npm test`（根）与 `npm --prefix extension run test`。
- 提交信息结尾：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- token 上限现状（勿回退）：analyze/rescore 8000，tailor 12000。

---

### Task 1: buildTailorMessages 的定向提分指令

**Files:**
- Modify: `src/lib/analysis.ts`（`buildTailorMessages`，约 219–222 行的 `if (analysis)` 块）
- Test: 新建 `src/lib/__tests__/analysis.test.ts`

**Interfaces:**
- Consumes: 现有 `buildTailorMessages(resume, jd, extraInfo, includeSummary, analysis?)`（签名不变）。
- Produces: 当 `analysis` 非空时，user message 含 `--- GAP ANALYSIS (target the uplift honestly) ---` 块与下述指令文本；`analysis` 为空时输出与现在逐字节相同。后续任务依赖这一行为，不依赖新符号。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/__tests__/analysis.test.ts
import { describe, it, expect } from "vitest";
import { buildTailorMessages } from "@/lib/analysis";
import type { ParsedResume } from "@/lib/resume";
import type { ParsedJD } from "@/lib/jd";
import type { GapAnalysis } from "@shared/contract";

const RESUME = {
  contact: { name: "Ada", email: "", phone: "", location: "", links: [] },
  summary: "", experience: [], projects: [], skills: [], education: [],
} as ParsedResume;
const JD = { company: "Acme", role_title: "SRE" } as unknown as ParsedJD;
const ANALYSIS: GapAnalysis = {
  overall_match_score: 70, rationale: "",
  requirements_matrix: [{
    requirement: "Kubernetes", kind: "must_have", status: "partially_met",
    evidence: "ran EKS clusters", suggestion: "surface the operator work",
  }],
  strengths: [], gaps: [],
};

describe("buildTailorMessages targeted uplift", () => {
  it("adds the targeted-uplift directive only when an analysis is provided", () => {
    const withA = buildTailorMessages(RESUME, JD, "", true, ANALYSIS);
    const without = buildTailorMessages(RESUME, JD, "", true, null);
    const userWith = withA[1].content;
    const userWithout = without[1].content;
    expect(userWith).toContain("GAP ANALYSIS (target the uplift honestly)");
    expect(userWith).toContain("partially_met");
    // The directive names the hard boundary so the model sees it next to the data.
    expect(userWith).toContain("do NOT touch");
    expect(userWithout).not.toContain("GAP ANALYSIS");
  });

  it("does not change the analysis-free message at all", () => {
    const a = buildTailorMessages(RESUME, JD, "extra", false, null);
    expect(a[1].content).not.toContain("uplift");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/__tests__/analysis.test.ts`
Expected: FAIL——现有代码的块标签是 `GAP ANALYSIS (for guidance)`，不含新指令。

- [ ] **Step 3: 最小实现**

把 `src/lib/analysis.ts` 中：

```ts
  // Optional: fold in the gap analysis for extra guidance when available.
  // Omitting it lets tailor run in parallel with analyze.
  if (analysis) blocks.push(jsonBlock("GAP ANALYSIS (for guidance)", analysis));
```

替换为：

```ts
  // Optional: present on the refine legs only — the first run fires analyze
  // and tailor in parallel, so tailor cannot see the analysis there.
  if (analysis) {
    blocks.push(jsonBlock("GAP ANALYSIS (target the uplift honestly)", analysis));
    blocks.push(
      [
        "TARGETED UPLIFT (subordinate to the traceability test above — it never licenses adding a fact):",
        "For each requirements_matrix row with status \"partially_met\" or \"missing\", check whether the resume or extra info ALREADY contains supporting evidence the row's status failed to credit. If it does, rewrite that real evidence to be explicit and prominent, using the requirement's own vocabulary, so a recruiter re-reading the resume against that requirement would mark it met.",
        "If the resume and extra info genuinely contain no supporting evidence for a row, do NOT touch it — no bullet, no keyword, no summary clause. The gap stays in the analysis, not in the resume.",
      ].join("\n"),
    );
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/__tests__/analysis.test.ts`
Expected: PASS（2 个用例）。

- [ ] **Step 5: 全量根测试防回归**

Run: `npm test`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/lib/analysis.ts src/lib/__tests__/analysis.test.ts
git commit -m "feat(tailor): targeted-uplift directive when the gap analysis is present

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: runTailor 的自动 refine 尾部

**Files:**
- Modify: `extension/src/lib/run.ts`
- Test: `extension/src/lib/__tests__/run.test.ts`（追加用例；现有 mock 模式：`vi.stubGlobal("fetch", ...)` 按 URL 分派）

**Interfaces:**
- Consumes: Task 1 的行为（`/api/tailor` 已接受可选 `analysis` 字段并透传，见 `src/app/api/tailor/route.ts` 第 60–80 行——服务端无需改动）。
- Produces:
  - `RunState` 新字段 `refining: boolean`（`INITIAL_RUN_STATE` 中为 `false`）。
  - `RunOptions` 新字段 `priorAnalysis?: GapAnalysis`——存在时：tailor 请求体带 `analysis: opts.priorAnalysis`，且**跳过**自动 refine 尾部（这是用户回答触发的第二段 refine run 的形态，防止超出 FREE_REFINES/MAX_RESCORES）。
  - 自动 refine 行为（仅当 `opts.priorAnalysis` 不存在）：初始 rescore 之后（无论其成败），POST `/api/tailor`（同 payload + `analysis: analyzed.data.analysis`，同 runId → 免费），成功后 POST `/api/rescore` 测量 refined 简历；**仅当** refined 分数是数字且 `>=`（初始 rescoredScore ?? −1）时，patch `{ tailored: refined, rescoredScore: refinedScore }`——分数更低就整体丢弃，保持"右分只升不降"。全程 `refining: true → false` 包裹，任何失败静默降级（与现有 rescore 同姿态，console.warn 即可）。

- [ ] **Step 1: 写失败测试（追加到 run.test.ts 的 describe 内）**

```ts
  it("auto-refines after the first rescore: tailor with analysis, rescore again, adopt when not worse", async () => {
    const tailorBodies: any[] = [];
    let tailorCalls = 0;
    let rescoreCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      if (u.endsWith("/api/parse-jd")) return json({ jd: { company: "Acme" } });
      if (u.endsWith("/api/analyze"))
        return json({ analysis: { overall_match_score: 60, requirements_matrix: [] }, remaining: 4 });
      if (u.endsWith("/api/tailor")) {
        tailorCalls += 1;
        tailorBodies.push(JSON.parse(String(init?.body)));
        return json({ tailored: { projected_match_score: 70, resume: { summary: `v${tailorCalls}` } }, remaining: 4 });
      }
      // /api/rescore: first measurement 65, refined measurement 72
      rescoreCalls += 1;
      return json({ score: rescoreCalls === 1 ? 65 : 72 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    expect(tailorCalls).toBe(2);
    expect(rescoreCalls).toBe(2);
    // The refine tailor call carries the analysis; the first one does not.
    expect(tailorBodies[0].analysis).toBeUndefined();
    expect(tailorBodies[1].analysis).toEqual({ overall_match_score: 60, requirements_matrix: [] });
    // Refined result adopted with its measured score.
    const final = patches[patches.length - 1];
    expect(final.tailored).toMatchObject({ resume: { summary: "v2" } });
    expect(final.rescoredScore).toBe(72);
    // refining toggled on then off around the refine leg.
    expect(patches.some((p) => p.refining === true)).toBe(true);
    expect(patches[patches.length - 1].refining).toBe(false);
  });

  it("discards a refined rewrite that measures WORSE than the first rescore", async () => {
    let rescoreCalls = 0;
    let tailorCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.endsWith("/api/parse-jd")) return json({ jd: {} });
      if (u.endsWith("/api/analyze"))
        return json({ analysis: { overall_match_score: 60 }, remaining: 4 });
      if (u.endsWith("/api/tailor")) {
        tailorCalls += 1;
        return json({ tailored: { projected_match_score: 70, resume: { summary: `v${tailorCalls}` } }, remaining: 4 });
      }
      rescoreCalls += 1;
      return json({ score: rescoreCalls === 1 ? 65 : 58 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    // Worse measurement: keep v1 and 65 on screen; only `refining:false` published after.
    const withTailored = patches.filter((p) => p.tailored);
    expect(withTailored[withTailored.length - 1].tailored).toMatchObject({ resume: { summary: "v1" } });
    expect(patches.filter((p) => typeof p.rescoredScore === "number").pop()?.rescoredScore).toBe(65);
  });

  it("skips the auto-refine on a run that carries priorAnalysis, and sends it to tailor", async () => {
    const tailorBodies: any[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      if (u.endsWith("/api/parse-jd")) return json({ jd: {} });
      if (u.endsWith("/api/analyze"))
        return json({ analysis: { overall_match_score: 60 }, remaining: 4 });
      if (u.endsWith("/api/tailor")) {
        tailorBodies.push(JSON.parse(String(init?.body)));
        return json({ tailored: { projected_match_score: 70 }, remaining: 4 });
      }
      return json({ score: 66 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const prior = { overall_match_score: 55, requirements_matrix: [] } as any;
    await runTailor(JD, RESUME, () => {}, { runId: "reused-id", priorAnalysis: prior });

    expect(tailorBodies).toHaveLength(1);
    expect(tailorBodies[0].analysis).toEqual(prior);
    // Exactly one rescore fired (the initial measurement) — no auto-refine legs.
    const rescoreHits = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/api/rescore"));
    expect(rescoreHits).toHaveLength(1);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix extension run test -- src/lib/__tests__/run.test.ts`
Expected: 3 个新用例 FAIL（`refining` 未定义、只有 1 次 tailor 调用等）。

- [ ] **Step 3: 实现**

`extension/src/lib/run.ts` 改动四处：

(a) `RunState` 加字段（放在 `rescoredScore` 之后）与 `INITIAL_RUN_STATE`：

```ts
  /**
   * True only while the free auto-refine leg (tailor with the gap analysis,
   * then a second rescore) is in flight, so the panel can hint that the
   * right-hand number is still improving. Never blocks anything: the run is
   * already `done` when this goes true.
   */
  refining: boolean;
```

```ts
export const INITIAL_RUN_STATE: RunState = {
  phase: "idle",
  analysis: null,
  tailored: null,
  rescoredScore: null,
  refining: false,
  remaining: null,
  error: null,
};
```

(b) `RunOptions` 加字段：

```ts
  /**
   * The previous charged run's analysis, present only on a user-triggered
   * refine run. Two effects: the tailor leg sends it so the rewrite targets
   * the matrix, and the auto-refine tail is SKIPPED — a refine run is itself
   * the second (and last) free leg, and its own rescore is the third and
   * last allowed for the runId. Fresh charged runs omit it.
   */
  priorAnalysis?: GapAnalysis;
```

(c) tailor 请求体带上 priorAnalysis（改 `tailorCall`）：

```ts
  const tailorCall = apiPost<{ tailored: TailorResult; remaining: number | null }>(
    "/api/tailor",
    opts.priorAnalysis ? { ...payload, analysis: opts.priorAnalysis } : payload,
    opts.runToken,
  );
```

同时 `phase: "reading"` 的起始 patch 与 done patch 需带 `refining: false`（terminal patch 完整描述状态的既有原则）。

(d) 现有 rescore try/catch 整体重构为顺序尾部（保持所有既有注释的约束）。将 195–231 行的 `try { ... } catch { ... }` 替换为：

```ts
  const measure = async (resume: ParsedResume): Promise<number | null> => {
    try {
      const rescored = await apiPost<{ score: number }>(
        "/api/rescore",
        { structuredResume: resume, structuredJD: parsed.data.jd, quality: "quality", runId },
        opts.runToken,
      );
      if (!rescored.ok) {
        console.warn(JSON.stringify({ evt: "rescore_failed", kind: rescored.kind, message: rescored.message }));
        return null;
      }
      if (typeof rescored.data.score !== "number") {
        console.warn(JSON.stringify({ evt: "rescore_malformed" }));
        return null;
      }
      return rescored.data.score;
    } catch (err) {
      console.warn(JSON.stringify({ evt: "rescore_threw", message: err instanceof Error ? err.message : String(err) }));
      return null;
    }
  };

  const firstScore = await measure(tailored.data.tailored.resume);
  if (firstScore !== null) onUpdate({ rescoredScore: firstScore });

  // The free auto-refine leg: tailor again WITH the gap analysis (same runId,
  // so the server treats it as a refinement and does not charge), measure the
  // rewrite, and adopt it only when it is not worse. A refine run
  // (priorAnalysis present) skips this — it IS the second free leg.
  if (opts.priorAnalysis) return;
  try {
    onUpdate({ refining: true });
    const refined = await apiPost<{ tailored: TailorResult; remaining: number | null }>(
      "/api/tailor",
      { ...payload, analysis: analyzed.data.analysis },
      opts.runToken,
    );
    if (!refined.ok || !refined.data.tailored) {
      console.warn(JSON.stringify({ evt: "refine_failed" }));
      return;
    }
    const refinedScore = await measure(refined.data.tailored.resume);
    // Adopt only a measured, not-worse rewrite: the right-hand number must
    // never go DOWN because of a leg the user did not ask for. `?? -1` adopts
    // when the first measurement itself failed — any measured number beats an
    // unmeasured projection.
    if (refinedScore !== null && refinedScore >= (firstScore ?? -1)) {
      onUpdate({ tailored: refined.data.tailored, rescoredScore: refinedScore });
    }
  } catch (err) {
    console.warn(JSON.stringify({ evt: "refine_threw", message: err instanceof Error ? err.message : String(err) }));
  } finally {
    onUpdate({ refining: false });
  }
```

注意 `finally` 里的 `refining: false` 必须无条件发布（含 `opts.priorAnalysis` 早退路径之前根本没置 true，所以早退不需要）。`GapAnalysis` 已在文件头 import。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix extension run test -- src/lib/__tests__/run.test.ts`
Expected: 全部 PASS（含既有用例——若既有"rescore 失败保持 done"用例因新增 tailor 调用而 mock 不匹配，按同一 URL 分派模式补上 `/api/tailor` 第二次响应，不改断言语义）。

- [ ] **Step 5: Commit**

```bash
git add extension/src/lib/run.ts extension/src/lib/__tests__/run.test.ts
git commit -m "feat(extension): free auto-refine leg after the first rescore

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: background worker 把 priorAnalysis 接进 refine run

**Files:**
- Modify: `extension/src/background/runs.ts`（第 85–86 行附近与 `runTailor` 调用处）
- Test: `extension/src/background/__tests__/runs.test.ts`（追加用例，沿用该文件既有的 mock 结构）

**Interfaces:**
- Consumes: Task 2 的 `RunOptions.priorAnalysis`；`getCachedRun` 返回的 `prior`（已含 `analysis` 与 `runId` 字段——`putCachedRun` 一直在写 `analysis`）。
- Produces: refine run（`supplement` 非空且 `prior?.runId` 存在，与现有 runId 复用判定同一条件）调用 `runTailor` 时传 `priorAnalysis: prior.analysis`；fresh run 不传。

- [ ] **Step 1: 写失败测试**

在 `runs.test.ts` 中（沿用其对 `@/lib/run` 的 mock 或 fetch stub 模式——先读该文件确认；若它 mock 了 `runTailor`，断言其第 4 参）：

```ts
  it("passes the cached analysis as priorAnalysis on a refine, and nothing on a fresh run", async () => {
    // Arrange a cached prior run with a runId and an analysis, then start a
    // run with a non-empty supplement (the existing refine trigger).
    // Assert: runTailor's opts contain priorAnalysis === cached analysis and
    // runId === cached runId.
    // Then start a fresh run (empty supplement): opts.priorAnalysis undefined.
  });
```

（具体 arrange 代码抄该文件里已有的 cached-run 构造用例；断言目标是 `runTailor` mock 的 `calls[n][3]`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix extension run test -- src/background/__tests__/runs.test.ts`
Expected: FAIL（`priorAnalysis` 为 undefined）。

- [ ] **Step 3: 实现**

`runs.ts` 第 85–86 行处：

```ts
  const prior = await getCachedRun(forUrl, msg.fingerprint);
  const isRefine = msg.supplement.trim().length > 0 && !!prior?.runId;
  const runId = isRefine ? prior!.runId! : newRunId();
```

`runTailor` 调用的 opts 改为：

```ts
        {
          extraInfo: msg.supplement,
          runId,
          runToken: msg.runToken,
          // A refine run rewrites against the PREVIOUS run's matrix: its own
          // analyze fires in parallel, so this is the only analysis the tailor
          // leg can see. Fresh runs omit it and get the auto-refine tail instead.
          ...(isRefine && prior?.analysis ? { priorAnalysis: prior.analysis } : {}),
        },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix extension run test -- src/background/__tests__/runs.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add extension/src/background/runs.ts extension/src/background/__tests__/runs.test.ts
git commit -m "feat(extension): refine runs rewrite against the previous run's matrix

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 面板——refining 提示 + 问题卡片

**Files:**
- Create: `extension/src/sidepanel/QuestionCards.tsx`
- Create: `extension/src/sidepanel/__tests__/QuestionCards.test.tsx`
- Modify: `extension/src/sidepanel/Results.tsx`（分数卡片提示 + 挂载 QuestionCards）
- Modify: `extension/src/sidepanel/App.tsx`（组合 supplement 并透传 onImprove）

**Interfaces:**
- Consumes: `RunState.refining`（Task 2）；`analysis.requirements_matrix`（既有）；App 的 `generate(supplement: string)`（既有，refine 触发条件是 supplement 非空 + 缓存 runId）。
- Produces: `QuestionCards` 组件，props：`{ analysis: GapAnalysis; disabled: boolean; onImprove: (answersText: string) => void }`。`answersText` 形如每行 `"<requirement>: <answer>"`，只含用户填了内容的行。

- [ ] **Step 1: 写失败测试**

```tsx
// extension/src/sidepanel/__tests__/QuestionCards.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QuestionCards } from "../QuestionCards";
import type { GapAnalysis } from "@shared/contract";

const ANALYSIS: GapAnalysis = {
  overall_match_score: 60, rationale: "", strengths: [], gaps: [],
  requirements_matrix: [
    { requirement: "Kubernetes", kind: "must_have", status: "partially_met", evidence: "", suggestion: "name the operator work" },
    { requirement: "Rust", kind: "nice_to_have", status: "missing", evidence: "", suggestion: "" },
    { requirement: "TypeScript", kind: "must_have", status: "met", evidence: "5y", suggestion: "" },
  ],
};

describe("QuestionCards", () => {
  it("renders one card per missing/partially_met row and none for met rows", () => {
    render(<QuestionCards analysis={ANALYSIS} disabled={false} onImprove={() => {}} />);
    expect(screen.getByText("Kubernetes")).toBeTruthy();
    expect(screen.getByText("Rust")).toBeTruthy();
    expect(screen.queryByText("TypeScript")).toBeNull();
  });

  it("submits only answered rows as 'requirement: answer' lines", () => {
    const onImprove = vi.fn();
    render(<QuestionCards analysis={ANALYSIS} disabled={false} onImprove={onImprove} />);
    fireEvent.change(screen.getAllByRole("textbox")[0], {
      target: { value: "wrote a namespace operator in Go" },
    });
    fireEvent.click(screen.getByRole("button", { name: /improve/i }));
    expect(onImprove).toHaveBeenCalledWith("Kubernetes: wrote a namespace operator in Go");
  });

  it("disables the button when nothing is answered or when disabled", () => {
    render(<QuestionCards analysis={ANALYSIS} disabled={false} onImprove={() => {}} />);
    expect((screen.getByRole("button", { name: /improve/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix extension run test -- src/sidepanel/__tests__/QuestionCards.test.tsx`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现组件**

```tsx
// extension/src/sidepanel/QuestionCards.tsx
import { useState } from "react";
import type { GapAnalysis } from "@shared/contract";

/** More than this and the panel scrolls forever; the top gaps matter most. */
const MAX_CARDS = 5;

/**
 * The elicitation half of the uplift pipeline: each missing / partially_met
 * matrix row becomes a question card. Answers are REAL facts the user supplies
 * — they feed the existing supplement -> free-refine path, they are never
 * invented — and the composed text goes through generate() so all the refine
 * plumbing (runId reuse, disclosure line, cache) applies unchanged.
 */
export function QuestionCards({
  analysis,
  disabled,
  onImprove,
}: {
  analysis: GapAnalysis;
  disabled: boolean;
  onImprove: (answersText: string) => void;
}) {
  const rows = analysis.requirements_matrix
    .filter((r) => r.status !== "met" && r.requirement.trim())
    .slice(0, MAX_CARDS);
  const [answers, setAnswers] = useState<Record<number, string>>({});

  if (rows.length === 0) return null;

  const answered = rows
    .map((r, i) => ({ r, text: (answers[i] ?? "").trim() }))
    .filter((x) => x.text.length > 0);

  return (
    <section className="card">
      <div className="label">Raise your score with real experience</div>
      <p className="muted tiny">
        These requirements scored low. If you actually have the experience, say
        what you did — it gets woven in and the match is re-measured. Leave
        blank anything you don&rsquo;t have; nothing is ever invented.
      </p>
      <ul className="reqs">
        {rows.map((r, i) => (
          <li key={i}>
            <strong>{r.requirement}</strong>
            {r.suggestion && <div className="muted tiny">{r.suggestion}</div>}
            <textarea
              rows={2}
              value={answers[i] ?? ""}
              placeholder="What did you actually do? Tools, scale, numbers."
              onChange={(e) => setAnswers({ ...answers, [i]: e.target.value })}
              disabled={disabled}
            />
          </li>
        ))}
      </ul>
      <button
        className="primary"
        disabled={disabled || answered.length === 0}
        onClick={() => onImprove(answered.map((x) => `${x.r.requirement}: ${x.text}`).join("\n"))}
      >
        Improve my score
      </button>
    </section>
  );
}
```

- [ ] **Step 4: 跑组件测试确认通过**

Run: `npm --prefix extension run test -- src/sidepanel/__tests__/QuestionCards.test.tsx`
Expected: PASS（3 用例）。

- [ ] **Step 5: 接进 Results 与 App**

`Results.tsx`：
1. props 增加 `onImprove: (answersText: string) => void;` 与 `canRun: boolean;`。
2. 分数卡片里 `→ {rescoredScore ?? ...}` 行之后加提示（放在 `<div className="score">` 闭合之后）：

```tsx
          {state.refining && (
            <p className="muted tiny">Improving the rewrite against the gaps…</p>
          )}
```

3. Details card（`</section>` 之后、SupplementBox 的 section 之前）挂载：

```tsx
      {analysis && tailored && (
        <QuestionCards
          analysis={analysis}
          disabled={!canRun}
          onImprove={onImprove}
        />
      )}
```

（记得 `import { QuestionCards } from "./QuestionCards";`）

`App.tsx`：给 `<Results ... />` 增加两个 props（与现有 `appliedSupplement`、`supplement` 同一处）：

```tsx
          canRun={canRun}
          onImprove={(answersText) =>
            void generate(
              [appliedSupplement, answersText].filter((s) => s.trim().length > 0).join("\n"),
            )
          }
```

其中 `appliedSupplement` 用该文件传给 Results 的同一表达式（已在作用域内）；组合保证第二次 refine 不丢第一次已应用的补充。

- [ ] **Step 6: 全量扩展测试 + 构建**

Run: `npm --prefix extension run test && npm --prefix extension run build`
Expected: 测试全 PASS，构建成功（若 App.test.tsx 对 Results props 有快照/类型依赖，补上新 props 的最小 mock）。

- [ ] **Step 7: Commit**

```bash
git add extension/src/sidepanel/QuestionCards.tsx extension/src/sidepanel/__tests__/QuestionCards.test.tsx extension/src/sidepanel/Results.tsx extension/src/sidepanel/App.tsx
git commit -m "feat(extension): question cards feed real facts into the free refine leg

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: bench uplift 验证脚本（不入库，worktree 的 evaluator/bench 拷贝内）

**Files:**
- Create: `evaluator/bench/run-uplift.ts`（bench 目录未被 git 跟踪——保持现状，不 add）

**Interfaces:**
- Consumes: `lib/fixtures.ts` 的 `loadFixtures()`（fixture: `id/resume/jdText/extraInfo/canonicalJD`）、`lib/openrouter.ts` 的 `callLLMReplica(req, ledger, phase, label)`、`lib/ledger.ts` 的 `Ledger`、`lib/judge.ts` 的 `judgeTailorPair`、产品 builders（`buildAnalyzeMessages`/`buildTailorMessages`/`normalizeGapAnalysis`/`normalizeTailorResult`）、现有 `reports/tailor-prompt-fix.state.json`（条件 A 复用其中 15 条 candidate tailored 输出，省 15 次生成费）。
- Produces: `reports/uplift.json` 汇总 + 终端打印的门槛判定。

- [ ] **Step 1: 写脚本**

```ts
// evaluator/bench/run-uplift.ts
// Measures the honest uplift: analyze-instrument(rewritten) - analyze-instrument(original).
// Conditions: A = today's parallel tailor (reused from tailor-prompt-fix.state.json),
// B = matrix-informed refine (fresh), C = elicitation simulation on 02-staff-platform
// (extra info withheld from the left measurement, injected at the refine leg).
// Gates (spec 2026-09-04-score-uplift-design.md): B mean uplift >= +3 on >= 2/3
// fixtures; no condition mean uplift <= -2; refined outputs re-judged with 0
// fabrication flags and >= 40% win rate vs condition A.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BENCH_DIR, loadEnv } from "./lib/env.ts";
loadEnv();
import { Ledger } from "./lib/ledger.ts";
import { callLLMReplica } from "./lib/openrouter.ts";
import { loadFixtures, type Fixture } from "./lib/fixtures.ts";
import { judgeTailorPair } from "./lib/judge.ts";
import {
  buildAnalyzeMessages, buildTailorMessages,
  normalizeGapAnalysis, normalizeTailorResult,
  type GapAnalysis, type TailorResult,
} from "../../src/lib/analysis.ts";

const MODEL = "anthropic/claude-sonnet-4.6";
const TRIALS = 3;
const ledger = new Ledger(6);

async function analyzeScore(f: Fixture, resume: any, extraInfo: string, label: string) {
  const out = await callLLMReplica(
    { model: MODEL, messages: buildAnalyzeMessages(resume, f.canonicalJD, extraInfo), temperature: 0, maxTokens: 8000, json: true },
    ledger, "generate", label,
  );
  if (!out.ok) throw new Error(`analyze failed: ${label}`);
  const g = normalizeGapAnalysis(out.value);
  return { score: g.overall_match_score, analysis: g };
}

async function refineTailor(f: Fixture, extraInfo: string, analysis: GapAnalysis, label: string) {
  const out = await callLLMReplica(
    { model: MODEL, messages: buildTailorMessages(f.resume, f.canonicalJD, extraInfo, true, analysis), temperature: 0.4, maxTokens: 12000, json: true },
    ledger, "generate", label,
  );
  if (!out.ok) throw new Error(`tailor failed: ${label}`);
  return normalizeTailorResult(out.value);
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

async function main() {
  const fixtures = loadFixtures();
  const prior = JSON.parse(readFileSync(resolve(BENCH_DIR, "reports/tailor-prompt-fix.state.json"), "utf8"));
  const currentOutputs = new Map<string, TailorResult[]>();
  for (const g of prior.gen) {
    if (g.task === "tailor" && g.role === "candidate" && g.normalized) {
      const list = currentOutputs.get(g.fixtureId) ?? [];
      list.push(g.normalized as TailorResult);
      currentOutputs.set(g.fixtureId, list);
    }
  }

  const results: any = { A: {}, B: {}, C: {}, judgments: [] as any[] };
  for (const f of fixtures) {
    const left: number[] = [];
    const analyses: GapAnalysis[] = [];
    const upliftA: number[] = [];
    const upliftB: number[] = [];
    const refinedOutputs: TailorResult[] = [];
    for (let t = 0; t < TRIALS; t++) {
      const l = await analyzeScore(f, f.resume, f.extraInfo, `left|${f.id}|t${t}`);
      left.push(l.score); analyses.push(l.analysis);
      const current = currentOutputs.get(f.id)![t];
      const a = await analyzeScore(f, current.resume, "", `A|${f.id}|t${t}`);
      upliftA.push(a.score - l.score);
      const refined = await refineTailor(f, f.extraInfo, l.analysis, `B-tailor|${f.id}|t${t}`);
      refinedOutputs.push(refined);
      const b = await analyzeScore(f, refined.resume, "", `B|${f.id}|t${t}`);
      upliftB.push(b.score - l.score);
      console.log(`${f.id} t${t}: left=${l.score} A=${l.score + upliftA[t]} B=${l.score + upliftB[t]}`);
      // Judging: refined (B) vs current (A output), both orders.
      for (const order of [0, 1]) {
        const [x, y] = order === 0 ? [refined, current] : [current, refined];
        const call = await judgeTailorPair(f.jdText, f.resume, f.extraInfo, x, y, ledger, `judge|${f.id}|t${t}|o${order}`);
        results.judgments.push({ fixture: f.id, trial: t, order, refinedSlot: order === 0 ? "A" : "B", verdict: call.verdict });
      }
    }
    results.A[f.id] = { left, uplift: upliftA, mean: mean(upliftA) };
    results.B[f.id] = { left, uplift: upliftB, mean: mean(upliftB) };
  }

  // Condition C: 02-staff-platform only — left measured WITHOUT the extra info,
  // refine leg gets it (simulates a user answering the question cards).
  const staff = fixtures.find((f) => f.id === "02-staff-platform")!;
  const upliftC: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    const l = await analyzeScore(staff, staff.resume, "", `C-left|t${t}`);
    const refined = await refineTailor(staff, staff.extraInfo, l.analysis, `C-tailor|t${t}`);
    const r = await analyzeScore(staff, refined.resume, "", `C|t${t}`);
    upliftC.push(r.score - l.score);
    console.log(`C t${t}: left=${l.score} refined=${r.score}`);
  }
  results.C["02-staff-platform"] = { uplift: upliftC, mean: mean(upliftC) };

  // Gates.
  const bMeans = Object.values(results.B).map((x: any) => x.mean);
  const gate1 = bMeans.filter((m: any) => m >= 3).length >= 2;
  const gate2 = [...Object.values(results.A), ...Object.values(results.B), ...Object.values(results.C)]
    .every((x: any) => x.mean > -2);
  let fabFlags = 0, refinedWins = 0, judged = 0;
  for (const j of results.judgments) {
    if (!j.verdict) continue;
    judged++;
    const side = j.refinedSlot as "A" | "B";
    if (j.verdict.fabrication[side].violated) fabFlags++;
    if (j.verdict.overall_winner === side) refinedWins++;
    else if (j.verdict.overall_winner === "tie") refinedWins += 0.5;
  }
  const gate3 = fabFlags === 0;
  const gate4 = judged > 0 && refinedWins / judged >= 0.4;

  results.gates = { gate1_uplift3_on_2of3: gate1, gate2_never_negative: gate2, gate3_zero_fabrication: gate3, gate4_winrate40: gate4, fabFlags, winRate: judged ? refinedWins / judged : null };
  writeFileSync(resolve(BENCH_DIR, "reports/uplift.json"), JSON.stringify(results, null, 2));
  console.log("\nGATES:", JSON.stringify(results.gates, null, 2));
  console.log(`spend: $${ledger.spentUsd.toFixed(4)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 干跑健全性检查（不花钱）**

Run: `cd evaluator/bench && npx tsx --eval "import('./run-uplift.ts')" --help 2>&1 | head -3`——只验证模块能被 tsx 解析（真正的 main 会因缺 key 或立即开跑，所以用 `npx tsx dry-run.ts` 确认 fixtures/builders 仍可加载即可）。
Expected: 无 import/类型错误。

- [ ] **Step 3: 真跑（~$3–4，预算帽 $6）**

Run: `cd evaluator/bench && OPENROUTER_API_KEY=$(grep '^OPENROUTER_API_KEY=' /Users/tianzhang/Projects/careerpath/.env.local | cut -d= -f2-) npx tsx run-uplift.ts`
Expected: 打印每 trial 的 left/A/B 分数、C 段、四个 gate 的判定与花费；`reports/uplift.json` 落盘。

- [ ] **Step 4: 评估门槛**

- 四个 gate 全 true → 通过，进 Task 6。
- gate1 失败（B 段提升不足 +3）→ 允许一次 prompt 迭代：加强 Task 1 的 TARGETED UPLIFT 措辞（例如把 "explicit and prominent" 细化为 "lead the relevant role's bullets with it and mirror the requirement's exact phrasing"），重跑 Task 5 Step 3。仍不过则把结果与瓶颈如实汇报给用户定夺，不得靠放松打分或注水达成。
- gate3 失败（出现 fabrication）→ 停下：这是发布阻断项。定位被标记的措辞模式，在 TAILOR_SYSTEM 失败模式清单里补一条，重跑本任务与（如 prompt 变了）`run-bench.ts` 的 prompt A/B。

（bench 目录保持未跟踪，无 commit。）

---

### Task 6: 收尾验证

**Files:**
- Modify: 无新代码；只跑验证与提交遗留。

- [ ] **Step 1: 全量测试**

Run: `npm run test:all`
Expected: 根 + extension 全 PASS。

- [ ] **Step 2: 检查 e2e evaluator 的 rescore 计数假设**

Run: `grep -rn "rescore" /Users/tianzhang/Projects/careerpath/evaluator/run-eval.mjs /Users/tianzhang/Projects/careerpath/evaluator/lib/ | grep -iv "//" | head -20`
自动 refine 使每个 charged run 的 rescore 从 1 次变最多 2 次、tailor 从 1 次变 2 次。若 A7 断言了精确调用次数（而非"≤ MAX_RESCORES_PER_RUN"），在汇报里明确指出需要另一个会话（evaluator 是主 checkout 的未提交 WIP）同步更新断言——不要在本 worktree 改主 checkout 的 WIP 文件。
Expected: 得到一份"哪些断言会受影响"的清单（可能为空）。

- [ ] **Step 3: 手动冒烟（可选，需 dev server + 已加载扩展）**

面板发起一次真实 run：右分先出现投影 → 换成测量值 → "Improving the rewrite…"提示出现又消失 → 右分不降；填一张问题卡 → Improve my score → 右分再变。（无法跑浏览器时跳过，注明。）

- [ ] **Step 4: 提交计划文档并汇总**

```bash
git add docs/superpowers/plans/2026-09-04-score-uplift.md
git commit -m "docs: implementation plan for the score-uplift pipeline

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

向用户汇报：uplift 数字（A/B/C 三条件按 fixture）、四个 gate、花费，以及是否合并回 main 的建议。

## Self-review 记录

- spec 覆盖：定向指令→Task 1；自动 refine→Task 2；worker 接线→Task 3；旅程提示+问题卡片→Task 4；三条件验证+四门槛→Task 5；rescore 路由零改动→无任务（约束项）✓。
- spec 的"62 → 71 → 78 三段旅程展示"按 YAGNI 收敛为"右侧数字原位更新 + refining 提示"，两次跳变用户都看得到；如需显示历史轨迹另立任务。
- 类型一致性：`refining`/`priorAnalysis`/`onImprove`/`canRun` 名称在 Task 2/3/4 间一致；`QuestionCards` props 与测试一致。
