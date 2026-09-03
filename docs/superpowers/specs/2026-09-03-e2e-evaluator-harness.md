# E2E Evaluator Harness — 规格（主 agent 撰写，执行 agent 实现）

**日期：** 2026-09-03
**背景文档：** 交接文档《后台生成不扣用户额度（未解决）》（本 spec 自包含，无需读它也能实现）
**角色分工：** Fable 5（主 agent，本 spec 作者）→ Opus（执行 agent，实现本 spec）→ Sonnet（evaluator agent，运行产物并独立审计）

---

## 1. 要解决的测量问题

本项目的特征性失败模式：**391 个单元测试全绿、tsc/lint/build 全过、部署成功，但功能在真实浏览器里是坏的**，且已连续发生三次。当前未解决的 bug：

> Chrome 扩展登录用户点击 "Tailor my resume" 后，生成成功完成，但面板的 "5 runs left today" 永远不减。怀疑后台运行实际以匿名设备身份（`did` claim）而非用户身份（`uid` claim）计费，或 run token 从未被铸造/使用。

单元测试无法回答这个问题。需要一个**在真实 Chromium 中加载真实扩展、走完真实生成链路、断言端到端可观测结果**的评测工具。本 spec 定义该工具。

**本任务只构建测量工具，不修产品代码。** 如果构建过程中发现必须改产品代码才能测量，写入 `evaluator/BLOCKERS.md` 并停止，不要自行修改 `src/` 或 `extension/src/`。

## 2. 被测链路（已由主 agent 通读源码确认）

1. 面板 `generate()`（`extension/src/sidepanel/App.tsx:534`）调 `fetchRunToken()`（`extension/src/lib/runToken.ts`）。
2. `fetchRunToken` 先 `isSignedIn()`，登录则 `apiPost("/api/run-token")`（携带面板的 Clerk session Bearer）换取 15 分钟 HS256 JWT（`uid` claim）。
3. token 随 `{type:"start-run", runToken}` 消息进 service worker（`extension/src/background/runs.ts`），透传给 `runTailor`（`extension/src/lib/run.ts`），作为 `overrideToken` 附在 parse-jd / analyze / tailor 三个请求的 `Authorization: Bearer` 上（`extension/src/lib/api.ts`）。
4. 服务端 `resolveCaller`（`src/lib/auth.ts`）认出 `uid` → user caller；`consumeRun`（`src/lib/quota.ts`）对 `quota:user:{userId}:{day}` 计一次。
5. 面板额度显示来自 `GET /api/quota`（登录用户 limit=5/天；匿名设备 limit=3/30 天）。

三个 API 调用发自 **service worker**，不会出现在面板页面的网络记录里；`POST /api/run-token` 发自**面板**。

## 3. 测试环境（全部本地，不碰生产）

- **服务端：** `npm run dev`（仓库根），端口 3000。本地无 Upstash 环境变量 → KV 是进程内内存实现（单进程下 runId 去重语义正确）。`.env.local` 已有 `CLERK_SECRET_KEY`（dev 实例）、`OPENROUTER_API_KEY`、`DEVICE_TOKEN_SECRET`。**harness 负责启停 dev server**（子进程，就绪探测 `GET /api/quota`，退出时杀掉）。
- **扩展：** `npm run build:dev`（`extension/`）产出 dev 构建，`API_BASE=http://localhost:3000`，Clerk 用 dev 实例 `pk_test_ZmFpci1sZW11ci0zNC5jbGVyay5hY2NvdW50cy5kZXYk`（`fair-lemur-34.clerk.accounts.dev`）。
- **浏览器：** Playwright chromium，`launchPersistentContext`，`--load-extension=<extension/dist 绝对路径> --disable-extensions-except=<同>`。headless 用 `headless: false` + `xvfb` 不需要（macOS 直接有屏），可用 `channel: "chromium"` 新 headless 模式（支持扩展）；先试新 headless，不行就 headed。
- **登录：** Clerk **dev 实例默认开启 test mode**：邮箱含 `+clerk_test` 的账号（如 `evaluator+clerk_test@example.com`）用固定验证码 `424242` 完成 email-code 登录/注册，不需要真实邮箱和密码。先读 `extension/src/signin/` 了解登录页 UI 再写自动化。**严禁自动化任何生产账号、Google OAuth 或真实密码。**
- **LLM 成本：** 每次生成 ≈ 3 次真实 OpenRouter 调用（~$0.11）。单次 eval 全流程（含 mutation）**上限 4 次生成**。JD fixture 和种子简历要短（各 <2KB 文本），压低 token。

## 4. 目录与产物

```
evaluator/
  package.json          # 独立包，deps: playwright（并 npx playwright install chromium）
  run-eval.mjs          # 主入口：node run-eval.mjs [--mutation=stale-build|hang-tailor]
  lib/                  # 需要拆的辅助模块
  fixtures/
    jd.html             # 本地岗位页 fixture（静态 HTTP 由 harness 起一个小服务器供给）
    resume.json         # 种子 StoredResume（读 extension/src/lib/storage.ts 确定形状）
  reports/              # 每次运行一个 <ISO时间戳>.json + .md，gitignored
  profile/              # 浏览器 profile，gitignored（每次 eval 用全新临时 profile）
  EVALUATOR.md          # 运行手册：怎么跑、每个断言的含义、怎么读报告
  BLOCKERS.md           # 仅在被阻塞时创建
```

根 `.gitignore` 增加 `evaluator/profile/`、`evaluator/reports/`、`evaluator/node_modules/`。

## 5. Eval 流程与断言

### 5.1 前置自检（任一失败 → verdict=CANNOT_MEASURE，绝不报 PASS）

- **P1 构建新鲜：** 运行 `npm run build:dev` 成功；`extension/dist` 的面板 bundle 中 grep 到 `run-token`（当前代码特征）且 grep 到 `localhost:3000`。
- **P2 服务可用：** dev server 就绪；匿名 `GET http://localhost:3000/api/quota` 返回 2xx。
- **P3 无 beta 旁路：** 全新 profile（保证 `cp_beta_code` 不存在）；登录后面板额度显示为数字（limit 5），不是 unlimited。
- **P4 登录态确立：** 面板显示登录邮箱。

### 5.2 主断言（核心是端到端可观测结果，不是任何中间信号）

准备：打开 JD fixture 页作为活动标签页；把 `fixtures/resume.json` 种进 `chrome.storage.local`（读 `storage.ts`/`fingerprint.ts` 确定键与指纹一致性）；打开面板页 `chrome-extension://<id>/src/sidepanel/index.html`（普通标签页形式；`useActiveJd.ts` 读活动标签页，需安排好窗口/标签布局，必要时点面板的授权按钮 —— 读 `useActiveJd.ts` 和 `manifest.config.ts` 决定布局）。

- **A1（铸造）：** 点击 "Tailor my resume" 后，面板页网络记录中出现 `POST /api/run-token` 且 200、响应含非空 `token`。用 `page.on("response")` 捕获。
- **A2（身份，最决定性）：** service worker 发出的 `/api/analyze` 请求的 `Authorization` Bearer JWT payload 含 `uid`，无 `did`。捕获方式按优先级：(a) 环境变量 `PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1` + `context.route`/事件监听 worker 请求；(b) 对 worker target 开 CDP session 用 `Network.enable`。两条都失败则此断言记 `UNMEASURED`（不算失败），靠 A3+A4 间接判定。
- **A3（用户桶扣减，核心断言）：** 生成完成后，面板额度显示从 `5 runs left today` 变为 `4 runs left today`（等 UI 刷新，或触发面板刷新逻辑）。这是唯一不可作弊的端到端结果。
- **A4（设备桶未动）：** 登录运行期间设备桶不该被碰。生成完成后登出（面板 Sign out），面板显示设备额度 `3`（满额）。若显示 <3，说明运行实际计到了设备桶 → FAIL 并在证据里标明。
- **A5（超时上限）：** 单次生成从点击到 done ≤ 180s，超时即 FAIL（换模型事故正是靠这个才能被抓住）。
- **A6（匿名路径未被 gate）：** 登出状态下点击生成，运行正常完成（设备身份，设备桶 3→2）。登录是升级，不是门槛 —— 这是硬约束的回归。

### 5.3 自我证伪（evaluator 必须先证明自己会失败，否则不可信任）

- **M1 `--mutation=stale-build`：** 用 `git worktree add` 在 commit `d19021d`（扩展侧 run-token 改动之前）构建 `build:dev` 的 dist，其余流程不变。这精确重现"用户浏览器装了旧包"场景。预期：A1 无请求、A3 额度停在 5 → 整体 verdict=FAIL。**若此模式报 PASS，evaluator 本身是坏的。**
- **M2 `--mutation=hang-tailor`：** 对面板+worker 的 `/api/tailor` 路由拦截并永不响应（能拦到 worker 就拦，拦不到就在 harness 起的反向代理层做 —— 简单方案：dev server 前不加代理，改为拦截面板可拦的层；若 worker 请求不可拦截，此 mutation 允许降级为直接把 A5 阈值调成 5s 跑一次真实生成来验证超时判定逻辑）。预期：A5 超时 → verdict=FAIL。

### 5.4 报告

`reports/<ts>.json`：`{ verdict: "PASS"|"FAIL"|"CANNOT_MEASURE", preflight: {...}, assertions: {A1..A6: {status, evidence}}, timings, mutation, screenshots: [...] }`。同名 `.md` 给人读。每个失败断言必须附证据（网络记录摘录、JWT payload、额度前后值、截图路径）。

## 6. 实现约束

- 全部新代码在 `evaluator/` 内；产品代码（`src/`、`extension/src/`）**零改动**。
- 代码与注释英文（项目惯例）。
- 陷阱（来自前几轮的实际教训）：
  - `runLog` 会丢条目，不要把它当证据源。
  - worker 的三次 API 调用不在面板网络记录里。
  - 额度断言前必须确认无 beta code（P3）。
  - 面板以标签页打开时 `chrome.runtime`/`chrome.storage`/worker 全是真的，链路有效。
  - 扩展 ID 由 manifest `key` 钉死为 `epofgiefihhmbjhojdeffkdkhocjfpaf`（如 dev 构建同 key，URL 稳定；实测为准）。
- 完成定义：`node run-eval.mjs` 无 mutation 跑通全流程并产出报告（不论 verdict 是 PASS 还是 FAIL —— **verdict 本身就是我们要的证据**）；两个 mutation 模式都能产出预期的 FAIL。把三份报告都留在 `reports/`。
