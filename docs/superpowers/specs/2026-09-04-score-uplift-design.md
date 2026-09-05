# 诚实提分链路（score uplift pipeline）设计

日期：2026-09-04
状态：已由产品负责人批准（对话中逐节确认）

## 问题

v0.2.0 起面板右侧的 match 分数是测量值：`/api/rescore` 用与 analyze 完全相同的
instrument（同 prompt、同模型、温度 0）给改后的简历重新打分。对同一组事实，
同一把尺子量两次理应得同一个分——bench 数据也证实诚实 tailor 后
`projected_match_score` 持平或略降（82→82、91→86、11→8）。但产品的核心卖点
要求：**每次 tailor 后右侧分数要肉眼可见地高于左侧（原简历）分数（+3~5 起），
且绝不通过编造达成**（no-fabrication 是产品的第一承诺，TAILOR_SYSTEM 刚为此
加固过并验证 0/30 编造标记）。

诚实提分只有两个物理来源：

1. **可读性**：简历里真实存在、但打分模型没认出来的证据（埋没、措辞与 JD
   对不上），把它写显眼后 requirement 的 status 会从 partially_met/missing
   翻成 met。
2. **新事实**：用户补充的真实素材（extra info / 定向提问的回答）是左侧测量时
   不存在的信息。

## 决策记录（逐项已确认）

| 决策点 | 选择 |
|---|---|
| 成功标准 | 肉眼可见提高（+3~5 起），当作核心卖点 |
| 杠杆 | ① tailor 看到 gap analysis；② 引导用户补充真实素材 |
| matrix 进 tailor 的方式 | 自动后台 refine（首屏并行架构不动） |
| 定向问题生成 | 前端直接渲染 matrix 的 missing/partially_met 行（零额外 LLM 调用） |
| 不采用 | 首次串行（首屏延迟是第一大抱怨）；改 rescore 测量方式（保持"同一把尺子"纯度）；放松打分尺度（与 no-fabrication 冲突） |

## 架构：三段一条线

```
首屏（不变）   analyze ∥ tailor → done 首绘
              左分 = analyze(原简历+extraInfo)，右分 = tailor 的投影分
第一段（新）   done 后插件自动发免费 refine：
              tailor(简历, JD, extraInfo, analysis=matrix) → rescore
              → 右分跳到测量值，UI 呈现 62 → 71
第二段（新）   面板把 matrix 里 missing/partially_met 行渲染成问题卡片
              （requirement + suggestion 字段 + 自由文本框）；
              用户回答 → 第二次免费 refine（extraInfo 追加回答）→ rescore
              → 右分再跳，UI 呈现 62 → 71 → 78
```

计费与限额恰好严丝合缝，全部复用现有机制，不改一行 quota 代码：

- `FREE_REFINES = 2`：自动 refine + 用户回答 refine，各占一次免费腿。
- `MAX_RESCORES_PER_RUN = 3`：初始 rescore + 两段各一次。
- runId 复用、IP rate limit、beta 门禁均不动。
- 每次 run 平台侧多付约一次 tailor + 一次 rescore（~$0.10），用户免费。

## 提分预期与坦白的边界

- 中等匹配（80~90 档）：第一段预期 +3~10（matrix 精确指出哪些行有真实但
  不可读的证据）。
- 高匹配（90+）：天花板效应，第一段可能只有 +1~3，第二段是主要空间。
- 低匹配（03-cross 那种个位数档）：第一段可浮的料少，预期 +2~4；第二段
  （新事实）是关键杠杆。
- **产品承诺由两段合力兑现**：UI 把分数呈现为一段旅程，而非承诺单次跳变。
  分数没动时 UI 解释原因（证据已充分呈现/缺硬性要求），不人为抬分。

## 代码改动面

1. **`src/lib/analysis.ts` — buildTailorMessages**：`analysis` 可选参数已存在
   （当前仅追加 "GAP ANALYSIS (for guidance)" 块）。为带 analysis 的场景加一段
   定向指令：对每个 partially_met/missing 行，若简历或 extra info 中确有支持
   证据，把该证据用 requirement 自己的词汇写显眼；确实没有证据的行绝不触碰。
   该指令置于可追溯性测试的约束之下（不得越过 no-fabrication 规则）。
2. **`src/app/api/tailor/route.ts`**：接受可选 `analysis` 字段，透传给
   builder。仅 refine 腿携带；无 analysis 的请求行为完全不变。
3. **插件 `extension/src/lib/run.ts`**：done patch 之后自动发起第一段 refine
   （复用 runId，带上首轮 analyze 的 matrix），完成后 patch `tailored` 与
   `rescoredScore`；失败静默降级（与现有 rescore 同姿态）。
4. **插件 panel**：
   - 分数卡片支持"旅程"态（62 → 71，加"提分中…"过渡态）。
   - 问题卡片列表：渲染 matrix 中 missing/partially_met 行，用户填写后触发
     第二段 refine。
5. **`/api/rescore` 不动**：保持 buildAnalyzeMessages 逐字调用、空 extraInfo、
   同模型同温度的"同一把尺子"纯度（路由注释已言明这是该端点唯一的性质）。

## 验证（bench，先测后上）

扩展 evaluator/bench，新增 **uplift 指标**：
`uplift = analyze-instrument(改后简历) − analyze-instrument(原简历)`，
三个 fixture × 5 trial，测三种条件：

1. **现状对照**：今天的平行 tailor（无 matrix）。预期 uplift ≈ 0，钉死基线。
2. **matrix-informed refine**：第一段的离线复现。目标见门槛。
3. **模拟用户回答**：02-staff 的 extra-info.txt 首轮扣下，refine 腿才注入，
   模拟"回答定向问题带来新事实"。预期显著大于条件 2。

**上线门槛**（全部满足才合并）：

- 条件 2 在 ≥2/3 的 fixture 上 uplift ≥ +3；
- 任何条件下 uplift 不显著为负（≤ −2 视为失败）；
- **refined 输出重新盲评，fabrication 标记必须保持 0/30**——matrix-informed
  正是"把 JD 措辞抄成经历"的最大诱惑场景，加固后的 TAILOR_SYSTEM 必须在
  该场景下复验；
- 盲评对比现状 tailor 输出，整体 win rate ≥ 40%（文笔不得因定向优化而劣化）。

预算 ~$2–3，走既有 seed-state / --resume 机制复用已付费的基线生成。

## 附录（2026-09-04 裁决）：门槛重新落位

首轮验证（$3.08，18 盲评）后 owner 裁决。事实：gate 3（fabrication 0/18）与
gate 4（refined win rate 83%）决定性通过；gate 1/2 未过的原因是结构性的——
01-billing 是诚实天花板（5/5 must-have 已满足，82→82 恒定），02-staff 是打分
器高分段饱和（对任何版本只输出 88/91，refined 与 current 逐 trial 同分而盲评
83% 偏好 refined，均值 −2 是尺子噪声）。03-cross（唯一有可读性空间的 fixture）
uplift +3.33 达标。按计划条款评估后判定 prompt 再迭代无效（瓶颈是尺子饱和，
不是指令强度），escalate 给 owner。

裁决：
1. 新增 `04-midmatch` fixture（50~70 分、证据埋没的中等匹配——产品核心人群）
   作为提升门槛（gate 1/2）的真正载体；01-billing 与 02-staff 降级为**天花板
   对照组**（预期 uplift ≈ 0，不再计入 gate 1/2）。gate 3/4 继续覆盖全部
   fixture。fixture 撰写约束：埋没的证据必须真实存在于简历事实中，不得为达标
   预埋关键词；fabrication 判定继续由盲评把关。
2. 产品 UI 对天花板情形显示诚实解释（如"已达上限：N/N 硬性要求均已满足"），
   而不是让右分纹丝不动显得像功能失效。"+3~5 每次"从普适承诺改为"有诚实
   提升空间时必然兑现"。

## 非目标

- 不改 analyze 打分尺度、不做任何形式的分数校准/加成。
- 不做首次串行。
- 不用 LLM 生成定向问题（第一期用 matrix 行直渲；问法生硬再迭代）。
- 不在 rescore 响应里新增 requirements 矩阵回传（面板尚无处安放）。
