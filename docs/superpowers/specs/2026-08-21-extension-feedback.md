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

## 下一步

- **1** 等确认测试用的 build 时间点（决定是改文案还是重新 build 就好）
- **2** 方案已清楚，可以直接做
- **3** 等用户提供真实读取失败的职位链接
- **4** 根因已确认，方案倾向"先试 `activeTab` 读当前域名，读不到再退回广域"，但需要在真浏览器里
  验证 `activeTab` 的实际覆盖率
- **5** 方案已清楚，可以直接做

建议等 1 和 3 确认完再一起走 spec → plan → 实现。2、4、5 都会动到面板布局或 manifest，
分开做容易互相打架。
