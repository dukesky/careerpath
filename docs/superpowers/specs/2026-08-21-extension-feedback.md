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

## 4. 安装时的权限提示吓人

**用户观察：** 最初安装时的弹窗提示插件可能使用网页的所有 data，不利于用户信任。

**这条我需要看到实际弹窗才能给准话。** 当前 manifest 的权限构成是：

- `host_permissions`（**会**出现在安装提示里）：4 个 API 域名（含 `http://localhost:3000/*`）
  + 1 个 Clerk 域名 + 5 个招聘网站 = **10 个域名**
- `optional_host_permissions`（按设计**不该**出现在安装提示里）：`http://*/*`、`https://*/*`
- `permissions`：`storage`、`sidePanel`、`activeTab`、`scripting`

**两种可能，处理方式完全不同：**

- **(a) Chrome 把 10 个域名折叠成了一句概括**（类似 "Read and change your data on linkedin.com,
  greenhouse.io, and 8 other sites"）。这种情况完全可以优化——见下面的三个方向。
- **(b) 真的显示成了"所有网站"。** 那说明"optional_host_permissions 不出现在安装提示里"这个
  当初的设计前提是错的。整个页面访问方案就是围绕这个前提设计的，前提错了得重新考虑。

**无论是哪种，有一个问题已经确定要改：`http://localhost:3000/*` 不该出现在上架版本里。**
`manifest.config.ts` 里的 `API_HOSTS` 是写死的、不区分 build mode，所以正式提交到 Web Store 的
包也会带着 localhost。这既平白多一条权限，也显得不专业。

**可优化的方向（按代价从小到大）：**

1. 上架 build 去掉 `localhost`，可能也去掉 `careerpath-hazel.vercel.app`（等自定义域名稳定后）。
   ——纯收益，没有代价。
2. 把 5 个招聘网站从 `host_permissions` 挪到 `optional_host_permissions`。安装提示会干净很多，
   代价是用户在每个网站第一次使用时要多点一次"允许"。**这是当初刻意做的相反选择**（B1 选择装机
   即授权，为的是打开面板就能用、零点击），要改属于推翻一个原设计决策，需要明确拍板。
3. 在 Web Store 商品页详细解释每条权限的用途。Chrome 的权限说明字段就是给这个用的，而且这个
   插件的整套设计本来就是奔着"权限尽量少"去的，解释起来是有底气的。

**需要用户提供：** 那个权限弹窗的截图，一句话就能定性到底是 (a) 还是 (b)。

---

## 下一步

1 和 3 需要用户回答问题才能定方案；2 的方案基本清楚了，可以直接做；4 等截图。

建议等这四条都确认完再一起走 spec → plan → 实现，而不是逐条零散修——2 和 4 都会动到
`manifest.config.ts`/登录流程，分开做容易互相打架。
