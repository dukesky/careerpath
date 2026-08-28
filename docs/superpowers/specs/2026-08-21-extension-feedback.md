# 插件实测反馈（2026-08-21）

第一次真正在浏览器里加载插件之后收集到的四个问题。这是这个分支上**第一次**有真人跑完整流程——
之前五轮 plan 的所有验证都是单元测试，`chrome.*` 和 Clerk 全是 mock 的，所以这四条的价值远高于
任何一次 code review。

状态：已诊断，未修复。修复方案还没定稿，需要先确认几个问题（见每条末尾）。

---

## 1. 打开插件时像是必须登录

**用户观察：** 插件刚打开的时候需要登录，不登录好像不能用。预期是可以跳过，未登录也有 3 次额度。

**代码层面的核查结论：代码里没有任何登录门禁。** 我把 `signedIn` 在整个面板里的每一处引用都查了
一遍（`App.tsx`、`Results.tsx`、`AccountBar.tsx`），它只影响三件事：账户栏显示什么、Save 按钮是否
出现、额度耗尽时是否提示登录。真正控制"能不能生成"的是：

```ts
const canRun = Boolean(jd && stored) && !busy && !saving;
```

——只要求有 JD 和已上传的简历，**不要求登录**。

**所以真实原因是下面两个之一（需要确认是哪个）：**

- **(a) 纯 UI 观感问题。** `AccountBar` 渲染在面板最顶部、简历卡片之上，未登录时第一行大字是
  **"Not signed in"**。用户打开面板第一眼看到的就是这个，很自然会理解成"我得先登录"。这种情况下
  代码没 bug，是文案和信息层级的问题。
- **(b) 真的被挡住了，触发的是 C1 那个 bug。** 如果 Clerk 连不上（最可能的原因：Clerk 后台的
  allowed origins 里没有加 `chrome-extension://nipgolameclkfjekaggkmanahaddcbaj`），
  `clerk.load()` 会 reject。在最终 review 修掉 C1 之前，这会让 `session.ts` 返回
  `session_unavailable`、`api.ts` 直接拒绝所有请求并显示 *"We couldn't confirm your session.
  Sign in again to continue."* ——那看起来就是个硬登录门禁，和用户描述完全吻合。

**待确认：** 测试用的 build 是哪个时间点打的？如果是最终修复（commit `0e8e171`）之前打的，那就是
(b)，重新 build 一次就好。如果是之后打的，那就是 (a)，需要改文案和布局。

---

## 2. 登录成功后停在"close this tab"，面板没反应

**用户观察：** 登录成功后页面说可以关闭这个 tab，但插件本身不是 tab，应该自动跳回改简历的界面。

**已确认，代码就是这么写的。** `extension/src/signin/main.ts` 的 `renderSignedIn()` 渲染的文案是：

```
Signed in as {email}. You can close this tab and return to the panel.
```

**两个独立的问题：**

1. **要用户手动关 tab、手动切回去。** 应该登录成功后自动关掉这个 tab。
2. **更要命的：面板可能根本不知道你登录了。** 面板现在靠 `document.visibilitychange` 事件来重新
   检查登录状态。但侧边栏（side panel）是**常驻**的——用户切到登录 tab 再切回来的整个过程中，
   侧边栏一直可见，`visibilityState` 可能从头到尾没变过，事件也就从来不触发。这个隐患在 Task 5
   的报告里被实现者自己标注为"无法在此环境验证"，现在看来就是真的漏了。

**建议方案（一箭三雕）：** 改用 `chrome.storage.onChanged` 做跨上下文通知，而不是猜 visibility 语义。

- `signin/main.ts` 检测到已登录时，先调用 `setHasSignedIn()` 写入 `cp_has_signed_in`，再自动关闭 tab。
- `App.tsx` 监听 `chrome.storage.onChanged` 里这个 key 的变化 → 触发 `refreshAccount()`。

这个方案顺带把最终 review 里 park 掉的遗留问题 #1 也一起解决了（登录页从来不写这个标志位，导致
刚登录完那一小段时间里，如果 Clerk 连不上，一个真登录用户会被误判成匿名用户）。

**待确认：** `chrome.tabs.getCurrent()` + `chrome.tabs.remove()` 在没有 `tabs` 权限时能不能用？
我倾向于可以（`tabs` 权限主要管的是读取 url/title 这些敏感字段），但没在真浏览器里验证过，不能打包票。
退一步可以用 `window.close()`。

---

## 3. JD 有时候读不全，只拿到标题

**用户观察：** 多次尝试时，有时 JD 页面读取不成功，只能得到 job title，requirement 不确定。

**已定位到设计上的盲区。** `extract.ts` 的逻辑是两级降级：

1. 先找 JSON-LD 里的 `JobPosting`，要求有 `description` 字段
2. 找不到就退回 Readability 抽正文

然后只有一道质量闸门：

```ts
if (!candidate || candidate.text.length < MIN_JD_CHARS) return { ok: false, reason: "too-short" };
// MIN_JD_CHARS = 300
```

**问题就在这：300 字符以下会明确报错，但 300 字符以上一律算成功。** 中间存在一个很宽的
"假成功"区间——Readability 抓到了页面上某块 300+ 字符的内容（可能是公司介绍、福利待遇、
甚至侧边栏的相关职位），但根本不是职位要求。此时面板显示一切正常，用户拿到的却是一份基于
错误输入生成的简历。这正是这个分支反复踩的那类"静默降级"坑：不报错、不崩溃，就是结果不对。

**最可能的具体触发场景（需要用真实失败页面确认）：**

- **LinkedIn 的"See more"折叠。** 职位描述在 DOM 里是截断的，要点击才展开完整内容。Readability
  抓到的就是被截断的那一版。
- **SPA 还没渲染完。** 内容脚本注入的时机可能早于页面异步加载完 JD 正文。
- **Readability 选错容器。** 招聘页面结构复杂时，它可能挑中导航区或页头。

**需要用户提供：** 一到两个具体读取失败的职位链接（哪个网站、什么职位）。没有真实样本的话，
任何修复都是在猜，而且这类问题极难在没有真实页面的情况下写出有意义的测试。

---

## 4. 权限提示吓人：「Read and change all your data on all websites」

**截图已确认，而且我之前的判断是错的——这不是安装提示。**

弹窗原文是 *"career-path — tailor your resume" **has requested additional permissions**"*，
「additional permissions」这个措辞说明它是**运行时**的可选权限请求，不是装机时的提示。也就是说：

- 好消息：装机提示大概率是干净的，当初那套"把广域权限放进 `optional_host_permissions`、
  不污染安装提示"的设计**是成立的**。
- 坏消息：真正的问题在「Read this site」这个按钮上，而且这个问题比安装提示更严重——因为它出现在
  用户**正要用**的时候，是转化路径上的一道墙。

**根因很明确**（`extension/src/lib/permissions.ts:63-69`）：

```ts
export const BROAD_ORIGINS = ["http://*/*", "https://*/*"];

export async function requestBroadHostAccess(): Promise<boolean> {
  return await chrome.permissions.request({ origins: BROAD_ORIGINS });
}
```

用户在一个不在五个招聘网站名单里的页面点「Read this site」，我们**一次性向 Chrome 索要全部网站的
权限**，Chrome 就如实渲染成「Read and change all your data on all websites」。这是 Chrome 能显示的
最吓人的一句话，而用户的真实意图仅仅是"读一下我现在看的这个职位页"。

**正确做法：只请求当前这一个域名**，比如 `https://careers.example.com/*`。Chrome 会显示成
「Read and change your data on careers.example.com」——同一个功能，观感天差地别。

**但这里有个真实的技术障碍，代码注释里已经预见到了：** 想请求"当前域名"就得先知道当前域名，
而 `tab.url` 恰恰被我们正要申请的那个权限挡着，读不到（没有 `tabs` 权限时，
`chrome.tabs.query` 返回的对象里 `url` 是空的）。这是个鸡生蛋问题。

**三条出路，倾向第 1 条：**

1. **利用 `activeTab`。** manifest 里已经声明了 `activeTab`，而且后台脚本设的是
   `openPanelOnActionClick: true`——用户点工具栏图标打开面板时，Chrome 会对**那个 tab** 授予
   `activeTab`，此时 `tab.url` 应该是可读的。做法：先尝试读 `tab.url`，读到了就只申请那一个域名，
   读不到才退回现在的广域申请。**严格优于现状**，最坏情况也就是跟今天一样。
   注意 B1 当初的结论是 `activeTab` 覆盖不了"打开面板后又切了 tab"的情况，所以这条路能覆盖多少
   比例的真实场景，必须在真浏览器里量一下，不能拍脑袋。
2. **加 `tabs` 权限。** 这样 `tab.url` 永远可读。代价是安装提示会多出「Read your browsing history」
   ——把一个运行时的吓人弹窗，换成一个装机时的吓人条目，不划算，**不推荐**。
3. **在按钮旁边先解释再请求。** 不解决弹窗本身，但能让用户有心理准备。可以和第 1 条叠加。

**另外一个已经确定要改的：`http://localhost:3000/*` 不该出现在上架版本里。**
`manifest.config.ts` 里的 `API_HOSTS` 是写死的、不区分 build mode，正式提交 Web Store 的包
也会带着 localhost。纯属白送一条权限。

---

## 5. 面板底部需要一个跳到网页版的链接

**用户需求：** 页面最下面应该有一个跳转到网页端的链接。

**现状：** 底部**已经有**一个链接（`App.tsx:522-529`），但指向的是 `/app/saved`，文案是
「Your saved resumes ↗」——只覆盖"看我存过的简历"这一个场景。而且按代码注释的说法，未登录用户
点进去会落到登录页，对一个只想看看网页版长什么样的人来说是个死胡同。

**建议：** 再加一个（或改成）指向 `${API_BASE}/app` 的链接，文案类似「Open career-path ↗」。
理由是网页版能做而面板做不到的事不少——手动粘贴 JD、上传职位截图、行内编辑、看 diff——面板里
卡住的用户应该有一条明确的出路。

具体是"两个链接并排"还是"一个链接按登录状态切换"，等一起做 spec 时再定。

---

## 6. 网页版看不到登录入口和用户信息

**用户观察：** 在网站上看不到 profile、登录信息。

**从截图看，问题比"看不到 profile"更彻底：整个 header 里既没有「Sign in」按钮，也没有
「My resumes」链接**，右边到「← Home」就结束了。

**代码是对的，两个都写了**（`src/app/app/page.tsx:433-449`）：

```tsx
<SignedOut><SignInButton mode="modal">…Sign in…</SignInButton></SignedOut>
<SignedIn><Link href="/app/saved">My resumes</Link>…</SignedIn>
```

**根因锁定在 Clerk v7 的 `<Show>` 上。** `src/components/clerk-auth.tsx` 是个兼容 shim，把旧的
`<SignedIn>`/`<SignedOut>` 架在 v7 新的 `<Show when="signed-in|signed-out">` 上。而 `@clerk/react`
里 `ShowProps` 的官方注释白纸黑字写着：

> Returns `null` **while auth is loading**.

也就是说——**Clerk 只要没加载完，两个分支同时渲染成 `null`**，header 上就什么都不剩。这跟截图完全吻合：
不是"登录了但没显示头像"，也不是"没登录所以显示登录按钮"，而是**两个状态都没进去**。

`<ClerkProvider>` 在 `src/app/layout.tsx:58` 是有的，所以不是漏包。剩下最可能的解释是
**Clerk 在这个页面上压根没初始化成功**——而这恰好和我们眼下正卡着的 production instance 迁移有关：
如果这个页面跑在 `career-allpath.com` 上、用的却还是 `pk_test_` 开头的 development key，
Clerk 的 dev instance 对非本地来源是有限制的，初始化失败就会永远停在 loading。

**Console 报错已拿到，根因彻底确定了：**

```
clerk.career-allpath.com/v1/client?... → 403
The request origin subdomain is not in the allowed subdomains list.
Please add it to your subdomain allowlist in the Dashboard.
```

**先说一个好消息：production Clerk 其实早就配好了。** 我查了 DNS，两条记录都是活的、指向正确：

```
clerk.career-allpath.com    → frontend-api.clerk.services  ✓
accounts.career-allpath.com → accounts.clerk.services      ✓
```

Vercel 托管的 DNS 确实像 Clerk 文档说的那样自动配好了。之前 Dashboard 上一直显示
"Pending / 0/2 Verified"，指的是那个占位域名 `national.pegasus-41.lcl.dev`，跟真正在用的这套无关——
我们前面在那个页面上耗的时间，其实是在盯一个已经不相干的东西。

**真正的问题是 www 和 apex 对不上：**

- Vercel 上 `career-allpath.com`（apex）**308 跳转到** `www.career-allpath.com`，www 才是实际服务的域名
- 所以浏览器发给 Clerk 的 Origin 是 `www.career-allpath.com`
- 而 Clerk 的 primary domain 是 apex `career-allpath.com`
- → www 被当成"不在允许列表里的子域名"，403

**修法（二选一）：**

1. **Clerk Dashboard → Configure → Domains → "Allowed subdomains" 标签页，把 `www` 加进去。**
   一步搞定，不动任何基础设施。**推荐先用这个把线上救回来。**
2. **在 Vercel 里把 apex 设为 primary**（取消 apex→www 的跳转）。这样 Origin 就是 apex，天然匹配
   Clerk 的 primary domain，而且顺带解决下面那条 API_BASE 的问题。改动更大，影响已有链接和 SEO。

---

## 7. （连带发现）插件的 API_BASE 指向 apex，每次请求都吃一次 308 跳转

排查第 6 条时顺手发现的，之前没人报，但是个真实的隐患。

`extension/src/lib/config.ts` 里 `API_BASE` 指向 apex，而且注释里当初就写明了触发条件：

> This is the APEX domain, not www. Keep it that way **unless Vercel is configured with www as
> primary**: an apex->www redirect on a POST is a redirect the API client would have to follow…

**而现在 Vercel 恰恰就是 www 为 primary。** 实测确认：

```
$ curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}" https://career-allpath.com/api/quota
308 -> https://www.career-allpath.com/api/quota
```

好在是 **308**（Permanent Redirect），会保留 method 和 body，所以 POST 不会像注释担心的 301/302
那样丢掉请求体——功能上大概率是能跑通的。但代价是**插件每一次 API 调用都白白多一次往返**，
而且跨域跳转时 CORS 的行为比直连更容易出意外。

**修法：** 要么把 `API_BASE` 改成 `https://www.career-allpath.com`，要么按第 6 条的方案 2 把 apex
设为 primary。**这两条应该一起决定**——它们本质上是同一个问题（www 和 apex 到底谁是正主）的两个
表现，分开修容易改出自相矛盾的配置。

### 决议（2026-08-21）：**apex 是正主**

用户拍板 apex 为准。两条后续：

**已完成：Clerk 的 403 修好了。** 用户把 `www` 加进 allowed subdomains 之后实测确认，两个来源
现在都通：

```
Origin: https://www.career-allpath.com  → 200
Origin: https://career-allpath.com      → 200
```

**待用户操作：Vercel 那边还是 www 为 primary**（`apex → 308 → www` 依然存在，实测确认）。
要让 apex 成为正主，需要在 Vercel Domains 页面把跳转方向反过来：apex 直接服务 Production、
www 跳转到 apex。

**代码这边不需要改任何东西**，这点值得说清楚：

- `API_BASE` 本来就指向 apex（`config.ts:14`），apex 一旦成为正主，那次 308 自己就消失了
- `manifest.config.ts` 的 `API_HOSTS` 里 apex 和 www **两个都在**，所以跳转期间和跳转之后都不会断

**建议 `www` 继续留在 Clerk 的 allowed subdomains 里**——反正无害，而且能覆盖 DNS/跳转切换期间
那段两边都可能被访问到的窗口。

**顺带一提，这个 shim 本身是个隐患。** 即使这次的根因是别的，"auth 加载中 → 两个分支都渲染 null"
这个行为也意味着：**页面在 Clerk 加载完之前，header 上会短暂地什么都没有**。正常网络下是一闪而过，
网络慢的时候就是明显的闪烁。给 `<Show>` 传 `fallback` 可以解决，值得一起改。

---

## 已确认 / 已排除

- **第 1 条 → 确认是 UI 观感问题，不是 bug。** 用户确认测试用的包是刚 build 的，也就是包含了
  最终 review 的 C1 修复。所以不存在"Clerk 连不上导致所有请求被拒"的情况，代码里也确实没有
  登录门禁。要改的是 `AccountBar` 的文案和信息层级——不能让"Not signed in"成为用户打开面板
  看到的第一句话。
- **第 3 条 → 缩小到 LinkedIn。** 用户确认失败发生在 LinkedIn。
  **最可能的具体原因（待验证）：** LinkedIn 登录后的职位浏览是 SPA，URL 常常是
  `/jobs/search/?currentJobId=1234` 或 `/jobs/collections/…` 这种形式——整个职位**列表**和当前选中
  职位的详情在同一个 DOM 里。这种页面上：
  - JSON-LD 里的 `JobPosting` 可能不存在，或者描述的不是当前选中的那个职位；
  - Readability 抽正文时很容易抓到左侧的职位列表、或者页面外框，而不是右侧的职位描述。

  这两条都能解释"标题拿到了、requirement 没拿到"——标题在页面上到处都是，描述才是难的那个。
  **仍需用户提供：** 一个具体失败的 LinkedIn 链接（URL 长什么样很关键，
  `/jobs/view/…` 和 `/jobs/search/?currentJobId=…` 是两种完全不同的页面）。

---

## 下一步

| # | 问题 | 状态 |
|---|------|------|
| 1 | 像是必须登录 | 已定性为文案/布局问题，方案待定 |
| 2 | 登录后停在 "close this tab" | 方案已清楚，可直接做 |
| 3 | LinkedIn 读不全 JD | 已缩小到 LinkedIn SPA 页面，等具体链接 |
| 4 | 权限弹窗要"所有网站" | 根因已确认，方案倾向 `activeTab` 兜底，需真机验证覆盖率 |
| 5 | 底部缺网页版入口 | 方案已清楚，可直接做 |
| 6 | 网页版没有登录入口 | 根因锁定在 `<Show>` 的 loading 行为，等 Console 报错确认 |

第 6 条和第 3 条还需要用户提供信息。其余四条可以开始走 spec → plan。

**注意 2、4、5 都会动面板布局或 manifest，第 1 条也动 `AccountBar`——这四条应该在同一轮里做完，
分开改容易互相打架。第 6 条是网页版，和插件那四条互不相干，可以单独并行。**

---

## 实施结果（2026-08-21）

第 1、2、4、5 条已全部实现，外加 beta code 支持。计划见
[2026-08-21-extension-panel-polish.md](../plans/2026-08-21-extension-panel-polish.md)，
设计见 [2026-08-21-extension-panel-polish-design.md](2026-08-21-extension-panel-polish-design.md)。
提交范围 `0994a42..74afa54`。extension 181/181，root 84/84，tsc / 两个 lint / 两个 build 全绿。

### 已修复

| # | 问题 | 做法 |
|---|------|------|
| 1 | 像是必须登录 | 面板打开时拉真实额度，未登录卡片改成以「3 runs left」为主，「Not signed in」标签删掉 |
| 2 | 登录后停在 "close this tab" | 登录页写信号后自动关标签页；面板改用 `chrome.storage.onChanged` 感知，不再赌 `visibilitychange` |
| 4 | 权限弹窗吓人 | 按钮上方加说明，把「Chrome 授予什么」和「我们用它做什么」分开陈述 |
| 5 | 缺网页版入口 | 加 `Open career-path ↗`；`Your saved resumes ↗` 改成仅登录后显示 |
| — | 插件不支持 beta code | 新增 `BetaCodeBox`，请求带 `x-access-code`，服务端零改动 |

### 复盘：两个只有真人测试才会暴露的问题

这一轮最值得记的是**最终整体 review 抓到的两个缺陷，两个都出在我写的计划里**，而且都是同一个盲区：
计划仔细考虑了「身份变化」，完全没考虑面板**其他状态被重置**的时刻。

- **登录信号对老用户失效（Critical）。** 登录页往 `cp_has_signed_in` 写常量 `true`，但这个键在任何
  登录过的浏览器上**已经是 `true`** 了（面板自己每次刷新身份都会写），而 Chrome 对「值没变」的写入
  不触发 `onChanged` —— 于是监听器永不触发，`visibilitychange` 也不触发（这正是本轮改动的前提），
  面板永远不知道用户登录了。**也就是说，这个"修复"在测试者自己的浏览器上大概率什么也不会做。**
  改法：新增只由登录页写、面板从不写的 `cp_signin_at`，值是时间戳，每次都变。
- **切换标签页后额度回退（Important）。** JD 变化的 effect 每次切标签都会重置 `state`，而 `quota`
  只在身份变化时刷新 —— 跑完一次（剩 4）切个标签，面板又显示「5 runs left today」。

### 仍需真人在浏览器里验证（本仓库测不了）

`extension/src/signin/main.ts` **没有也无法有自动化测试**（这个包没有页面级测试环境）。
以下每一条都只能真机确认，建议按这个顺序：

1. **用一个「以前登录过」的 profile 登录** —— 上面 Critical 那条的实际场景，也是最容易让人以为
   「你根本没修」的一条。登录标签页应自动关闭，面板应立刻显示邮箱和「5 runs left today」。
2. **跑一次生成，然后切换标签页，看额度数字** —— 上面 Important 那条。应该显示跑完之后的数字，
   不是打开面板时的数字。
3. 全新 profile 首次打开面板：第一行应是额度，**不是**「Not signed in」。
4. 未登录时把额度用完：应提示登录，而不是死胡同。
5. 在五个招聘网站之外的页面点「Read this site」：按钮上方应先有说明；Chrome 的弹窗**仍然会说
   「所有网站」**（这是设计如此，不是 bug）。
6. 登出（勾选框不勾）：额度应切回未登录档，**不应**残留上一个账号的每日剩余次数。
7. 输入有效 beta code → 显示 `Beta · unlimited`；输入无效的 → 报错且不残留。

### 已知的小问题（已评估，不阻塞）

- 在**生成进行中**登录，面板可能短暂显示设备档的额度，直到下次刷新（重开面板、切换可见性或登出）。
- 极窄的时序竞态下，跑完一次生成的额度更新可能被丢弃，下次切标签时又显示旧值；下一次生成会自愈。
- LinkedIn 的 JD 抽取问题（第 3 条）**本轮没动** —— 仍缺一个具体失败的职位链接。

---

## 后台运行改造完成（2026-08-27）

第 1 条反馈（生成被打断、想并行）已实现。设计见
[2026-08-27-extension-background-runs-design.md](2026-08-27-extension-background-runs-design.md)，
计划见 [../plans/2026-08-27-extension-background-runs.md](../plans/2026-08-27-extension-background-runs.md)。
提交范围 `a9b7b14..675ad48`（9 个提交）。extension 225/225，root 84/84，tsc / 两个 lint / 两个 build 全绿。

### 做了什么

生成从面板搬到了后台 service worker，以**岗位网址**为 key（和已有的结果缓存同一套 key）：

- 关面板、切标签页、在标签页里导航走，生成都继续跑
- 最多 **5 个岗位同时生成**（上限来自服务端限流：每 IP 30 次/60 秒，一次生成 3 个调用）
- 每个标签页拿到**独立的面板实例**，A 页和 B 页互不干扰
- 失败会留在存储里，切回那个岗位页能看到错误，而不是一片空白

**没做**：按网址禁用面板（需要 `tabs` 权限，你上一轮明确不要；而且会堵死「Read this site」授权的唯一入口）。

### 复盘：这一轮所有问题都出在计划里

四个任务各需要一轮修复，加上最终整体 review 的一轮修复波——**每一个发现都是我写的计划的缺陷，而不是实现的问题**。值得记下来的三个：

- **最终 review 抓到的 Critical：僵尸判定在打开着的面板里永远不会触发。** 判定是读取时做的，而读取只有三个触发点，全是事件驱动的。worker 被回收时不产生任何事件——用户盯着面板看，按钮会永远显示 "Working…"，而且 `anyRunning` 卡在 true，导致登出和清除缓存**同时被永久禁用**。更要命的是：**我自己写的真机验证第 7 步也抓不到它**，因为那一步写的是"重开那个岗位页"，而重开就是一次读取。
- **并发写入丢更新。** `cache.ts` 当初是按"同时只有一个运行"写的，现在有五个。具体后果：A 跑完删掉自己的记录，B 的进度写入把旧的 A 又写了回去——面板在一个已经成功并缓存的结果上转圈，五分钟后说"运行中断了，请重试"，诱导用户为已经付过钱的工作再花一次额度。
- **`busy` 的含义被悄悄改窄了**，从"有运行在进行"变成"当前这个岗位在运行"，重新打开了之前修过的一个 Critical。

### 仍需真人在浏览器里验证

**这套东西的核心假设——"进行中的 fetch 能让 MV3 的 service worker 活到生成结束"——本仓库无法验证。**

计划里的验证清单有 9 步，其中两步最关键：

- **第 7 步**（已按最终 review 的意见改写）：生成到一半重启 Chrome，然后**保持面板开着、什么都不碰，等六分钟**。应该看到"运行中断了，请重试"，而不是永远转圈。原来写的"重开岗位页"会让这一步无论如何都通过。
- **第 9 步**（新增）：在 A 岗位跑着生成的时候，去 B 岗位页点「Clear N cached results」，等 A 跑完再切回去。

其余：关面板/切标签页/关标签页后生成是否继续、三个岗位并行、第六个是否被拒、两个标签页的面板是否独立。
