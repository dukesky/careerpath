# 延迟优化（瘦身+去串行+流式）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点击 Tailor 后 ~6–9s 出匹配分、简历逐段流式出现并在 ~30s 完整、右分 ~55s——全部 ≤1 分钟；等待期展示预写 tips。

**Architecture:** 单尺不变式换尺（瘦身 ANALYZE_SYSTEM，rescore 自动跟随）+ raw-JD 输入砍掉串行 parse + analyze/tailor 可选 SSE 流式（结束帧为权威结果，流式仅呈现层）+ 插件容错部分-JSON 增量渲染 + 静态 tips 卡片。

**Tech Stack:** Next.js App Router（SSE via ReadableStream）、openai SDK streaming、Chrome MV3 extension（React sidepanel）、vitest。

## Global Constraints

- 判分人格与诚实校准条款一字不动；TAILOR_SYSTEM 的可追溯性测试/失败模式/反标签升级条款一字不动（spec §1/§3）。
- `/api/rescore` 路由一行不动（瘦尺经由共享 builder 自动跟随）。
- 未传 `stream` 的路由调用行为逐字节不变（网站兼容）。
- 流式是纯呈现层：正确性只依赖结束帧；任何增量解析异常静默退回等结束帧。
- quota 腿算术、runId/refine/autoRefine 链路不动。
- analyze JSON schema 字段与顺序不变，`overall_match_score` 必须保持首位（流式提分的前提）。
- 代码/注释英文；测试 `npm test`（root）与 `npm --prefix extension run test`。
- 提交信息结尾：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: 瘦身 ANALYZE_SYSTEM

**Files:**
- Modify: `src/lib/analysis.ts`（ANALYZE_SYSTEM，约 111–135 行）
- Test: `src/lib/__tests__/analysis.test.ts`（追加 describe）

**Interfaces:**
- Produces: ANALYZE_SYSTEM 输出预算 ~1400 token；schema 与字段顺序不变。rescore 与 analyze 共用，无新符号。

- [ ] **Step 1: 失败测试**

```ts
describe("ANALYZE_SYSTEM slimming", () => {
  // The system prompt is not exported; assert through the built messages.
  it("carries the brevity caps and keeps the schema order", () => {
    const msgs = buildAnalyzeMessages(RESUME, JD, "");
    const sys = msgs[0].content;
    expect(sys).toContain("at most 2 sentences"); // rationale cap
    expect(sys).toContain("15 words or fewer");   // evidence/suggestion cap
    expect(sys).toContain("top 3 strengths");
    expect(sys).toContain("at most 3 gaps");
    // Field order is the streaming contract: the score must stream first.
    expect(sys.indexOf('"overall_match_score"')).toBeLessThan(sys.indexOf('"rationale"'));
    expect(sys.indexOf('"rationale"')).toBeLessThan(sys.indexOf('"requirements_matrix"'));
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run src/lib/__tests__/analysis.test.ts`
- [ ] **Step 3: 实现**：在 ANALYZE_SYSTEM 的 Rules 段做如下替换（其余一字不动）：
  - `"rationale": one paragraph explaining the score.` → `"rationale": at most 2 sentences explaining the score.`
  - evidence 行追加 `Keep it to 15 words or fewer.`；suggestion 行追加 `Keep it to 15 words or fewer.`
  - `"strengths": the top 5 strengths` → `"strengths": the top 3 strengths`
  - gaps 行改为 `"gaps": the most important gaps, at most 3, each with one short, honest, realistic mitigation sentence (never advise fabrication).`
  - schema 声明上方加注释行（prompt 内文字）：`Output fields in EXACTLY this order — overall_match_score first.`
- [ ] **Step 4: 测试通过** + `npm test` 全绿
- [ ] **Step 5: Commit** `feat(analyze): slim the instrument's output — same ruler, ~half the tokens`

---

### Task 2: raw-JD 输入形态（builders + 两个路由）

**Files:**
- Modify: `src/lib/analysis.ts`（`buildAnalyzeMessages` / `buildTailorMessages` 签名）
- Modify: `src/app/api/analyze/route.ts`、`src/app/api/tailor/route.ts`
- Test: `src/lib/__tests__/analysis.test.ts` 追加；路由测试沿用 `src/app/api/__tests__/` 现有模式（先读该目录任一文件学 mock 结构；若无可用模式则 builder 层单测已覆盖，路由改动以类型+全量测试防回归，报告中说明）

**Interfaces:**
- Produces: 两个 builder 的 `jd` 参数放宽为 `ParsedJD | { rawText: string }`；raw 分支渲染 `--- JOB DESCRIPTION (raw text) ---\n<text>` 块替代 JSON 块。路由 body 新增可选 `jdText: string`（与 `structuredJD` 二选一，`structuredJD` 优先，二者皆无 → 400）。`jdText` 经 `capText(jdText, MAX_JD_CHARS)`。
- Consumes: `capText`/`MAX_JD_CHARS` 已在两路由 import 命名空间内（tailor 已有；analyze 检查后补 import）。

- [ ] **Step 1: builder 失败测试**

```ts
it("renders a raw-text JD block when given { rawText }", () => {
  const msgs = buildAnalyzeMessages(RESUME, { rawText: "We need Kubernetes and Go." }, "");
  expect(msgs[1].content).toContain("JOB DESCRIPTION (raw text)");
  expect(msgs[1].content).toContain("We need Kubernetes and Go.");
  expect(msgs[1].content).not.toContain("JOB DESCRIPTION (JSON)");
  const t = buildTailorMessages(RESUME, { rawText: "We need Kubernetes." }, "", true, null);
  expect(t[1].content).toContain("JOB DESCRIPTION (raw text)");
});
it("keeps the ParsedJD path byte-identical", () => {
  // Compare against the existing inline snapshot test — it must not change.
});
```

- [ ] **Step 2: 确认失败**（类型错误即失败形态）
- [ ] **Step 3: 实现** builder：

```ts
export type JDInput = ParsedJD | { rawText: string };
function jdBlock(jd: JDInput): string {
  return "rawText" in jd
    ? `--- JOB DESCRIPTION (raw text) ---\n${jd.rawText}`
    : jsonBlock("JOB DESCRIPTION (JSON)", jd);
}
```
两个 builder 的 JD 块改用 `jdBlock(jd)`；参数类型改 `JDInput`。路由：`const jd = body.structuredJD ? normalizeJD(body.structuredJD) : typeof body.jdText === "string" && body.jdText.trim() ? { rawText: capText(body.jdText, MAX_JD_CHARS) } : null; if (!jd) return bad("Missing structuredJD or jdText.");`

- [ ] **Step 4: 测试通过** + `npm test` 全绿（Task 1 的 inline snapshot 用例守住 ParsedJD 路径字节不变）
- [ ] **Step 5: Commit** `feat(api): analyze/tailor accept raw JD text — drops the serial parse hop`

---

### Task 3: tailor change_log 瘦身

**Files:**
- Modify: `src/lib/analysis.ts`（TAILOR_SYSTEM 的 `Rules for "change_log"` 段，仅此段）
- Test: `src/lib/__tests__/analysis.test.ts` 追加

- [ ] **Step 1: 失败测试**：`expect(sys).toContain('"original" and "revised" are snippets of 10 words or fewer; "reason" is one short sentence')`（沿用现有 buildTailorMessages 测试形态取 `msgs[0].content`）。同时断言可追溯性测试与反标签升级条款仍逐字在场（复制现有断言）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**：change_log 规则第二行改为 `"original" and "revised" are snippets of 10 words or fewer; "reason" is one short sentence tying the change to the job.`（其余规则不动）
- [ ] **Step 4: 通过** + `npm test`
- [ ] **Step 5: Commit** `feat(tailor): one-line change_log entries — output budget for streaming`

---

### Task 4: llm.ts 流式入口 streamLLM

**Files:**
- Modify: `src/lib/llm.ts`
- Test: 新建 `src/lib/__tests__/llm-stream.test.ts`

**Interfaces:**
- Produces:

```ts
export interface StreamLLMOptions {
  task: LLMTask; messages: ChatMessage[]; quality?: Quality;
  temperature?: number; maxTokens?: number;
}
/**
 * Streams raw text deltas; returns the full concatenated text.
 * No JSON handling here — callers own parsing (routes normalize the final
 * text and fall back to the buffered callLLM retry on a parse failure).
 */
export async function* streamLLM(options: StreamLLMOptions): AsyncGenerator<string, string>;
```

- [ ] **Step 1: 失败测试**（mock `openai`：`vi.mock("openai")`，`create` 返回带 `Symbol.asyncIterator` 的假流，逐 chunk 给 `choices[0].delta.content`，末 chunk 带 `usage`）：断言 (a) 逐 delta yield；(b) 返回值为完整拼接文本；(c) `create` 收到 `stream: true` 与 `stream_options: { include_usage: true }`；(d) `withStats` 记到 usage（mock `./llm-stats` 断言参数）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**：

```ts
export async function* streamLLM(
  options: StreamLLMOptions,
): AsyncGenerator<string, string> {
  const { task, messages, quality, temperature, maxTokens } = options;
  const model = resolveModel(task, quality);
  const temp = temperature ?? DEFAULT_TEMPERATURE[task];
  const stream = await getClient().chat.completions.create({
    model,
    messages: toOpenAIMessages(messages),
    temperature: temp,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    stream: true,
    stream_options: { include_usage: true },
  });
  let full = "";
  let promptTokens = 0;
  let completionTokens = 0;
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content ?? "";
    if (chunk.usage) {
      promptTokens = chunk.usage.prompt_tokens ?? 0;
      completionTokens = chunk.usage.completion_tokens ?? 0;
    }
    if (delta) {
      full += delta;
      yield delta;
    }
  }
  // Stats after the stream settles — mirrors withStats's contract without
  // wrapping the generator in it (withStats expects a promise-returning fn).
  await withStats({ task, model, quality }, async () => ({
    result: full, promptTokens, completionTokens,
  }));
  return full;
}
```
（`withStats` 的实际签名以 `src/lib/llm-stats.ts` 为准——实现者先读它；若其副作用在返回后发生，直接这样包一层即可；若形状不合，最小适配并在报告说明。`stripCodeFences` 导出供路由复用：`export { stripCodeFences }` 或将其提为导出函数。）

- [ ] **Step 4: 通过** + `npm test`
- [ ] **Step 5: Commit** `feat(llm): streamLLM — delta generator with usage stats`

---

### Task 5: analyze/tailor 路由的 SSE 流式分支

**Files:**
- Modify: `src/app/api/analyze/route.ts`、`src/app/api/tailor/route.ts`
- Test: `src/app/api/__tests__/` 新建 `streaming.test.ts`（先读该目录现有文件学 route-handler 测试模式与 mock 约定；mock `@/lib/llm` 的 `streamLLM`/`callLLM`）

**Interfaces:**
- Produces: 两路由接受可选 `stream: true`。SSE 帧契约（插件端 Task 7 消费，逐字对齐）：

```
data: {"d":"<delta text, JSON-escaped>"}\n\n        重复
data: {"final":<今日缓冲响应的同形 JSON>}\n\n         结束帧（analyze: {"analysis":…,"remaining":…}；tailor: {"tailored":…,"remaining":…}）
data: [DONE]\n\n
```
错误帧 `data: {"error":"<message>"}\n\n` 后即关流。`Content-Type: text/event-stream`、`Cache-Control: no-store`。
- 语义约束：auth/quota/rate-limit 检查全部发生在开流之前（与缓冲路径同序同码）；`consumeRun` 在 normalize 成功后、final 帧之前调用一次（与缓冲路径同一容错姿态：consumeRun 抛错则 final 帧 `remaining: null`）；流式文本 JSON parse 失败 → 不重试流，改调既有缓冲 `callLLM`（其自带一次 retry）拿最终结果，仍从 final 帧交付——客户端无感。

- [ ] **Step 1: 失败测试**：mock streamLLM 产出 3 个 delta + 完整合法 JSON 文本；请求 `{...合法 body, stream: true}`；断言响应 header 是 event-stream、按序收到 3 个 `d` 帧、1 个含 `analysis.overall_match_score` 的 final 帧、`[DONE]`；再测 (b) 无 `stream` 字段时行为与旧测试完全一致（现有用例不动即证明）；(c) streamLLM 全文不可解析时 final 帧仍交付（mock callLLM 返回合法对象）且 callLLM 被调用一次；(d) quota 拒绝时不开流、返回与缓冲路径相同的 402 JSON。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（analyze 为例，tailor 同构）：body 解析后加分支：

```ts
  if (body.stream === true) {
    const encoder = new TextEncoder();
    const send = (c: ReadableStreamDefaultController<Uint8Array>, obj: unknown) =>
      c.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const gen = streamLLM({ task: "analyze", messages: msgs, quality, maxTokens: 8000 });
          let full = "";
          while (true) {
            const step = await gen.next();
            if (step.done) { full = step.value; break; }
            full += step.value;
            send(controller, { d: step.value });
          }
          let analysis;
          try {
            analysis = normalizeGapAnalysis(JSON.parse(stripCodeFences(full)));
          } catch {
            // The stream's text was unparseable: fall back to the buffered
            // path, whose single retry is the product's existing posture.
            analysis = normalizeGapAnalysis(
              await callLLM({ task: "analyze", json: true, quality, messages: msgs, maxTokens: 8000 }),
            );
          }
          let remaining: number | null = null;
          if (!beta) {
            try { remaining = (await consumeRun(caller, ip, runId || crypto.randomUUID())).remaining; }
            catch { remaining = null; }
          }
          send(controller, { final: { analysis, remaining } });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (err) {
          send(controller, { error: err instanceof Error ? err.message : "stream failed" });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
    });
  }
```
（`msgs`/`quality`/`beta`/`caller`/`runId` 均为该路由既有局部量；tailor 版 task/"tailored" 键/maxTokens 12000 对应替换。实现者注意把此分支放在与缓冲调用同一位置——所有前置检查之后。）

- [ ] **Step 4: 通过** + `npm test` 全绿
- [ ] **Step 5: Commit** `feat(api): opt-in SSE streaming for analyze and tailor`

---

### Task 6: 插件端部分-JSON 增量提取器

**Files:**
- Create: `extension/src/lib/partialJson.ts`
- Test: 新建 `extension/src/lib/__tests__/partialJson.test.ts`

**Interfaces:**
- Produces（纯函数，Task 7 消费）：

```ts
/** First occurrence of `"key": <number>` in the buffer, else null. */
export function extractNumber(buffer: string, key: string): number | null;
/** First complete `"key": "<string>"` value (handles escaped quotes), else null. */
export function extractString(buffer: string, key: string): string | null;
/**
 * Complete top-level objects of the array at `"key": [ … ]` — balanced-brace
 * scan, string-aware. Returns [] until the array opens; never throws.
 */
export function extractObjects(buffer: string, key: string): unknown[];
```

- [ ] **Step 1: 失败测试**（至少覆盖）：score 在半截 buffer 中可取；字符串含转义引号；数组第 1 个对象闭合、第 2 个半截时只返回 1 个；嵌套对象/数组括号平衡；字符串内的 `{`/`}` 不计数；key 不存在返回 null/[]；恶意长 buffer 不抛错。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**：手写扫描器（~80 行）：找 `"key"` → 跳过 `:` 与空白 → 按首字符分派（数字/字符串/数组）；数组分支维护 depth 与 inString/escape 状态机收集完整对象后 `JSON.parse` 单个对象（parse 失败跳过该对象，不抛）。
- [ ] **Step 4: 通过**
- [ ] **Step 5: Commit** `feat(extension): tolerant partial-JSON extraction for streamed legs`

---

### Task 7: apiStream + runTailor 流式接线

**Files:**
- Modify: `extension/src/lib/api.ts`（新增 `apiStream`）
- Modify: `extension/src/lib/run.ts`
- Test: `extension/src/lib/__tests__/run.test.ts` 追加 + `api.test.ts` 追加

**Interfaces:**
- Produces:
  - `apiStream(path, body, onDelta: (chunk: string) => void, runToken?) : Promise<ApiResult<T>>`——fetch SSE，逐帧回调 `d`，resolve 于 `final` 帧（类型 T 同缓冲版）；`error` 帧或网络失败 → resolve `{ok:false,…}`；**内部不重试**（结束帧缺失即失败，调用方决定）。SSE 解析按 `\n\n` 分帧、`data: ` 前缀、`[DONE]` 终止。
  - `RunState` 新增（display-only，不进缓存）：`streamingScore: number | null`、`streamingRows: RequirementRow[]`（部分 matrix 行）、`streamingResume: ParsedResume | null`（normalizeResume 包过的部分简历）。`INITIAL_RUN_STATE` 中分别为 null/[]/null；done patch 与 error patch 一律清空三者（terminal patch 完整性惯例）。
  - `runTailor` 行为：不再调 `/api/parse-jd`；analyze/tailor 请求 body 用 `jdText: jd.text` 替代 `structuredJD`，且带 `stream: true` 走 `apiStream`：
    - analyze 的 onDelta：累积 buffer；`extractNumber(buffer,"overall_match_score")` 首次非空即 patch `streamingScore`；`extractObjects(buffer,"requirements_matrix")` 行数增加即 patch `streamingRows`（normalize 每行用现有 `toStatus/toKind` 等价逻辑——直接 `normalizeGapAnalysis({requirements_matrix: rows}).requirements_matrix`）。
    - tailor 的 onDelta：`extractString(buffer,"summary")`、`extractObjects(buffer,"experience")` 变化即 patch `streamingResume`（`normalizeResume` 包裹部分对象）。
    - final 帧到达即走今日既有路径（analysis/tailored patch、done patch、rescore、autoRefine 门禁原样）。
    - `apiStream` 失败（含无 final 帧）→ 对该腿改调既有缓冲 `apiPost` 一次（runId 不变，服务端按 runId 去重计费），仍失败才 fail run——流式永不降低成活率。
  - onDelta patch 节流：每 500ms 至多一次 publish（`putLiveRun` 是 storage 写，逐 token 写会刷爆）；实现为 run.ts 内简单时间戳节流，final/terminal patch 不节流。
- Consumes: Task 6 的三个提取函数；Task 5 的帧契约；Task 2 的 `jdText`。

- [ ] **Step 1: 失败测试**（关键用例）：(a) mock fetch 返回 SSE ReadableStream（帧：3 个 d + final + DONE），断言 streamingScore 在 final 之前已 patch、streamingRows 递增、final 后 analysis 完整且 streaming 字段在 done patch 清空；(b) SSE 中途断流 → 该腿自动改发缓冲 apiPost（fetch 第二次调用无 stream 字段）且 run 成活；(c) 不再有 /api/parse-jd 调用，analyze/tailor body 含 `jdText` 无 `structuredJD`；(d) 节流：50 个快速 delta 只产生 ≤N 次 streaming patch；(e) 既有全部用例仍绿（budget 计数、autoRefine 门禁、runToken 双形态——mock 需按新调用形态适配，断言语义不得放松）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（apiStream 核心）：

```ts
export async function apiStream<T>(
  path: string,
  body: unknown,
  onDelta: (chunk: string) => void,
  runToken?: string,
): Promise<ApiResult<T>> {
  try {
    const headers = await buildHeaders(runToken); // reuse apiPost's header logic (extract shared helper)
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST", headers, body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) return failureFromResponse(res); // reuse apiPost's error mapping (extract shared helper)
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let final: T | null = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if (!frame.startsWith("data: ")) continue;
        const payload = frame.slice(6);
        if (payload === "[DONE]") continue;
        const parsed = JSON.parse(payload) as { d?: string; final?: T; error?: string };
        if (typeof parsed.d === "string") onDelta(parsed.d);
        else if (parsed.final !== undefined) final = parsed.final;
        else if (parsed.error) return { ok: false, kind: "server", message: parsed.error };
      }
    }
    if (final === null) return { ok: false, kind: "server", message: "Stream ended without a result." };
    return { ok: true, data: final };
  } catch {
    return { ok: false, kind: "network", message: "Couldn't reach career-path." };
  }
}
```
（`buildHeaders`/`failureFromResponse`：从现有 `apiPost` 提取共享助手，apiPost 行为不变——先读 api.ts 再抽取。）

- [ ] **Step 4: 全量扩展测试通过** + build
- [ ] **Step 5: Commit** `feat(extension): stream analyze and tailor — score first, sections as they land`

---

### Task 8: 面板渐进渲染 + 等待期 Tips

**Files:**
- Create: `extension/src/sidepanel/WaitingTips.tsx`、`extension/src/sidepanel/tips.ts`
- Create: `extension/src/sidepanel/__tests__/WaitingTips.test.tsx`
- Modify: `extension/src/sidepanel/Results.tsx`、`extension/src/sidepanel/App.tsx`（透传新 state）、`extension/src/styles.css`

**Interfaces:**
- Consumes: `RunState.streamingScore/streamingRows/streamingResume`（Task 7）。
- Produces:
  - Results 渲染优先级：正式 `analysis` > streaming 字段。streamingScore 存在且 analysis 尚无 → 分数卡先画 streamingScore（无右箭头）；streamingRows 渲染成现有 Requirements 列表同款（复用 STATUS_MARK）；streamingResume 渲染为轻量"drafting"简历块（复用 ResumeDocument 或简化只读版——读现有组件后选最小路径，报告说明）。
  - `WaitingTips`：props `{ active: boolean }`；`active && 尚无任何实质内容` 时显示；内部每 8s 从洗牌序列取下一条（`useEffect` + interval，卸载清理）；卡片样式 `.tip-card`（淡入淡出 CSS transition，图标 💡 + 一句话 + 类别小标签）。
  - `tips.ts`：`export const TIPS: { category: "applying" | "resume" | "interview" | "follow-up"; text: string }[]`，18 条起步，英文产品口吻，示例（实现者按同口吻补齐并自审有用性）：

```ts
export const TIPS = [
  { category: "applying", text: "Apply within 48 hours of a posting going live — early applications get disproportionate recruiter attention." },
  { category: "applying", text: "Referrals convert 5-10x better than cold applications. Check if anyone in your network works there before you hit submit." },
  { category: "resume", text: "Recruiters spend ~7 seconds on a first pass. Your top bullet under each role should be the one you'd say out loud in an interview." },
  { category: "resume", text: "Numbers beat adjectives: 'cut deploy time from 22 to 6 minutes' outworks 'significantly improved deployments'." },
  { category: "interview", text: "Prepare three stories in STAR form (situation, task, action, result). Most behavioral questions are one of them wearing a costume." },
  { category: "interview", text: "At the end, ask the interviewer what surprised them most in their first months. It reads as judgment, not flattery." },
  { category: "follow-up", text: "Send a thank-you note within 24 hours that references one specific moment from the conversation." },
  // …extend to 18+ in the same voice
];
```

- [ ] **Step 1: 失败测试**：WaitingTips 显示/8s 轮换（fake timers）/不重复直至用尽/active=false 即消失；Results：streamingScore 先画且 `.score` 不含 `→`；analysis 到达后 streaming 视图让位；TIPS 数组 ≥18 条且四类齐全。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（组件 + 接线 + 样式）
- [ ] **Step 4: 全量扩展测试 + build 通过**
- [ ] **Step 5: Commit** `feat(extension): progressive paint and waiting tips`

---

### Task 9: bench 验证（evaluator 角色，真实花费，帽 $5）

**Files:**
- Create: `evaluator/bench/run-slim-ruler.ts`（bench 目录保持未跟踪）

**Interfaces:**
- Consumes: 既有 bench libs（fixtures/openrouter/ledger/judge）+ 既有 4 个 fixture + 各 state 报告的旧尺分数（uplift-v2.json 的 left 列：82/91/4/52）。

**内容**（spec §7 的三道门）：
1. **瘦尺校准**：瘦尺 analyze（Task 1 后的 builder，ParsedJD 形态与 raw 形态各测其一——raw 用 fixture 的 jd.txt）4 fixture × 3 trial：(a) 排序与旧尺一致（82/91/4/52 的序）；(b) 同输入 3 次散布 ≤±2；(c) elicitation 响应（02-staff 扣 extra-info 的左测 vs 注入后 refine 简历的重测，均值 ≥+1）。
2. **tailor 重判**：raw-JD + 瘦 change_log 生成 12 份（4×3），与 uplift-v2 的 condition B 存量输出盲评两序：fabrication 0/24、win rate ≥40%。
3. 结果落 `reports/slim-ruler.json`，报告写 `.superpowers` 工作区。任一门不过 → 停，报告给 controller 裁决（prompt 措辞回调或呈 owner）。

- [ ] **Step 1: 写脚本（复用 run-uplift.ts 骨架）**
- [ ] **Step 2: 干跑校验 import**
- [ ] **Step 3: 真跑（OPENROUTER_API_KEY 自主 checkout .env.local 导出，帽 $5）**
- [ ] **Step 4: 判门并报告**（不 commit——bench 未跟踪）

---

### Task 10: 收尾验证

- [ ] **Step 1:** `npm run test:all` 全绿；两端 build 干净。
- [ ] **Step 2:** 端到端时间线口算核对：以 Task 9 实测的瘦尺输出 token 数换算首分/完整时间，对照 spec §6 的目标表写入报告（真实浏览器实测由 owner 在真实 JD 上做，读 cp_run_log 时间戳——若埋点已被后台任务移除则以面板观察为准）。
- [ ] **Step 3:** grep 网站端调用点确认缓冲路径零改动波及（`grep -rn "api/analyze\|api/tailor" src/app src/components | grep -v route.ts`）。
- [ ] **Step 4:** 提交计划文档，向 owner 汇总（时间线、bench 门槛数字、遗留）。

## Self-review 记录

- spec 覆盖：§1→T1、§2→T2、§3→T3、§4→T4/5/7、§5→T7、§6→T10 核对、§7→T9、§8→T8 ✓。
- 无占位符；SSE 帧契约在 T5（产）与 T7（耗）逐字一致；`stripCodeFences` 导出在 T4 交代；RunState 新字段三处（INITIAL/done/error patch）职责写明。
- 类型一致性：`JDInput`、`apiStream<T>`、三个提取函数签名在产/耗两侧一致。
