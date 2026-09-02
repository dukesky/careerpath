# Run Token —— 让后台运行以登录用户身份计费

**日期：** 2026-09-02
**分支：** feat/extension-page-access
**状态：** 待实施
**取代：** `2026-08-31-service-worker-identity-design.md`（该设计的核心假设被真实浏览器证伪）

---

## 目标

让后台 service worker 里的生成以**登录用户的身份**向服务端发请求，从而真正扣减用户额度。

验收只有一条：**真实浏览器里，登录后跑一次生成，面板的 "runs left today" 从 5 变成 4。**

---

## 上一版设计为什么失败

上一版让 worker 自己持有一个 Clerk 客户端，依据是"面板、登录页、worker 共享 `chrome.storage.local` 里的同一个 JWT"。**这个假设是错的**，且在真实浏览器中被证伪：邮件登录成功后，`chrome.storage.local` 里没有任何 Clerk 键。

根因在 SDK 的 `requestHandler`（`chunk-Y66PY3VX.js:133-142`）里有一个先有鸡还是先有蛋：

```js
requestInit.credentials = "omit";
const currentJWT = await jwtHandler.get();
if (!currentJWT) {
  return;                    // 提前返回：不加 _is_native=1，不加 Authorization
}
prodHandler(requestInit, currentJWT);
```

- storage 里没有 JWT → 提前返回 → 请求不带 `_is_native=1`
- 没有那个参数，Clerk FAPI 按网页模式响应，**不返回** `Authorization` 响应头
- `responseHandler` 只在看到 `Authorization: Bearer` 时才写入 → 什么都没写

**storage 无法自我起步。** 唯一的播种途径是 `JWTHandler.get()` 的 sync 分支（读 `__client` cookie 再写入 storage），需要 `syncHost`，进而需要 `cookies` 权限。

同一轮还发现：改用 `ClerkProvider` 会让客户端进入 Clerk 的 native 模式，**Google OAuth 因此失效**（`invalid_url_scheme`，走的是另一条服务端回跳校验路径）。该 spike 已回退（`bc0185c`）。

**本设计的首要原则：不依赖对 Clerk SDK 内部机制的任何理解。** 该处判断已连续错误三次。

---

## 架构

面板的 Clerk 身份是好的，且**已在生产环境验证**——面板能显示 "5 runs left today"，这要求服务端 `resolveCaller` 返回 `{kind:"user"}`，即面板的 Bearer token 经 `auth()` 解析成功。问题从来只是 worker 够不到它。

那就不要让 worker 去碰 Clerk。**让面板把身份换成一张短期令牌交给 worker。**

```
面板（Clerk 身份可用）
  └─ POST /api/run-token          Authorization: Bearer <clerk token>
       │                          服务端 auth() → userId
       ↓ { token }                SignJWT({ uid }) , 15 分钟
  └─ chrome.runtime.sendMessage({ type:"start-run", ..., runToken })
       ↓
    service worker
       └─ 该 run 的每次 API 调用都用 runToken 作 Authorization
            ↓
          resolveCaller 认出 uid → { kind:"user", userId } → 扣用户额度
```

worker 退化为**持有 bearer token 的执行器**。身份判断回到面板 —— Clerk 在那里本来就工作正常。

---

## 已核实的事实

以下全部读自本仓库源码或已在生产中被观察到，非推测。

1. **`clerkMiddleware` 默认不保护任何路由**（`src/middleware.ts:5-6`），只让 `auth()` 可用，并为白名单内的扩展来源盖 CORS 头。**新路由无需改动 middleware。**
2. **面板 Bearer → `auth()` → userId 的链路已在生产验证。** 面板显示 "5 runs left today" 就是证据：该数字要求 `resolveCaller` 走到 `clerkUserId` 分支。
3. **令牌签发/校验的模式现成。** `src/lib/auth.ts` 用 `jose` 的 `SignJWT`/`jwtVerify`，HS256，密钥来自 `DEVICE_TOKEN_SECRET`（要求 ≥32 字符），payload 为 `{ did: deviceId }`，TTL `"24h"`。
4. **`resolveCaller` 的优先级**（`src/lib/auth.ts:107-129`）：`clerkUserId` > bearer 令牌 > 匿名头。bearer 分支的既有规则是"要么有效、要么 401，绝不静默降级为匿名"。
5. **`DEVICE_TOKEN_SECRET` 在生产环境已配置** —— 设备令牌当前可用，用户的设备试用额度正常工作。本设计复用同一密钥，无需新增环境变量。

---

## 组件

### 服务端

**`src/lib/auth.ts`** —— 新增两个函数，与设备令牌**共用同一密钥**：

```ts
const RUN_TOKEN_TTL = "15m";

/** Mint a token that lets the extension's service worker transact as this user. */
export async function issueRunToken(userId: string): Promise<string>;

/** Returns the user id, or null for any invalid/expired/forged token. */
export async function verifyRunToken(token: string): Promise<string | null>;
```

两种令牌靠 payload 的 claim 区分：设备令牌带 `did`，run token 带 `uid`。**同一个密钥、同一个算法**，因此一次 `jwtVerify` 即可，按出现的 claim 分流 —— 不要写成两次校验。

**为什么 15 分钟**：一次生成约 60 秒、3 次 API 调用，15 分钟足够覆盖一次生成加重试。令牌泄露的损失被限制在"花掉该用户当天剩余额度"，改不了账号本身。

**`src/app/api/run-token/route.ts`** —— 新增。形状照抄 `src/app/api/device-token/route.ts`：

- `runtime = "nodejs"`
- 先过 `rateLimitResponse(ip, DEVICE_TOKEN_RATE_LIMIT)` —— 与铸造设备令牌同一个紧的独立桶，理由相同：令牌获取不应与真实工作竞争共享预算
- `const { userId } = await auth()`；`userId` 为空则 **401**，不降级
- 返回 `{ token }`

**`resolveCaller`**（`src/lib/auth.ts`）—— bearer 分支多认一种 claim：

```
if (clerkUserId)                        → { kind: "user", userId: clerkUserId }
bearer 存在:
    run token 校验通过（uid）           → { kind: "user", userId: uid }
    设备令牌校验通过（did）             → { kind: "device", deviceId: did }
    两者都不通过                        → { ok: false, reason: "invalid_token" }
```

**必须保留的既有性质**：一个存在但无效的 bearer 是 401，**绝不静默降级为匿名**。这是扩展得知自己令牌失效的唯一途径。

### 扩展

**`extension/src/lib/runToken.ts`**（新建）—— 取一张 run token：

```ts
/** null means "not signed in" — the caller proceeds on the device identity. */
export async function fetchRunToken(): Promise<
  { ok: true; token: string } | { ok: false; kind: ApiErrorKind; message: string } | null
>;
```

签名要区分三种结果，因为三者的处理方式不同：拿到了、没登录（照常匿名跑）、登录了但取不到（拒绝并提示重新登录）。

**`extension/src/sidepanel/App.tsx`** —— 发 `start-run` 之前先取 run token：

- 未登录 → 不带 token，照常发消息（**匿名路径完全不变**）
- 已登录且取到 → 放进消息
- 已登录但失败 → **不发消息**，直接在面板上给出 "Sign in again"

身份判断在面板做，比在 worker 里做更靠谱也更快：面板本来就有可用的 Clerk 客户端，用户点击后立刻得到答复，无需先唤醒 worker。

**`extension/src/background/runs.ts`** —— `StartRunMessage` 增加 `runToken?: string`，并把它透传给该 run 的所有 API 调用。

**`extension/src/lib/api.ts`** —— `send()` 需要接受一个显式覆盖的令牌。当前它总是调用 `currentAuthToken()`；worker 里那个调用永远返回设备身份，正是本 bug 的所在。新增一个可选参数，让 worker 传入 run token；不传时行为与现在完全一致。

### 删除

- **`extension/src/background/identity.ts`** 及其测试 —— 上一版方案的产物，已被证伪
- `extension/src/background/index.ts` 中的 `installBackgroundClerkTokenSource()` 调用与 import
- `extension/src/background/__tests__/identity-wiring.test.ts`

这一并解掉最终审查提出的另外两个 finding：worker 不再静态加载 ~840 KB 的 clerk-js，那个盯着面板从不写入的键的 `chrome.storage.onChanged` 死监听也随之消失。

### 保留

- **`extension/src/lib/clerkTokenSource.ts`**（Task 1）—— 面板仍在使用，三态语义依旧正确
- **`startRun` 的启动前拒绝**（Task 3）—— 保留为纵深防御。面板现在会先拦一道，但 worker 不应假定调用者一定守规矩
- 面板对 `session-expired` 保持静默（Task 4）

---

## 错误处理

| 情况 | 行为 |
|---|---|
| 未登录 | 不取 run token，worker 用设备令牌。**匿名路径与今天完全一致** |
| 已登录，`/api/run-token` 返回 401 | 面板不启动 run，显示 "Sign in again" |
| 已登录，`/api/run-token` 网络失败 | 面板不启动 run，显示网络错误。**不降级为设备身份** —— 那正是本设计要消灭的静默降级 |
| run token 在运行中过期 | 服务端返回 401；`api.ts` 既有的 401 处理把它变成 `session_expired`。15 分钟对 60 秒的运行有充足余量 |
| worker 收到的消息不带 runToken | 按匿名处理，用设备令牌。与今天的行为一致 |

---

## 安全性

- run token 授予"以用户 X 的身份消费额度"，持续 15 分钟。风险等级与既有的设备令牌同类（后者授予设备身份，24 小时）。
- 它**只在扩展内部流转**：由面板通过 HTTPS 取得，经 `chrome.runtime.sendMessage` 交给 worker，两者同属一个扩展，网页无法读取。
- 它**不能**用于修改账号、读取用户资料，或做除消费额度之外的任何事。
- 铸造受 Clerk 认证保护 —— 无有效 Clerk 会话者拿不到令牌。
- 复用 `DEVICE_TOKEN_SECRET`：轮换该密钥会同时使两类令牌失效，这是可接受且符合直觉的。

---

## 测试

单元测试**无法**证明本修复成立 —— 上一版有 249 个绿色测试而功能是坏的。测试用来防止回归，验收靠浏览器。

必须有的断言：

1. `issueRunToken` / `verifyRunToken` 往返；过期令牌返回 null；被篡改的令牌返回 null
2. **设备令牌不会被误认为 run token，反之亦然** —— 两者同密钥，claim 是唯一的区分，这条最容易出错
3. `resolveCaller` 拿到 run token → `{kind:"user", userId}`
4. `resolveCaller` 拿到无效 bearer → `{ok:false}`，**不是**匿名降级
5. `/api/run-token` 无 Clerk 会话 → 401
6. 面板：已登录 → 消息带 runToken；未登录 → 消息不带且照常启动；取令牌失败 → **不发消息**
7. worker：消息带 runToken → API 调用用它；不带 → 用设备令牌

---

## 明确不在范围内

- `DAILY_USER_LIMIT` 的数值（当前 5）。修好后每天 5 次会真正生效，自测很快用完 —— 属于 promo code 那个独立待办
- 打分逻辑（fit + presentation 双分量），已单独商定
- `lib/runLog.ts` 临时诊断代码的移除
- Google OAuth 的 `invalid_url_scheme` —— 由已回退的 spike 引入，回退后应恢复；若仍存在则单独处理

---

## 验收标准

单元测试全绿**不构成**通过。必须在真实浏览器中：

1. 重新加载扩展，`grep -c "run-token" extension/dist/assets/*.js` 应有非零命中，确认装的是新包
2. 清掉 beta code（`await chrome.storage.local.remove('cp_beta_code')`），否则服务端会跳过额度检查，测试无效
3. 登录，记下 "runs left today"
4. **跑一次生成，该数字必须减 1。这是唯一的通过标准。**
5. 连续跑到用尽，服务端返回 402
6. 登出后再跑一次，匿名/设备路径仍可用
7. 三个招聘页并行生成，后台并发未被破坏
