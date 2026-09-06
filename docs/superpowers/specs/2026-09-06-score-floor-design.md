# 分数不倒退（score floor）设计——诚实的降分处置

日期：2026-09-06
状态：已由产品负责人逐节确认（对话中）
前置：2026-09-05-latency-streaming（已上线）、2026-09-04-score-uplift（autoRefine 机器）

## 问题

流式版上线后实测三例：72→78（升）、52→52（平）、**91→88（降）**。降分让用
户觉得"改完还不如我原来的简历"。bench 证据（uplift-v2、slim 系列）表明这类
下跌几乎总是尺子在饱和区的量化抖动：同一份改后简历重测在 {88,91} 间跳、
requirements matrix 零翻转、盲评 70-83% 判改后文档更好。判定"噪声还是真
回归"所需的证据——改后矩阵——rescore 服务端每次都算完扔掉（路由注释
原文预留了加宽口子）。

## 决策记录（逐项已确认）

| 决策点 | 选择 |
|---|---|
| 噪声性下跌（降分、矩阵无降级）显示 | "维持原分"：91 → 91（中性色）+ 小字 "Re-measured within the ruler's precision — every requirement holds; presentation improved" |
| 真降级处置 | 自动修复一次：复用 autoRefine 机器（matrix-informed 免费 refine，adopt-only-if-not-worse），把降级行喂给 TARGETED UPLIFT；修复后仍降级才照实显示双数字并点名降级行 |
| 修复触发范围 | **任何行降级 + 降分即触发修复**（owner 2026-09-06 放宽：接受 ~5-8% 的 run 延迟等待，换取"用户基本永远看不到降分"）。修复后残余 nice-to-have 降级 → 显示**左分** + 小字点名读弱的行（数字不降，说明保诚实）；残余 must-have 降级（修复+采纳门下预计 ≈0）→ 唯一照实显示低分的情形，点名该行并引导问题卡片 |
| 修复等待期 UI | 复用 WaitingTips（tips 轮换）+ 诚实的加倍用心文案（见 §5） |
| 不采用 | "分数会降就不改/少改简历"——盲评证明降分时文档通常更好，为仪器噪声丢弃更好的文档是让真价值给假信号让路；任何形式的分数注水 |

## 设计

### 1. rescore 响应加宽（服务端唯一改动）

`/api/rescore` 响应从 `{score}` 变为 `{score, rows: [{requirement, kind,
status}]}`——改后简历的矩阵状态，本来已计算。测量仪器（buildAnalyzeMessages
逐字调用、空 extraInfo、模型/温度/maxTokens）零改动。旧客户端只读 score，
向后兼容。

### 2. 矩阵对比（extension 新纯函数 compareMatrices）

左分 analysis.requirements_matrix vs rescore rows 逐行配对：token 重叠匹配
（≥0.5，bench 翻转检测器同款算法）。降级 = met→partially_met/missing 或
partially_met→missing。配不上的左侧行保守按降级处理。输出
`{downgrades: [{requirement, kind, from, to}]}`。纯函数、永不抛错、独立可测。

### 3. 三分支显示与修复策略（run.ts + Results.tsx）

| 情形 | 处置 | 延迟 |
|---|---|---|
| rescore ≥ 左分 | 照旧 `72 → 78` | 0 |
| 降分，无降级 | 右侧显示左分：`91 → 91`（中性色）+ maintained 小字 | 0（纯客户端对比） |
| 降分 + 仅 nice-to-have 降级 | 照实双数字 + 一行说明（点名该 nice-to-have 行） | 0 |
| 降分 + must-have 降级 | 自动修复一次（§4）；修复后按上面三行重判；仍 must-have 降级 → 照实双数字 + 点名降级行 | 仅此情形右侧数字 +45~55s（预计 <3% 的 run） |

首分/流式简历/下载在所有分支不受影响（判定全部发生在 done 之后的右数字车道）。

### 4. 修复腿（复用 autoRefine 机器）

触发：must-have 降级 + 降分。执行：既有 autoRefine 路径（同 runId 免费
tailor，带上左分 analysis 使 TARGETED UPLIFT 生效）→ rescore 重测 → 采纳
条件从"分数不更低"扩展为"分数不更低 **且** 无新增 must-have 降级"。单次，
不循环。quota：修复腿占既有免费腿预算（fresh 1-2 + 修复 3 + 用户 refine
4-5 ≤ 6；修复触发过的 run 再做第二次用户 refine 会计费——罕见×罕见，
接受并记录）。

### 5. 修复等待期 UI（用户体验要求）

- 修复腿在飞时（既有 `refining:true` 状态）：
  - 分数卡片显示诚实的加倍用心文案（替换现有 "Improving the rewrite…"）：
    **"Taking a second pass at your resume — N requirement(s) deserve a
    harder look. This usually takes under a minute."**（N = 降级行数）
  - 其下复用 **WaitingTips** 组件继续轮换求职/面试 tips（active 条件扩展：
    修复腿在飞时也激活），让等待有内容可看。
  - 右侧数字位显示占位（如脉动的 "…"），不显示中间的低分。
- 修复完成：按 §3 重判显示；WaitingTips 让位。

### 6. 验证

- 单测：compareMatrices（配对、降级分类、保守处理、不抛错）；三分支 +
  修复触发/采纳门的 run.ts 用例；面板 maintained 态、修复等待态、点名降级
  行的渲染。
- 回放验证：用 uplift-v2 / slim-ruler state 里的真实矩阵对跑 compareMatrices，
  人工核对配对率与降级判定（零 API 花费）。
- 验收：Expedia 91→88 活案例应变为 `91 → 91 · maintained`。

## 非目标

- 不改打分尺度、不做任何显示层之外的分数调整。
- 修复不循环（单次）；rescore 仪器不动。
- 网站二期。
