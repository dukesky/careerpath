# 延迟优化：瘦身 + 去串行 + 流式（单尺不变）设计

日期：2026-09-05
状态：已由产品负责人逐节确认（对话中）
前置：2026-09-04-score-uplift-design.md（提分链路）、careerpath-worker-eviction-fix（keepalive 已上线）

## 问题与目标

真实用户轨迹（cp_run_log 实测，Expedia 长 JD）：点击 → 匹配分出现 68s → 简历
78s → 右分（rescore）139s。目标（负责人裁定）：**1 分钟内出全部结果，且以
流式形式各 section 逐次出现**；等待期间展示预写的求职 tips 消磨时间。

延迟解剖：瓶颈不是模型"思考"，是**输出 token 长度**（sonnet ~55 tok/s，
analyze 一次吐 ~2800 token ≈ 50s）+ 串行 parse 跳（9s）+ rescore 又是一整次
analyze。

## 决策记录（逐项已确认）

| 决策点 | 选择 |
|---|---|
| 一分钟时屏幕上有什么 | 全部：分数、矩阵、完整简历、右分 |
| 呈现方式 | 流式，各 section 逐次出现 |
| 尺子 | 单尺不变式换尺：瘦身 ANALYZE_SYSTEM 输出；rescore 逐字调用同一 builder 自动跟随，路由零改动 |
| 模型 | 全保留 sonnet（60s 目标下不需要换模型；haiku 臂砍掉） |
| 范围 | 先插件；服务端改动对网站向后兼容（缓冲 JSON 路径保留） |
| 等待体验 | 预写 tips 卡片随机轮换（第 8 节） |

## 关键巧合（架构基石）

analyze 的 JSON schema 首字段是 `overall_match_score`——模型总是最先生成它。
**只要流式传输，匹配分在 ~6–9s 即可上屏**，无需任何"快尺"双腿架构。同理
简历 JSON 按 contact→summary→experience 顺序生成，流式即天然的分段呈现。

## 设计

### 1. 瘦身 ANALYZE_SYSTEM（唯一换尺点）

输出压到 ~1400 token（≈25–30s）：rationale ≤2 句；每行 evidence ≤15 词、
suggestion ≤15 词；strengths 3 条；gaps ≤3 条短 mitigation。schema 字段与
字段顺序不变（score 首位是流式提分的前提，加注释钉住）。判分人格、诚实校准
条款一字不动。

`/api/rescore` 不改一行：它逐字调用 `buildAnalyzeMessages`，瘦尺自动跟随，
"同一把尺子"由构造保证。

### 2. 去串行 parse（raw JD 输入形态）

`buildAnalyzeMessages` / `buildTailorMessages` 新增 raw JD text 输入形态
（`--- JOB DESCRIPTION (raw text) ---` 块，capText ≤10k，替代 ParsedJD
JSON 块）；两个路由接受 `jdText` 作为 `structuredJD` 的替代输入。插件不再
调 `/api/parse-jd`（路由保留给网站）；UI 需要的 title/company 已来自客户端
抽取的 ExtractedJD。省 9s 串行 + 每 run ~$0.004。

### 3. tailor 输出瘦身

change_log 压成单行条目：original/revised 各 ≤10 词、reason 一短句。简历
本体不动。输出 ~2500→~1600 token（≈30s）。TAILOR_SYSTEM 的可追溯性测试、
失败模式清单、反标签升级条款**一字不动**。

### 4. 流式传输

- 服务端：`/api/analyze`、`/api/tailor` 接受可选 `stream: true` → SSE
  （OpenRouter `stream: true` 透传 delta；结束帧带服务端 normalize 后的完整
  JSON 作为权威结果）。未传 `stream` 的调用行为逐字节不变（网站兼容）。
  JSON-retry 逻辑：流式首次失败时退化为缓冲重试一次（复用现有 retry 语义）。
- 插件端：容错的部分-JSON 增量提取（score → rationale → matrix 行逐条 →
  简历逐段）。**流式是纯呈现层**：任何解析异常静默退回"等结束帧完整渲染"，
  正确性只依赖结束帧。RunState 增加流式暂存字段；缓存与计费路径不变。
- rescore 一期保持缓冲（右分 ~55s 达标）；流式化留作后续可选。
- keepalive 心跳已就位，覆盖流式长连接。

### 5. 插件运行流

```
点击 ──┬─ /api/analyze (stream)  score ~6-9s → rationale → matrix 行逐条
       └─ /api/tailor  (stream)  简历 ~6s 起逐段，~30s 完整可下载
tailor 结束帧 → /api/rescore（缓冲）→ 右分 ~55s
```

quota 腿算术不变（analyze+tailor 仍是仅有的两条计费腿）；runId、refine、
问题卡片、autoRefine 开关全部不动。

### 6. 预期时间线（对照实测基线）

| 事件 | 现状 | 目标 |
|---|---:|---:|
| 匹配分出现 | ~68s | ~6–9s |
| 矩阵状态行 | ~68s | 8–30s 逐条 |
| 简历开始出现 | ~78s | ~6s |
| 简历完整可下载 | ~78s | ~30s |
| 右分（rescore） | ~139s | ~55s |

每 run 成本约降 30%（输出 token 少了 ~40% + 免掉 parse 调用）。

### 7. 验证（bench + 实测，~$3–4）

1. **瘦尺校准**：瘦尺 vs 旧尺，4 fixture × 3：排序一致；同输入 3 次重复散布
   ≤±2；对新事实（elicitation 条件）仍响应；对纯措辞改写不奖励（已有先例
   数据，复验）。
2. **tailor 重判**：raw-JD 输入 + 瘦 change_log 的输出 vs 现网输出盲评：
   fabrication 0、win rate ≥40%。
3. **端到端延迟实测**：面包屑时间戳，长 JD 上 p50 首分 ≤10s、完整简历
   ≤35s、右分 ≤60s。

### 8. 等待期 Tips 卡片

预写求职/面试小贴士，随扩展打包（零网络、零 LLM）：~24 条英文产品文案，
四类（投递策略/简历/面试准备/跟进），实现期撰写并过一遍产品口吻审校。
展示规则：run 进行中且屏幕尚无实质内容（分数未出、简历未开始）时显示，
每 ~8s 轮换，会话内洗牌不重复；分数或简历首段一出现即让位隐藏；轻卡片
样式（图标 + 一句话），淡入淡出。纯前端组件 + 静态数组，独立可测。

## 附录（2026-09-05 终裁）：验证门槛的重新落位

四轮 prompt 迭代 + 一次判官准则重切（$6.1 bench 花费）后 owner 裁决。事实链：

- **安全面全部达标且两至三轮复验**：fabrication 0/24（首轮 raw-JD 引发的跨角色
  bullet 搬运由新增的 CROSS-ROLE ATTRIBUTION 失败模式根治，canary 机检人检
  连续清零）；change_log 条目准确率 48/50（幻觉性"位置移动"条目由"只记内容
  改动"契约根治）；内容重复 bug 已修。
- **瘦尺校准通过**：四 fixture 排序与旧尺一致、温度 0 三重复零散布、
  elicitation 响应 +7.67。注意点：ParsedJD 形态下 04-midmatch 绝对分下移
  10（排序不变）；插件左右腿同用 raw 形态，网站两腿同用 parsed 形态，
  各自内部一致。
- **延迟兑现**：analyze 完成 token 均值 ~1560-1760（长 JD 因矩阵行数未设上限
  高于 1400 预算），投影全量 ~31-35s；tailor 实测均值 21s；首分 = 流式首字段
  ~6-9s。
- **pairwise win-rate 门（0.40）四轮未过（0.38/0.27/0.23/0.27）且被证明不可
  达**：coverage 20 平 4 负 0 胜（文档实质等价，ties-half 数学上到不了 0.5）；
  17 个 change_log 判负中 15 个判词承认双方准确、14 个以详尽度为由判负——
  重切为"只测准确性"的准则也拦不住 LLM 判官的详尽度偏好。要过此门只能
  重新灌胖输出（毁延迟目标）或继续操纵判官（无效且不诚实）。

裁决：对"瘦身输出 vs 存量胖输出"的对比，pairwise win-rate 退役，不再作
门槛（历史数据保留于 task-9* 报告）；改用机械指标为门，三项均已达标：

1. fabrication 0/24（盲评，双序）✅
2. change_log 逐条准确率 ≥95%（机检 + 人检：48/50 = 96%）✅
3. must_have_coverage 平局率 ≥80%（20/24 = 83%）✅

残余 cosmetic（不阻合并，排后续任务）：prompt 同时说"要重排"与"不记录重
排"存在张力，模型仍会写准确的位置条目（20/50，19 条准确）；readability
判官偏好 ~0.38（四轮稳定，风格性 tie-break，无实质缺陷指认）。

## 非目标

- 不换模型、不加"快尺"双腿、不加新打分路由。
- 不动 /api/rescore、quota、refine/问题卡片链路。
- 网站流式接入是二期（服务端本期已兼容）。
- rescore 流式化暂缓。
