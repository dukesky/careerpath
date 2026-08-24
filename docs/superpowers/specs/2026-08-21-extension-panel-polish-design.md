# 插件面板打磨 —— 设计文档

**日期：** 2026-08-21
**来源：** [2026-08-21-extension-feedback.md](2026-08-21-extension-feedback.md) 里的第 1、2、4、5 条，
外加实测中发现的 beta code 缺失。

## 目标

让插件在**未登录**和**首次使用**这两个场景下不再劝退用户。当前的面板把登录摆在最显眼的位置、
登录完之后又把用户扔在一个不知道该干嘛的标签页上、申请权限时弹一个不加解释的吓人对话框——
这三件事叠在一起，一个本来可以直接用的产品看起来像个必须先注册的产品。

**不在本轮范围内：** LinkedIn 的 JD 抽取问题（feedback 文档第 3 条，还缺真实失败样本）；
网页版的任何改动（第 6、7 条已另行处理）。

## 全局约束

- 服务端一行都不改。本轮所有需求都能靠已有接口满足。
- 匿名可用性不能倒退：未登录用户仍然是 30 天 3 次，全程不需要任何登录动作。
- UI 文案一律英文（代码和注释也是），本文档中文。
- 现有的并发保护机器（`generate()` 内部、`runningForUrlRef`、`busy`/`saving` 那套）不动。
- 基线：extension 153/153、root 84/84、tsc、两个 lint、两个 build 全绿。

---

## ① 未登录时以额度为主角

### 现状与问题

`AccountBar` 未登录分支渲染一整张卡片，第一行是 label 样式的 **"Not signed in"**，
第二行是"登录可以把额度从 30 天 3 次提升到每天 5 次"。而 `remaining` 来自 `RunState`，
**第一次生成完成之前一直是 `null`**——所以首次打开面板时，那句唯一能安抚用户的"你还有 3 次"
恰恰不显示，用户看到的是一张从头到尾都在讲登录的卡片。

### 设计

**面板挂载时拉一次 `GET /api/quota`。** 这个接口已经存在，对已登录和未登录调用者都有效，
读操作不消耗额度，Redis 不可用时会退化成 `{ remaining: null }` 而不是报错。

新增 App 状态：

```ts
type QuotaInfo = { remaining: number | null; unlimited: boolean };
const [quota, setQuota] = useState<QuotaInfo | null>(null);
```

`/api/quota` 的两种返回：正常是 `{ remaining, used, limit }`；beta 通行时是
`{ remaining: null, unlimited: true }`。映射到 `QuotaInfo` 时，`unlimited` 取
`unlimited === true`，其余情况为 `false`。

**显示用的数字按这个优先级取：**

```
displayRemaining = state.remaining ?? quota?.remaining ?? null
displayUnlimited = quota?.unlimited === true
```

`state.remaining`（跑完一次生成后服务端返回的）优先，因为它比打开面板时拉的那次更新。

**身份一变就重拉额度。** 这条是硬性要求，不是优化：登录和登出会切换配额桶（5/天 ↔ 30天3次），
不重拉就会显示上一个身份的数字。触发点有三个——登录被感知到（见 ②）、登出完成、beta code 生效
（见 ⑤）。

> **为什么必须强调这条：** 上一轮 review 刚修过一个同类 bug（登出后 `state.remaining` 没清，
> 面板拿上一个账号的每日剩余次数去套 30 天档的文案）。现在多了一个 `quota` 兜底来源，
> 如果登出时不一起处理，那个 bug 会原封不动地从新路径回来。登出时 `state.remaining` 置 null
> 之后会落到 `quota.remaining`，而那正是上一个账号的数字。

**重拉之前先把 `quota` 置回 `null`，不要留着旧值等新值覆盖。** 网络请求有往返时间，
这段时间里如果旧值还在，面板显示的就是上一个身份的额度——窗口很短，但这正是本项目反复栽跟头的
那类"看起来没坏、数字是错的"问题。置 null 期间按"额度未知"渲染（见下面未登录分支的第三种情况），
宁可短暂地不显示数字，也不显示一个错的。

### 未登录分支的新结构

主角是额度，登录提示降级：

- **有额度数字时：** 主行 `{n} run{s} left`（沿用现有的"不带 today"措辞——未登录是 30 天 3 次，
  不是日额度），下面一行轻量小字 `Sign in for 5 a day`，右侧保留 Sign in 按钮。
- **`displayUnlimited` 为真时：** 主行 `Beta · unlimited`，同样保留 Sign in 按钮。
- **额度未知时（拉取失败、Redis 不可用）：** 不编数字。只显示那行轻量的
  `Sign in for 5 runs a day` 加按钮——即退回接近今天的样子，但仍然去掉 "Not signed in" 标签。

**"Not signed in" 这个 label 三种情况下都删掉。** 它是整块内容里唯一一句在讲"你缺什么"而不是
"你有什么"的话，也是用户把这块读成门禁的直接原因。

### 已登录分支

结构不变（邮箱 / 额度 / Sign out）。唯一变化是额度现在打开面板就有值，不用等第一次生成；
`displayUnlimited` 为真时那一行显示 `Beta · unlimited` 而不是数字。

---

## ② 登录完自动回到面板

### 现状与问题

两个独立的毛病：

1. `signin/main.ts` 登录成功后渲染 *"Signed in as {email}. You can close this tab and return to
   the panel."*，要用户自己关标签页、自己切回去。
2. **更严重：面板可能根本不知道你登录了。** 面板靠 `document.visibilitychange` 重新检查登录状态，
   但侧边栏是常驻的——用户切到登录标签页再切回来的整个过程中，侧边栏一直可见，
   `visibilityState` 可能从头到尾没变过，事件也就从来不触发。Task 5 的实现者当时就把这条标注为
   "无法在此环境验证"。

### 设计

**用 `chrome.storage.local` 做跨上下文信号，不再赌 visibility 语义。**

- `signin/main.ts` 检测到 `clerk.isSignedIn` 时：先 `await setHasSignedIn()` 写入
  `cp_has_signed_in`，再尝试关闭标签页。
- `App.tsx` 注册 `chrome.storage.onChanged` 监听器（`area === "local"` 且
  `changes` 里含 `cp_has_signed_in`）→ 触发 `refreshAccount()` **和**额度重拉。

`chrome.storage.onChanged` 在扩展的所有上下文之间广播，跟窗口可见性完全无关，
这正是 `visibilitychange` 猜不准的那件事。

**顺带修掉一个已 park 的遗留问题。** 最终 review 里记录过：`signin/main.ts` 从来不写
`cp_has_signed_in`，导致刚登录完那一小段时间里，如果 Clerk 连不上，一个真登录用户会被误判成匿名
用户。这里加的这行 `setHasSignedIn()` 正好把那个窗口关上。

**关闭标签页：** 先试 `window.close()`。这一步**必须容错**——浏览器可能拒绝关闭不是脚本打开的
标签页（这个页面是通过 `<a target="_blank">` 打开的）。所以：

- 关成功了，用户什么也看不到，直接就在面板里了。
- 关不掉，页面上留下的文案必须是准确的：
  `Signed in as {email}. The panel is ready — you can close this tab.`
  （注意跟今天的措辞差别：今天说"回到面板"暗示还要用户做点什么，新文案陈述的是"面板那边已经好了"，
  因为 storage 监听器此刻确实已经更新过面板了。）

**保留现有的 `visibilitychange` 监听器。** 它已经有测试、成本为零，而且能覆盖 storage 信号覆盖不到
的场景（比如用户在 Clerk 自己的账号门户里登出）。两条路并存，不冲突。

---

## ③ 权限申请前先说明白

### 现状与问题

用户在不属于那五个招聘网站的页面点 **"Read this site"**，`requestBroadHostAccess()` 会一次性
向 Chrome 索要 `["http://*/*", "https://*/*"]`，Chrome 如实渲染成
**"Read and change all your data on all websites"**——它能显示的最吓人的一句话，
而用户的真实意图仅仅是"读一下我现在看的这个职位页"。

### 已排除的方案，以及为什么

**"只申请当前这一个域名"在不加 `tabs` 权限的前提下做不到。** 逻辑上是个死结：走到这一步是因为
`executeScript` 失败了；而如果 `activeTab` 对这个标签页有效，`executeScript` 本来就该成功。
所以此刻 `activeTab` 必然无效，`tab.url` 也就读不到（没有 `tabs` 权限时
`chrome.tabs.query` 返回的对象里 `url` 是空的）。

加 `tabs` 权限能解开这个结，但代价是安装提示多一条"读取浏览记录"——把一个用到一半的吓人弹窗
换成一个装之前的吓人条目。**用户明确选择不加权限。**

### 设计

弹窗本身不变。在按钮上方加一段说明，让用户点之前就知道自己在同意什么。

**措辞上的分寸（这条是硬要求）：** 文案不能让人以为 Chrome 把权限限制在了当前网站——那是假的，
Chrome 授予的确实是所有网站。能承诺的是**我们自己怎么用**。所以必须把"Chrome 给了什么"和
"career-path 做什么"分开讲：

```
Chrome only offers one option here — access to every site. career-path uses it
to read the job posting on the tab you're looking at, and nothing else: it
doesn't read other pages, and it doesn't collect your browsing history. You can
take it back any time at chrome://extensions.
```

这段话跟 `/privacy` 上已有的承诺（"It does not read any other page, and it does not collect your
browsing history."）一致，不是新造的说法。

按钮文案和行为都不变（`Read this site` / `Waiting for Chrome…`）。

---

## ④ 底部加网页版入口

### 现状与问题

面板底部已经有一个链接，但指向 `/app/saved`、文案是 `Your saved resumes ↗`，只覆盖"看我存过的
简历"这一个场景。而且按代码注释的说法，未登录用户点进去会落到登录页——对一个只想看看网页版
能干什么的人来说是个死胡同。

### 设计

- **新增** `Open career-path ↗` → `${API_BASE}/app`，**登录与否都显示**。网页版能做而面板做不到的
  事不少（手动粘贴 JD、上传职位截图、行内编辑、看 diff），面板里卡住的用户该有条明确出路。
- **现有的** `Your saved resumes ↗` 改成**只在已登录时显示**。未登录时它通往登录页，是死路，
  不如不给。

两个链接沿用现有的 `<a className="outlink" target="_blank" rel="noreferrer">` 写法——普通锚点，
不需要 `tabs` 权限，跟现在的做法一致。

---

## ⑤ 插件支持 beta code

### 现状与问题

网页版的 beta 无限额度靠 `x-access-code` 请求头认（`src/lib/identity.ts` 的 `hasBetaAccess()`），
**插件从来不发这个头**，所以插件里永远是普通额度。而且插件的 `chrome.storage.local` 和网页的
存储完全隔离，用户在网站上输过的 code 插件也读不到。

这不是 bug，是没实现。但它直接卡着开发者自己的测试循环——每天 5 次不够反复试。

### 设计

**存储**（`extension/src/lib/storage.ts`，沿用该文件已有的 `cp_` 前缀和 try/catch 写法）：

```ts
getBetaCode(): Promise<string | null>
setBetaCode(code: string): Promise<void>
clearBetaCode(): Promise<void>
```

存储键 `cp_beta_code`。

**发送**（`extension/src/lib/api.ts` 的 `send()`）：存在 code 时加上 `x-access-code` 头。
位置在现有的 `Authorization` 头旁边。**这个头和身份认证互不干扰**——服务端的
`hasBetaAccess()` 只看这个头，不影响 `resolveCaller()` 怎么判断调用者身份。

**UI**（面板底部，靠近两个外链）：一个安静的 `Have a beta code?` 文字按钮，点开展开输入框，
输入后点 Apply。**镜像网页版 header 里已有的那个交互和文案**，两边保持一致。

**验证靠重拉额度，不需要新接口：** Apply 之后写入存储、重新拉 `GET /api/quota`。
返回 `unlimited: true` 就是成功（面板随即显示 `Beta · unlimited`）；否则说明 code 无效，
显示 `That code didn't work.` 并**清掉刚存进去的值**——不能把一个无效 code 留在存储里，
让之后每个请求都带着它。

已生效时，那个位置显示成可以取消的状态（`Beta · unlimited` 旁边给个移除入口，
调 `clearBetaCode()` 后重拉额度）。

---

## 测试

**能测的**（都通过 `App.test.tsx`，这个包唯一可用的 React 测试环境）：

- 面板挂载时调用了 `/api/quota`，未登录卡片显示拉回来的数字，且**不含** "Not signed in"
- 额度拉取失败时不编数字，只显示登录提示那一行
- `state.remaining` 优先于 `quota.remaining`（跑完一次生成后显示的是新数字）
- **登出后不显示上一个身份的额度**——这条是防上面点名的那个回归，必须有
- `chrome.storage.onChanged` 里 `cp_has_signed_in` 变化会触发身份刷新和额度重拉
- 权限说明文案在且仅在 `failure.kind === "permission"` 且未持有广域授权时出现
- `Open career-path` 登录与否都在；`Your saved resumes` 只在登录时在
- beta code：Apply 后请求带上 `x-access-code`；无效 code 会清除存储且不留残留

**测不了的**（必须真机验证，报告里要明说，不能拿 build 通过冒充覆盖）：

- `signin/main.ts` 的任何改动——这个包没有页面级测试环境（跟前几轮一样）
- `window.close()` 在这个标签页上到底能不能成功
- Chrome 权限弹窗的实际观感
- 侧边栏 + storage 事件的真实时序

---

## 风险

**唯一一处真正动到既有正确性的地方是 ① 的额度来源。** 它给 `remaining` 引入了第二个来源，
而这个字段刚在上一轮因为登出后不清理出过 bug。缓解手段是"身份一变就重拉"这条规则，
以及为登出场景专门写的那条回归测试。其余四条都是纯增量：新文案、新链接、新监听器、新请求头，
不改任何既有判断逻辑。
