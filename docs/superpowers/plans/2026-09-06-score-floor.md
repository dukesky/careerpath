# 分数不倒退（Score Floor）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户永远不会看到无解释的降分：噪声性下跌显示"维持原分"（矩阵相等背书），must-have 真降级自动修复一次（复用 autoRefine 机器），修复等待期有诚实文案 + tips 轮换。97%+ 的 run 延迟零变化。

**Architecture:** rescore 响应加宽（rows 一直在算、只是不再扔）→ 客户端纯函数 compareMatrices 判降级 → run.ts 三分支决定右侧显示值与是否触发修复腿（既有 autoRefine 路径按运行时条件触发）→ Results.tsx 渲染 maintained/说明/修复等待态。仪器零改动。

**Tech Stack:** 既有栈；无新依赖。

## Global Constraints

- rescore 测量仪器零改动（buildAnalyzeMessages 逐字、空 extraInfo、模型/温度/maxTokens）；只加响应字段。
- 任何分支不得改变首绘三件套（首分/流式简历/下载）的时序。
- 显示"维持原分"必须由矩阵零降级背书；有 must-have 降级绝不显示 maintained。
- 修复腿单次、免费（同 runId）、采纳门 = 分数不更低 且 无新增 must-have 降级；不循环。
- 终端 patch 完整性惯例：新增 RunState 字段在 done/error patch 与 INITIAL 中有明确值。
- 代码/注释/文案英文；提交结尾 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: rescore 响应加宽

**Files:**
- Modify: `src/app/api/rescore/route.ts`（仅响应组装处）
- Test: `src/app/api/__tests__/rescore-jd.test.ts` 追加（该文件已有可跑的 rescore POST harness）

**Interfaces:**
- Produces: 响应 `{ score, rows }`，`rows = normalizeGapAnalysis(parsed).requirements_matrix.map(({requirement, kind, status}) => ({requirement, kind, status}))`（不含 evidence/suggestion——面板不需要，省字节）。旧字段 score 不变。
- 路由中注释"computed and thrown away"段落改写为：矩阵状态现在随响应返回（分数不倒退功能的判据）；仪器不变。

- [ ] **Step 1: 失败测试**：mock callLLM 返回含 2 行矩阵的合法 GapAnalysis；断言响应 body 有 `score` 和 `rows`，rows[0] 恰含 requirement/kind/status 三键（`Object.keys(...).sort()`）。
- [ ] **Step 2: 确认失败** — `npx vitest run src/app/api/__tests__/rescore-jd.test.ts`
- [ ] **Step 3: 实现**：`const g = normalizeGapAnalysis(parsed); score = g.overall_match_score; rows = g.requirements_matrix.map(...)`; 响应 `NextResponse.json({ score, rows, ... })`（保持既有 remaining 等字段如有）。
- [ ] **Step 4: 通过** + `npm test` 全绿。
- [ ] **Step 5: Commit** `feat(rescore): return the matrix statuses the route always computed`

---

### Task 2: compareMatrices 纯函数

**Files:**
- Create: `extension/src/lib/compareMatrices.ts`
- Test: `extension/src/lib/__tests__/compareMatrices.test.ts`

**Interfaces:**
- Produces:

```ts
import type { RequirementRow, ReqKind, ReqStatus } from "@shared/contract";
export interface RescoreRow { requirement: string; kind: ReqKind; status: ReqStatus }
export interface Downgrade { requirement: string; kind: ReqKind; from: ReqStatus; to: ReqStatus }
/**
 * Pairs left-analysis rows with rescore rows by token overlap (>=0.5 on
 * lowercased word sets — the bench flip-detector's algorithm) and returns
 * every row whose status got WORSE (met -> partially_met/missing, or
 * partially_met -> missing). A left row with no match is treated as a
 * downgrade to "missing" — conservative by design. Pure; never throws.
 */
export function compareMatrices(left: RequirementRow[], rescored: RescoreRow[]): Downgrade[];
```
- 状态序：met(2) > partially_met(1) > missing(0)；to < from 即降级。token 重叠：`overlap = |A∩B| / min(|A|,|B|)`，词集为小写、去标点、长度≥3 的词。

- [ ] **Step 1: 失败测试**（用例至少）：同文本行 met→partial 检出；措辞轻改（token 重叠 0.6）仍配对；升级（missing→met）不报；无配对的 met 左行报降级 to "missing"；无配对的 missing 左行**不**报（missing→missing 非降级）；空输入 → []；恶意 500 行不抛错。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（~60 行；每个左行取重叠最高且 ≥0.5 的未占用 rescore 行——贪心即可，行数 ≤20）
- [ ] **Step 4: 通过**
- [ ] **Step 5: Commit** `feat(extension): matrix downgrade detection for the score floor`

---

### Task 3: run.ts 三分支 + 修复腿

**Files:**
- Modify: `extension/src/lib/run.ts`
- Test: `extension/src/lib/__tests__/run.test.ts` 追加

**Interfaces:**
- Consumes: Task 1 的 `{score, rows}` 响应；Task 2 的 compareMatrices；既有 autoRefine 腿（run.ts 的 gated tail：`opts.autoRefine !== true` early-return，其后是 refine tailor(带 analysis) + measure + adopt-if-not-worse）。
- Produces（RunState 新字段，INITIAL/done/error patch 中均为 null/[]）：
  - `scoreNote: "maintained" | "nice_dip" | "downgraded" | null` — 右侧数字的叙事标注。
  - `downgradedRequirements: string[]` — 点名的行（nice_dip/downgraded 时非空）。
  - 显示值约定：`rescoredScore` 存**要显示的**右值——maintained 分支存左分（见下），其余分支存测量值。原始测量值不需要保留字段（不进缓存叙事）。
- 行为（替换现有 measure→publish 的直接路径；伪码）：

```
const measured = await measureWithRows(tailoredResume);       // {score, rows} | null
if (!measured) { /* 与今天一致：静默降级，右侧保持投影 */ }
else {
  const left = analyzed.data.analysis;
  if (measured.score >= left.overall_match_score) {
    publish({ rescoredScore: measured.score, scoreNote: null });
  } else {
    const downs = compareMatrices(left.requirements_matrix, measured.rows);
    if (downs.length === 0) {
      publish({ rescoredScore: left.overall_match_score, scoreNote: "maintained" });
    } else {
      // ANY downgrade + dip triggers the repair (owner-widened threshold,
      // ~5-8% of runs wait): one free matrix-informed refine, re-measure,
      // then re-branch. Post-repair residuals:
      //   zero downs        -> maintained (or normal if score recovered)
      //   nice-to-have only -> LEFT score + scoreNote "nice_dip" naming the
      //                        softer row (number never drops; note keeps it honest)
      //   must-have residual-> the ONLY lower-number display, scoreNote
      //                        "downgraded" + named row + question-card CTA
      //                        (expected ~0 with the adopt gate)
      publish({ refining: true /* keeps score slot on placeholder via scoreNote "repairing"?  见下 */ });
      ... existing refine-tailor call with analysis: left ...
      const remeasured = await measureWithRows(refined.resume);
      adopt iff remeasured && remeasured.score >= measured.score
               && compareMatrices(left.matrix, remeasured.rows).filter(must).length === 0
      then re-run the SAME branch logic on the adopted (or original) measurement,
      except no second repair (a flag guards recursion);
      finally publish({ refining: false }).
    }
  }
}
```
  - 修复期间右侧数字不显示中间低值：分数卡在 `refining && scoreNote === null && rescoredScore === null` 时显示占位（Task 4）。实现上：修复分支在采纳判定完成前不 publish rescoredScore。
  - autoRefine 旧 flag 路径保持兼容（两者共享同一 refine-leg helper——把现有 tail 抽成 `runRefineLeg(analysis)` 复用；`opts.autoRefine` 的采纳门维持原语义）。
  - measureWithRows：现有 measure() 改为返回 `{score, rows}`（rows 缺失时为 []——旧服务端兼容：rows 为空数组时 compareMatrices 会把所有 met 左行判降级 → **守卫**：`rows.length === 0` 时跳过对比逻辑直接走今日行为（照实显示测量分），保证对旧服务端的向后兼容）。
- 预算断言更新：修复触发的用例 = tailor×2 + rescore×2（与 autoRefine:true 相同形状）；未触发的默认用例保持 tailor×1 + rescore×1。

- [ ] **Step 1: 失败测试**（关键用例）：(a) measured ≥ left → 照旧；(b) 降分 + rows 零降级 → rescoredScore=左分 + scoreNote maintained（**不触发修复**：零降级即噪声，无需第二次 tailor）；(c) 降分 + 任何降级（nice-to-have 或 must-have）→ 修复腿触发：第二次 tailor（带 analysis）+ 第二次 rescore；(d) 修复后零降级 → maintained（或分数恢复则照旧）；(e) 修复后仅 nice-to-have 残余 → rescoredScore=**左分** + scoreNote nice_dip + 点名（数字不降）；(f) 修复后 must-have 残余 → 测量分 + downgraded + 点名，且无第三次 tailor；(g) rows 为空（旧服务端）→ 今日行为，无对比字段、无修复；(h) 修复期间在 rescoredScore publish 之前 refining:true 已发布；(i) 终端 patch 清空新字段；(j) autoRefine:true 旧路径行为不变（现有用例不改断言）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（含 runRefineLeg 抽取；保留全部既有 doc comment 的约束叙述，修复分支加注释说明单次不循环与旧服务端守卫）
- [ ] **Step 4: 全量扩展测试 + build 通过**
- [ ] **Step 5: Commit** `feat(extension): honest score floor — maintained display and must-have auto repair`

---

### Task 4: 面板显示

**Files:**
- Modify: `extension/src/sidepanel/Results.tsx`、`extension/src/sidepanel/WaitingTips.tsx`（若 active 条件需扩展参数）、`extension/src/styles.css`
- Test: `extension/src/sidepanel/__tests__/Results.test.tsx` 追加

**Interfaces:**
- Consumes: `scoreNote` / `downgradedRequirements` / `refining`（Task 3）。
- Produces：
  - maintained：右值即左分（run.ts 已存），`→ 91` 用中性色（非绿）；其下 `<p className="muted tiny">Re-measured within the ruler's precision — every requirement holds; presentation improved.</p>`
  - nice_dip（修复后残余）：右值 = **左分**（数字不降，中性色）；其下 `One nice-to-have reads softer on the second pass: "<row>" — core requirements all hold.`（多行时列首行 + "and N more"）。
  - downgraded：双数字；`The rewrite reads weaker on: "<row>". Try the question cards below — real detail there raises it back.`
  - 修复等待态（refining && rescoredScore null）：右侧数字位显示脉动 "…"；分数卡文案替换为 **"Taking a second pass at your resume — {N} requirement{s} deserve{s} a harder look. This usually takes under a minute."**；其下挂 WaitingTips（active 扩展为 `working || repairing`，repairing = refining && !rescoredScore）。原 "Improving the rewrite against the gaps…" 文案在此态被新文案取代（autoRefine 旧路径无 N 信息时用泛化文案 "Taking a second pass at your resume…"）。
  - 中性色样式 `.after-neutral`（styles.css，沿用现有 .after 的排版只改色）。
- 既有 pinned 字符串（"60 → 70 match" 等）不变（scoreNote null 路径完全不动）。

- [ ] **Step 1: 失败测试**：四态各一渲染用例（maintained 中性色 + 文案；nice_dip 点名；downgraded 点名 + 引导问题卡片；修复等待态占位 + 新文案 + tips 激活）；现有用例零修改。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 全量扩展测试 + build**
- [ ] **Step 5: Commit** `feat(extension): score-floor display states and second-pass waiting UI`

---

### Task 5: 收尾验证

- [ ] **Step 1:** `npm run test:all` + 两端 build 全绿。
- [ ] **Step 2: 回放验证 compareMatrices**（零 API 花费）：写一次性脚本（scratchpad，不入库）加载 `evaluator/bench/reports/uplift-v2.state.json` 与 `slim-ruler.state.json` 里的左矩阵/改后矩阵对，跑 compareMatrices，人工核对：配对率（未配对行 <10%）、降级判定与 bench matrixFlips 记录一致（02-staff 的 CNCF nice-to-have 降级应检出、01-billing 零降级应为零）。
- [ ] **Step 3:** 汇总给 owner：门槛数字、Expedia 活案例的预期显示（91 → 91 · maintained）、push/部署提醒（本功能同样需要先部署服务端——rows 字段——再让新扩展生效；不过 run.ts 已做旧服务端守卫，顺序错了也只是回到今日行为而非报错）。

## Self-review 记录

- spec 覆盖：§1→T1、§2→T2、§3/§4→T3、§5→T4、§6→T5 ✓。无占位符。
- 兼容性：rows 缺失守卫（T3-f）保证扩展先于服务端更新也不坏——比上次 "Missing structuredJD" 的版本错位有进步。
- 类型一致性：RescoreRow/Downgrade/scoreNote 取值在 T2/T3/T4 一致；ReqKind/ReqStatus 引 @shared/contract。
