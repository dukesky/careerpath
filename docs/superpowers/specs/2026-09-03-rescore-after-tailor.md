# Rescore-after-tailor：用同一把尺子测量改写后的匹配分

**日期：** 2026-09-03
**角色分工：** Fable 5（主 agent，本 spec 作者）→ Opus（执行）→ Sonnet（evaluator，用 `evaluator/` harness 端到端评测）
**背景：** 面板显示 "60 → 60 match"。右边数字是 tailor 模型对自己输出的自评（`projected_match_score`），与左边 analyze 的 `overall_match_score` 来自两次互相看不见的调用、两把未校准的尺子；`2026-08-17-match-score-stability-design.md` 记录了这是当时的有意取舍（拒绝串行链因为延迟翻倍）。产品对外卖的却是 "before → after 的提升"。本变更引入**同尺复测**：tailor 完成后，用与 analyze 完全相同的 prompt/模型/温度给**改写后的简历**重新打分，作为右边的数字。delta 从"两次猜测的巧合"变成"同一仪器的真实测量"。用户（产品 owner）已批准该方向。

## 1. 服务端：`POST /api/rescore`

新路由 `src/app/api/rescore/route.ts`（`runtime = "nodejs"`，`maxDuration = 120`）：

- **输入**：`{ structuredResume, structuredJD, quality, runId }` —— `structuredResume` 是 **tailored** 简历。经 `normalizeResume`/`normalizeJD` 清洗，复用 analyze 路由的输入校验风格与 `capText` 限制。
- **打分 = 完整复用 analyze 的仪器**：`buildAnalyzeMessages` 原样调用（同 system prompt、同 schema、temperature 0、`callLLM` 的 `analyze` 任务路由到同一模型）。响应只返回 `{ score }`（取 `overall_match_score`；完整矩阵服务端丢弃 —— 未来若要展示"改写后剩余 gap"再扩展，本次不做）。**不得**为了省 token 自创精简 prompt —— 换 prompt 就是换尺子，校准即失效。
- **计费：不扣额度，但必须闭合滥用面**（扩展代码是公开的，无门槛的免费 LLM 端点会被薅）：
  1. 标准 per-IP rate limit（同 analyze）。
  2. **run marker 门**：`kv.getCount("run:" + callerKey(caller) + ":" + runId) > 0` 才放行 —— rescore 只服务真实发生过的 run。**只 READ，绝不 incr 这个 marker** —— `consumeRun` 的腿数奇偶记账依赖它，多 incr 一次就破坏计费语义（见 `quota.ts` 的 LEGS_PER_GENERATE 注释）。
  3. **独立计数封顶**：`incr("rescore:" + callerKey(caller) + ":" + runId, RUN_TTL_SECONDS)`，超过 3（= 1 次生成 + FREE_REFINES 次免费 refine）返回 429。
  4. **beta 旁路对齐**：`hasBetaAccess(request)` 为真时跳过 marker 门（执行前先核实 beta 调用下 analyze/tailor 是否调 `consumeRun`——若不调则 beta run 无 marker，不豁免会把 beta 用户全部 403）。
  5. 身份解析同其他路由（`getCaller`，无效 bearer 401，绝不静默降级）。

## 2. 共享契约与扩展

- `shared/contract.ts`：`RunState` 不在这里 —— 扩展侧 `extension/src/lib/run.ts` 的 `RunState` 增加 `rescoredScore: number | null`；`extension/src/lib/cache.ts` 的 `CacheEntry` 增加可选 `rescoredScore?: number`（缓存校验不得因缺失该字段拒绝旧条目 —— 向后兼容）。
- **`run.ts` 时序（关键设计，不许改动）**：analyze ∥ tailor 照旧并行；`phase:"done"` 的 patch **照旧在 tailor 落地时立即发出**（首屏延迟一毫秒都不能加，延迟是产品头号抱怨）；done patch 之后再 `apiPost("/api/rescore", { structuredResume: tailored.resume, structuredJD, quality, runId }, opts.runToken)`，成功则补发 `{ rescoredScore }` patch（phase 保持 "done"）。**rescore 失败绝不把 run 标为 error**——静默降级到 projected 分数，`console.warn` 一条即可；匿名与登录路径行为一致（runToken 仅透传，与现有三调用相同）。
- `extension/src/background/runs.ts`：`runTailor` 返回后写缓存的地方，把 `latest.rescoredScore`（若有）一并写入 `putCachedRun`。注意 `runTailor` 内部 await rescore 意味着 done patch 与函数返回之间隔了一次调用 —— 保持现有 "publish before cache write, clearLiveRun after" 的顺序不变，面板在 clearLiveRun 前一直读 live 状态，patch 能到达。
- `extension/src/sidepanel/Results.tsx`：右边数字 = `rescoredScore ?? projected_match_score`（rescore 未到时先显示 projected，到了替换 —— 不加 spinner，不加动画）。**两个数字都改为显示原始整数，删掉 `roundToFive`**：取整存在的理由是"两把尺子的噪声"，同尺 temp-0 复测后噪声源已除，而 ±2.5 的取整会吞掉真实的小幅提升（今天实测 87→88 这种 delta 就会被抹平）。冻结的 baseline 语义不变。读缓存渲染时同样优先 `rescoredScore`。
- **诚实原则**：若复测分 < baseline，照实显示。不 max()、不托底 —— 造假的分数比不变的分数更糟。这是产品"no fabrication"底线的延伸。

## 3. Web app

`src/app/app/page.tsx`：两调用 settle 后追加 rescore fetch，`afterScore = rescoredScore ?? projected_match_score`；`ResultsView.tsx` 的 delta/badge 逻辑照旧吃这个值。失败同样静默降级。

## 4. 测试与文档

- 单元测试：route 的 marker 门/封顶/beta 旁路/401 分支；`run.ts` 的 patch 顺序（done 先于 rescoredScore、rescore 失败不改 phase）；`Results.tsx` 的回退显示与整数显示；`runs.ts` 缓存写入包含 rescoredScore。旧缓存条目（无 rescoredScore）必须仍被接受。
- `docs/superpowers/specs/2026-08-17-match-score-stability-design.md` 追加一节：记录本决定取代当年 §7 的"复测 out of scope"结论及原因（不阻塞首屏的后置复测当年未被考虑）；`CHANGELOG.md` 加条目。
- **evaluator harness 扩展**（`evaluator/`，产品代码之外）：新增断言 **A7**：一次登录生成后，代理记录中出现 `POST /api/rescore` → 200 且携带与三主调用相同的 `uid` 身份；quota `used` 总增量仍为 1（rescore 未计费）；面板最终渲染的 after 数字等于 rescore 响应的 score；用伪造 runId 直接 curl `/api/rescore` 得 4xx。A5 超时语义不变（done ≤180s，不含 rescore）；rescore 自身落地 ≤ 90s 记入报告。

## 5. 成本与风险（已接受）

- 每次生成 +1 次 analyze 级调用（约 +40% LLM 成本，约 +$0.04）；不影响首屏延迟，总尾延迟 +20~30s（MV3 worker 由进行中的 fetch 保活，evaluator 盯超时）。
- 同尺复测的 delta 预期是"小而真"（+2~+8 常见），不是营销页的 78→91；demo 页 fixture 不改。
- 完成定义：全部单元测试绿 **且** evaluator 无 mutation 运行 verdict=PASS（含 A7）。绿测试不是完成，evaluator 说了才算 —— 这是本项目的铁律。
