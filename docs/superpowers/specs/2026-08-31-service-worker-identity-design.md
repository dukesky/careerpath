# Service Worker 身份修复 — 设计文档

**日期：** 2026-08-31
**分支：** feat/extension-page-access
**状态：** 待实施

---

## 目标

让后台 service worker 里的生成以**登录用户的身份**向服务端发请求，而不是以设备身份。

一句话：`session.ts` 的 Clerk token source 只在面板里被装载过，worker 里从来没有，所以 worker 发出的每一个请求都带设备令牌。

---

## Bug 的精确位置与证据

### 机制

`extension/src/lib/session.ts:46` 声明了一个模块级可变变量：

```ts
let clerkTokenSource: ClerkTokenSource = async () => ({ signedIn: false });
```

全仓库只有一处会替换它 —— `extension/src/sidepanel/App.tsx:379` 的 `installClerkTokenSource()`。

**service worker 是独立的 JS realm。** 它加载的是 `session.ts` 的另一个模块实例，其中 `clerkTokenSource` 始终是上面那个默认值。于是 `currentAuthToken()` 在 worker 里必然走到最后一行：

```ts
const device = await ensureToken();
return device ? { kind: "device", token: device } : null;
```

`extension/src/background/index.ts` 从头到尾没有 import 过 `installClerkTokenSource`。

### 为什么现在才暴露

上一轮计划把**所有**生成从面板搬进了后台（`background/runs.ts` 的 `startRun`）。在那之前生成跑在面板里，身份是对的。搬家之后，**每一次生成都变成了设备身份**。

### 症状如何被精确预测

服务端 `src/lib/auth.ts:107` 的 `resolveCaller` 优先级是：登录用户 > 设备令牌 > 匿名。
`src/lib/quota.ts:19-20`：`DAILY_USER_LIMIT = 5`（user 桶，每天），`DEVICE_TRIAL_LIMIT = 3`（device 桶，30 天内共 3 次）。

面板的 `fetchQuota()` 走 `apiGet("/api/quota")`，用的是**面板 realm** 的 token source —— 那里 Clerk 身份是装好的，所以服务端把它解析成 `user`，返回 5。

worker 的生成走**设备**身份，消耗的是 `device:<id>` 桶，`user:<id>` 的每日计数从来没动过。

**所以面板永远显示 "5 runs left today"，无论生成多少次。** 这与用户报告的现象完全一致。

### 安全影响

用户的额度根本没有记账。任何人清掉扩展的 storage 就能重置设备桶，等于无限使用。

---

## 已在 SDK 源码中核实的事实

以下全部读自 `extension/node_modules/@clerk/chrome-extension`（版本 3.1.72），不是推测。

1. **专用入口存在。** package.json 导出 `./background`，其 `createClerkClient` 强制 `background: true`：
   ```js
   // dist/esm/background/index.js
   function createClerkClient2(opts) {
     return createClerkClient({ ...opts, background: true });
   }
   ```

2. **background 客户端自己调用 `load()`**（`dist/esm/chunk-FZWZHFF3.js`）：
   ```js
   const clerk2 = createClerkClient({ ...rest, scope: SCOPE.BACKGROUND });
   return clerk2.load({ standardBrowser: false }).then(() => clerk2);
   ```
   **实施约束：不得再调用一次 `load()`**，也无法传入 `allowedRedirectProtocols` / redirect URL。worker 不做跳转登录，因此无影响。

3. **manifest 要求已全部满足。** `validateManifest` 在 background scope 下只检查三项：根级 `permissions`、`permissions.storage`、根级 `background`。三项当前都存在。**manifest 无需任何改动。**

4. **不需要 `cookies` 权限。** `getClientCookie` 只在 `shouldSync(sync)` 为真时调用，而 `sync = Boolean(syncHost)`；本项目不传 `syncHost`。这与 `manifest.config.ts:98-108` 已有的判断一致。

5. **session JWT 存在共享存储中。** `BrowserStorageCache` 使用 `browser.storage.local`，键为 `createKey(frontendApi, "__clerk_client_jwt", "v2")`，即 `clerk.career-allpath.com|__clerk_client_jwt|v2`。面板、登录页、worker 三者读写同一份，**因此登录页登录后 worker 立即可见，无需任何消息传递**。

6. **worker 不会拉到 `@clerk/ui`。** 那个重包只在非 background 分支里 `await import('@clerk/ui/no-rhc')`，是动态 import，打包后是独立 chunk，background 路径永不请求。

---

## 架构

### 核心设计原则：三态语义只能存在一份

真正的风险不是"在 worker 里造一个 Clerk client"（那是十几行代码），而是 `lib/clerk.ts:137-175` 里那套经过多轮 review 磨出来的语义：

- `{signedIn:false}` 与 `{signedIn:true, token:null}` **必须分开**。合并两者正是那个"已登录用户静默降级为设备身份"的原始 bug，`session.ts` 的 `ClerkAuthState` 类型就是为此存在的。
- Clerk 不可达时的**不对称处理**：本机从未登录过 → 走设备身份（匿名用户在 Clerk 故障期间必须继续可用）；本机登录过 → 抛错拒绝（不能拿用户的设备额度去顶）。

若在 worker 里再抄一份，两份必然漂移。本仓库已被"同一常量写在两处、无编译期约束"坑过三次。

**因此：把三态语义抽成一个共享工厂，面板与 worker 各自只提供"如何拿到 client"。**

### 文件结构

| 文件 | 状态 | 职责 |
|---|---|---|
| `extension/src/lib/clerkTokenSource.ts` | **新建** | 共享的三态 source 工厂。**不 import 任何 Clerk SDK**，只依赖一个结构化的 `ClerkLike` 接口 |
| `extension/src/lib/clerk.ts` | 修改 | 删除内联的 source 逻辑，改为调用共享工厂；面板的 client 构造逻辑原样保留 |
| `extension/src/background/identity.ts` | **新建** | 用 `@clerk/chrome-extension/background` 构造并缓存 client；把共享 source 装进 worker realm |
| `extension/src/background/runs.ts` | 修改 | `startRun` 在返回 `{started:true}` 之前做身份检查 |
| `extension/src/background/index.ts` | 修改 | 模块作用域装载 token source |
| `extension/src/sidepanel/App.tsx` | 修改 | 处理新的拒绝理由 |

### 共享工厂的接口

```ts
// lib/clerkTokenSource.ts

/** The structural subset of Clerk's client this module needs. Declared
 *  structurally so this module imports no Clerk SDK code — which is what lets
 *  the service worker use it without pulling the panel's DOM-bound client. */
export interface ClerkLike {
  isSignedIn: boolean;
  session: { getToken(): Promise<string | null> } | null | undefined;
}

export function makeClerkTokenSource(
  getClient: () => Promise<ClerkLike>,
): ClerkTokenSource;
```

装配：

- 面板：`setClerkTokenSource(makeClerkTokenSource(getClerk))`
- worker：`setClerkTokenSource(makeClerkTokenSource(getBackgroundClerk))`

`getHasSignedIn` / `setHasSignedIn` 的读写留在工厂内部，两边共享同一份行为。

### `getBackgroundClerk()` 的记忆化契约

必须与 `lib/clerk.ts:70-102` 的既有行为一致，**包括失败时的重置**：

- 存储的是 **promise** 而非已解析的 client，使并发调用共享同一次 `createClerkClient()`。
- **在 rejection 时清空记忆化的 promise，成功时不清。** 这条不是可有可无的整洁：worker 虽然会被回收，但在一次唤醒的生命周期内可以服务多次生成。若不重置，worker 冷启动时一次偶发的 Clerk 不可达，会毒化该 worker 余下生命周期内的每一次请求 —— 已登录用户的每次生成都被拒绝，而原因只是一次早已过去的瞬时故障。`lib/clerk.ts` 的注释详细记录了这一点，worker 侧不得遗漏。
- 与下文"登出后的陈旧客户端"里的 `chrome.storage.onChanged` 失效逻辑作用于同一个 promise 变量。

---

## 数据流

### 后台生成的身份获取

```
面板点击 Tailor
  └─> chrome.runtime.sendMessage({type:"start-run", ...})
        └─> background/index.ts 的 onMessage
              └─> startRun()
                    ├─> currentAuthToken()            ← 身份检查（新增）
                    │     └─> worker realm 的 source
                    │           └─> getBackgroundClerk()
                    │                 └─> createClerkClient({publishableKey})
                    │                       从 @clerk/chrome-extension/background
                    │                       （内部自行 load()，读 storage.local 里的 JWT）
                    ├─> 若 session_unavailable → 发布 session_expired 状态并拒绝
                    └─> 否则照常启动，run 内的每次 fetch 都带 Clerk token
```

### 装载时机

`background/index.ts` 在**模块作用域**调用装载函数。理由：

- 模块作用域在每次 worker 唤醒时先于任何 message handler 执行，因此 `startRun` 一定能看到已装载的 source。
- 装载本身不加载 Clerk —— client 是在第一次索要 token 时才由 `getBackgroundClerk()` 惰性创建。因此模块作用域的成本为零，不影响 worker 冷启动。

---

## 错误处理

### 启动前拒绝（本次的行为变更）

`startRun` 在返回 `{started:true}` 之前调用 `currentAuthToken()`：

- 返回 `{kind:"session_unavailable"}` → **不启动**
- 其他（`clerk` / `device` / `null`）→ 照常启动。`null` 表示连设备令牌都铸不出来，请求将不带 `Authorization` 头发出，服务端按 `anon` 处理 —— 这是既有的合法路径，不在本次改动范围。

**检查的位置：在 `already-running` 与 `at-capacity` 两项检查之后，在铸造 runId 和发布 `reading` 状态之前。**

顺序是有意的，不可调换：那两项检查是纯本地读取，成本可忽略；身份检查可能触发一次 Clerk `load()` 的网络往返。若把身份检查放在最前，一个已在运行的 posting 被重复点击、或已达五个并发上限的点击，都会白白付出一次 Clerk 加载。同时这个顺序也保证 `already-running` 仍然优先 —— 那条路径要让面板去渲染既有 run 的进度，不该被身份问题打断。

匿名用户不受影响：从未登录过的浏览器上，共享工厂返回 `{signedIn:false}`，`currentAuthToken()` 给出设备令牌，运行照旧。**登录始终是增强，不是门槛** —— 这是既有的约束，本设计不改变它。

### 拒绝时如何呈现

`startRun` 在拒绝前**先发布一个 error 状态**到 `liveRuns`：

```ts
{
  phase: "error",
  error: {
    kind: "session_expired",
    message: "We couldn't confirm your session. Sign in again to continue.",
  },
}
```

措辞与 `lib/api.ts:84-89` 对同一情况的措辞保持一致。

这样做的原因：面板已有的"Sign in again"按钮（`App.tsx:796`）的渲染条件是
`state.phase === "error" && state.error?.kind === "session_expired"` —— 它读的是**运行状态**，不是启动返回值。发布状态即可自动复用这条已有的 UI 路径，面板几乎不用改。

`StartRunResult` 新增一个理由：

```ts
| { started: false; reason: "at-capacity" | "already-running" | "failed" | "session-expired" }
```

面板对 `session-expired` 的处理**与 `already-running` 相同 —— 什么都不说**。原因和既有注释里写的完全一致：紧随其后的 `refreshDisplay(false)` 会把刚发布的状态渲染出来，那条状态连同"Sign in again"按钮比任何一句 notice 都说得清楚。若不加这条分支，它会落进 `COULD_NOT_START_NOTICE`，用户会同时看到一句无用的"Couldn't start that run"和一个登录按钮。

### 登出后的陈旧客户端

worker 会缓存已 load 的 client。用户在面板登出后，缓存实例仍然认为自己已登录。

**处理：** `background/identity.ts` 注册 `chrome.storage.onChanged` 监听，当发生变化的键名包含 `__clerk_client_jwt` 时丢弃缓存的 client promise。

- 覆盖登出、登录、token 刷新三种情况，无需消息传递。
- 匹配子串而非完整键名，因为完整键名含 frontendApi，随环境不同。
- **万一 Clerk 改了这个内部常量导致漏匹配**，退化路径是：陈旧 token → 服务端 401 → `api.ts:110-116` 已有的 `session_expired` 处理。**退化为既有的正确行为，不会退化成记错账。** 这是本条设计可以接受子串匹配的前提。

### Clerk 不可达

沿用共享工厂里的既有不对称逻辑，worker 与面板行为一致：从未登录过 → 设备身份；登录过 → 抛错，`currentAuthToken()` 报 `session_unavailable`，`startRun` 拒绝。

---

## 测试

### 必须有的断言

1. **共享工厂的三态**（从 `lib/__tests__/clerk.test.ts` 迁移/扩展）
   - `isSignedIn:false` → `{signedIn:false}`
   - `isSignedIn:true` 且有 token → `{signedIn:true, token}`
   - `isSignedIn:true` 但 `session` 缺失或 `getToken()` 返回 null → `{signedIn:true, token:null}`（**不是** `{signedIn:false}`）
   - client 获取失败 + 从未登录过 → `{signedIn:false}`
   - client 获取失败 + 登录过 → 抛出

2. **worker 确实装载了 source。** 断言 `background/index.ts` 被 import 后，`session.ts` 的 source 不再是默认值。这是本次 bug 的直接回归测试 —— 没有它，同样的遗漏可以再次发生且全部测试通过。

3. **`startRun` 的身份检查**
   - `session_unavailable` → 返回 `{started:false, reason:"session-expired"}`，且发布了一条 `kind:"session_expired"` 的 error 状态
   - 匿名（设备令牌）→ 正常启动，**不被拒绝**
   - 已登录（clerk token）→ 正常启动

4. **面板对 `session-expired` 保持静默。** 断言收到该理由时 `setNotice` 未被调用。

5. **import 入口正确。** 断言 `background/identity.ts` 从 `@clerk/chrome-extension/background` 而非 `/client` import。走错入口只会在真实浏览器里失败（非 background 分支需要 DOM），单元测试不会发现。

### 已有测试的影响

`sidepanel/__tests__/App.test.tsx:883` 断言 `installClerkTokenSource` 在 mount 时被调用一次。若重构改了该导出的名字，此断言需同步更新 —— 它保护的性质（面板必须装载 source）应当保留。

---

## 明确不在本次范围内

- **`DAILY_USER_LIMIT` 的数值。** 修复后每天 5 次会真正生效，开发者自测很快会用完。这属于 promo code / 额度分层那个独立待办，本次不动。
- **打分逻辑**（fit + presentation 双分量）。已单独商定，是下一个 spec。
- **`lib/runLog.ts` 临时诊断代码**的移除。
- **已消耗的设备额度**不做迁移：修复后登录用户走 user 桶，旧的 device 桶残值不再影响他们。

---

## 风险

| 风险 | 缓解 |
|---|---|
| background client 在真实 MV3 worker 中的行为与预期不符 | manifest 三项要求已逐条核实；`load()` 由 SDK 自行调用这一点已从源码确认。仍需真实浏览器验证 —— 这是本仓库反复出现的一类问题（"测试全绿、浏览器里坏掉"）。 |
| 重构 `clerk.ts` 破坏面板已有的登录流程 | 面板的 client 构造逻辑（含 `allowedRedirectProtocols`、redirect URL）原样保留，只把 source 函数体移走。已有的 clerk.test.ts 断言迁移后继续保护三态语义。 |
| worker 冷启动时 `load()` 的网络往返拖慢首次生成 | 只发生在 worker 冷启动后的第一次生成，且发生在用户点击之后、run 开始之前；相对于一次约 60 秒的生成可以忽略。 |

---

## 验收标准

在真实浏览器中：

1. 登录后生成一次，面板的 "runs left today" 从 5 变为 4。
2. 连续生成，该数字持续下降，用尽后服务端返回 402。
3. 登出后生成，走设备身份，匿名流程照常可用。
4. 登录状态下把 Clerk 的 JWT 从 storage 中清掉再点 Tailor，**立即**看到"Sign in again"，而不是等约 40 秒后报错。
