# Service Worker 身份修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让后台 service worker 里的生成以登录用户的身份发请求，而不是以设备身份 —— 使用户的额度真正记账。

**Architecture:** `session.ts` 的 Clerk token source 是一个模块级变量，只有面板会替换它；service worker 是独立 JS realm，那里永远是默认值。修法是把三态语义抽成一个共享工厂（`lib/clerkTokenSource.ts`），面板和 worker 各自提供"如何拿到 client"，worker 用 `@clerk/chrome-extension/background` 的 headless 客户端。同时 `startRun` 在启动前检查身份，拿不到有效 session 就发布 `session_expired` 状态并拒绝。

**Tech Stack:** TypeScript、Chrome MV3、`@clerk/chrome-extension` 3.1.72、Vitest 3.2.7（jsdom 环境）

## Global Constraints

- **设计文档：** `docs/superpowers/specs/2026-08-31-service-worker-identity-design.md`
- **语言规则：** 代码与注释一律英文。本计划的中文散文不要出现在代码里。
- **manifest 不得改动。** background scope 的三项要求（根级 `permissions`、`permissions.storage`、根级 `background`）当前已全部满足，核实自 SDK 的 `validateManifest`。
- **不得对 background 客户端调用 `load()`。** `createClerkClient({background:true})` 内部已调用 `load({standardBrowser:false})`。
- **不得新增 `cookies` 权限。** cookie 路径只在配置了 `syncHost` 时才走，本项目不配。
- **worker 必须 import `@clerk/chrome-extension/background`**，不是 `/client`。走错入口只在真实浏览器里失败。
- **`DAILY_USER_LIMIT` 不动**（当前为 5）。属于独立的 promo code 待办。
- **匿名用户的行为不得改变。** 从未登录过的浏览器必须继续用设备身份正常运行。登录是增强，不是门槛。
- 测试命令一律在 `extension/` 目录下运行。
- 基线：`npx vitest run` 当前全绿，开工前请确认。

---

## 文件结构

| 文件 | 状态 | 职责 |
|---|---|---|
| `extension/src/lib/clerkTokenSource.ts` | 新建 | 共享的三态 source 工厂。不 import 任何 Clerk SDK |
| `extension/src/lib/__tests__/clerkTokenSource.test.ts` | 新建 | 直接测工厂，无需模块重置与 SDK mock |
| `extension/src/lib/clerk.ts` | 修改 | `installClerkTokenSource` 改为委托给工厂 |
| `extension/src/background/identity.ts` | 新建 | background 客户端的构造、记忆化、失效；装载 source |
| `extension/src/background/__tests__/identity.test.ts` | 新建 | 记忆化、失败重置、storage 失效、入口正确性 |
| `extension/src/background/runs.ts` | 修改 | `startRun` 启动前身份检查 |
| `extension/src/background/__tests__/runs.test.ts` | 修改 | 身份检查的三种情况 |
| `extension/src/background/index.ts` | 修改 | 模块作用域装载 |
| `extension/src/background/__tests__/panel.test.ts` | 修改 | chrome stub 补 `storage.onChanged` |
| `extension/src/sidepanel/App.tsx` | 修改 | 对 `session-expired` 保持静默 |
| `extension/src/sidepanel/__tests__/App.test.tsx` | 修改 | 断言静默 |

---

## Task 1: 抽出共享的三态 token source

**为什么先做这个：** `lib/clerk.ts:137-175` 里那套语义是多轮 review 磨出来的，worker 必须用同一份而不是抄一份。抽取完成后，**现有的 `clerk.test.ts` 必须一字不改地继续全绿** —— 那就是"重构没有改变行为"的证明。

**Files:**
- Create: `extension/src/lib/clerkTokenSource.ts`
- Create: `extension/src/lib/__tests__/clerkTokenSource.test.ts`
- Modify: `extension/src/lib/clerk.ts:137-175`

**Interfaces:**
- Consumes: `ClerkAuthState`、`ClerkTokenSource`（来自 `@/lib/session`）；`getHasSignedIn`、`setHasSignedIn`（来自 `@/lib/storage`）
- Produces:
  - `export interface ClerkLike { isSignedIn: boolean; session: { getToken: () => Promise<string | null> } | null | undefined }`
  - `export function makeClerkTokenSource(getClient: () => Promise<ClerkLike>): ClerkTokenSource`

- [ ] **Step 1: 写失败的测试**

创建 `extension/src/lib/__tests__/clerkTokenSource.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeClerkTokenSource, type ClerkLike } from "@/lib/clerkTokenSource";

/**
 * Real chrome.storage.local, faked — NOT a mock of `@/lib/storage`. The
 * has-signed-in flag is the thing under test in half the cases below, and
 * mocking the module that owns it would leave the actual key, the actual
 * default-to-false-on-error path, and the actual write untested while the
 * assertions still passed.
 */
function fakeChromeStorage() {
  const data: Record<string, unknown> = {};
  return {
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => {
          const out: Record<string, unknown> = {};
          for (const k of keys) if (k in data) out[k] = data[k];
          return out;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(data, items);
        }),
        remove: vi.fn(async (keys: string[]) => {
          for (const k of keys) delete data[k];
        }),
      },
    },
  };
}

function client(overrides: Partial<ClerkLike> = {}): ClerkLike {
  return { isSignedIn: false, session: null, ...overrides };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("chrome", fakeChromeStorage());
});

describe("makeClerkTokenSource", () => {
  it("reports signed out when Clerk says the user is not signed in", async () => {
    const source = makeClerkTokenSource(async () => client({ isSignedIn: false }));
    expect(await source()).toEqual({ signedIn: false });
  });

  it("reports the token when signed in with a session", async () => {
    const source = makeClerkTokenSource(async () =>
      client({ isSignedIn: true, session: { getToken: async () => "the-token" } }),
    );
    expect(await source()).toEqual({ signedIn: true, token: "the-token" });
  });

  // The state that matters most: collapsing this into `{ signedIn: false }`
  // is the exact bug session.ts's ClerkAuthState type exists to prevent — a
  // signed-in user would silently fall back to the device identity and spend
  // a trial they could not see.
  it("reports signed in with a null token when Clerk has no session to give", async () => {
    const source = makeClerkTokenSource(async () => client({ isSignedIn: true, session: null }));
    expect(await source()).toEqual({ signedIn: true, token: null });
  });

  it("reports signed in with a null token when getToken() itself resolves null", async () => {
    const source = makeClerkTokenSource(async () =>
      client({ isSignedIn: true, session: { getToken: async () => null } }),
    );
    expect(await source()).toEqual({ signedIn: true, token: null });
  });

  // The asymmetry this factory exists to hold in ONE place. Anonymous use
  // must keep working while Clerk is down; sign-in is an upgrade, never a
  // gate.
  it("falls through to the device identity when the client fails and this browser has never signed in", async () => {
    const source = makeClerkTokenSource(async () => {
      throw new Error("clerk frontend api unreachable");
    });
    await expect(source()).resolves.toEqual({ signedIn: false });
  });

  // The other half: for a browser that HAS signed in, an unreachable Clerk
  // must still refuse, or we spend their device trial while the panel goes on
  // showing their email and daily allowance.
  it("rethrows when the client fails and this browser HAS signed in before", async () => {
    const { setHasSignedIn } = await import("@/lib/storage");
    await setHasSignedIn();
    const source = makeClerkTokenSource(async () => {
      throw new Error("clerk frontend api unreachable");
    });
    await expect(source()).rejects.toThrow("clerk frontend api unreachable");
  });

  it("records that this browser has signed in whenever Clerk reports a session", async () => {
    const { getHasSignedIn } = await import("@/lib/storage");
    expect(await getHasSignedIn()).toBe(false);
    const source = makeClerkTokenSource(async () =>
      client({ isSignedIn: true, session: { getToken: async () => "t" } }),
    );
    await source();
    expect(await getHasSignedIn()).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试，确认它失败**

在 `extension/` 下运行：`npx vitest run src/lib/__tests__/clerkTokenSource.test.ts`
预期：FAIL，报 `Failed to resolve import "@/lib/clerkTokenSource"`

- [ ] **Step 3: 创建共享工厂**

创建 `extension/src/lib/clerkTokenSource.ts`：

```ts
import type { ClerkAuthState, ClerkTokenSource } from "./session";
import { getHasSignedIn, setHasSignedIn } from "./storage";

/**
 * The structural subset of Clerk's client this module needs.
 *
 * Declared structurally rather than imported from the SDK so this module
 * pulls in no Clerk code at all — which is what lets the service worker share
 * it with the panel without dragging in the panel's DOM-bound client.
 */
export interface ClerkLike {
  isSignedIn: boolean;
  session: { getToken: () => Promise<string | null> } | null | undefined;
}

/**
 * The three-state contract api.ts depends on, in ONE place.
 *
 * There are two callers — the panel (lib/clerk.ts) and the service worker
 * (background/identity.ts) — and they differ ONLY in how they obtain a
 * client. The behaviour below must not differ between them, and duplicating
 * it in the worker is how it would come to: this repository has been bitten
 * three times by one rule written down in two files with nothing pinning them
 * together.
 *
 * The behaviour itself:
 *
 * 1. Never reports `{ signedIn: false }` for a user who IS signed in. If
 *    `isSignedIn` is true but `session` is missing or `getToken()` resolves
 *    null, this reports `{ signedIn: true, token: null }` — the state
 *    session.ts turns into `session_unavailable`, not a silent downgrade to
 *    the device identity. Collapsing the two was the exact bug that made
 *    session.ts's `ClerkAuthState` type exist.
 *
 * 2. Answers WITHOUT Clerk when the client cannot be obtained and this
 *    browser has never signed in. That asymmetry is the point, not a
 *    shortcut: a browser with no session has nothing to protect, and
 *    rethrowing would take the extension away from the entire anonymous user
 *    base for the duration of a Clerk outage they have no relationship with.
 *    A browser that HAS signed in gets the rethrow, because guessing "signed
 *    out" would spend that user's device trial while the panel still showed
 *    their email and daily allowance.
 *
 * `getClient` is expected to have awaited Clerk's load before resolving, so
 * "signed in with no token" means something is wrong rather than "still
 * starting up" — see session.ts's ClerkAuthState doc comment.
 */
export function makeClerkTokenSource(
  getClient: () => Promise<ClerkLike>,
): ClerkTokenSource {
  return async (): Promise<ClerkAuthState> => {
    let client: ClerkLike;
    try {
      client = await getClient();
    } catch (err) {
      if (await getHasSignedIn()) throw err;
      return { signedIn: false };
    }
    if (!client.isSignedIn) return { signedIn: false };
    // Recorded here as well as in clerk.ts's `isSignedIn` because this is the
    // path that runs on every request; a user who signs in and immediately
    // runs must have the flag set before the next Clerk failure.
    await setHasSignedIn();
    const token = client.session ? await client.session.getToken() : null;
    return { signedIn: true, token };
  };
}
```

- [ ] **Step 4: 运行新测试，确认通过**

`npx vitest run src/lib/__tests__/clerkTokenSource.test.ts`
预期：PASS，7 个测试

- [ ] **Step 5: 让 clerk.ts 委托给工厂**

在 `extension/src/lib/clerk.ts` 中，把 `installClerkTokenSource` 的整个函数体（第 137-175 行）替换为：

```ts
export function installClerkTokenSource(): void {
  setClerkTokenSource(makeClerkTokenSource(getClerk));
}
```

并把该函数上方的长文档注释替换为：

```ts
/**
 * Wires this module's Clerk client into session.ts as the source api.ts
 * consults for every request. Call once, from wherever the panel bootstraps —
 * NOT from the sign-in page, which has no reason to touch api.ts's auth path.
 *
 * The behaviour lives in lib/clerkTokenSource.ts, shared with the service
 * worker's own client (background/identity.ts). Read that module's doc
 * comment before changing anything here: the panel and the worker MUST answer
 * identically, and this file supplies only the client, never the rules.
 */
```

在文件顶部加入 import：

```ts
import { makeClerkTokenSource } from "./clerkTokenSource";
```

**同时收窄 storage 的 import。** 被移走的那段函数体是 `getHasSignedIn` 在本文件里的唯一使用点，留着它会触发未使用导入的 lint 错误。`setHasSignedIn` 仍被 `isSignedIn()` 使用（约第 189 行），必须保留。把第 20 行改为：

```ts
import { setHasSignedIn } from "./storage";
```

- [ ] **Step 6: 运行 lib 全部测试，确认 clerk.test.ts 一字未改仍全绿**

`npx vitest run src/lib`
预期：PASS。`clerk.test.ts` 的 8 个测试必须全过 —— **这是重构未改变行为的证明。若有任何一个失败，是重构错了，不要去改测试。**

- [ ] **Step 7: 类型检查与 lint**

```bash
npx tsc --noEmit
npm run lint
```

预期：均无错误。

- 若 `getClerk` 与 `ClerkLike` 不兼容而报类型错，**不要用 `as` 强转** —— 那说明 `ClerkLike` 的形状写错了，按 Clerk 的真实类型修正接口。
- lint 会抓住上一步漏掉的未使用导入。

- [ ] **Step 8: 提交**

```bash
git add extension/src/lib/clerkTokenSource.ts extension/src/lib/__tests__/clerkTokenSource.test.ts extension/src/lib/clerk.ts
git commit -m "refactor(extension): extract the Clerk token source's three-state contract"
```

---

## Task 2: service worker 的 Clerk 客户端

**Files:**
- Create: `extension/src/background/identity.ts`
- Create: `extension/src/background/__tests__/identity.test.ts`

**Interfaces:**
- Consumes: `makeClerkTokenSource`、`ClerkLike`（Task 1）；`setClerkTokenSource`（`@/lib/session`）；`CLERK_PUBLISHABLE_KEY`（`@/lib/config`）
- Produces: `export function installBackgroundClerkTokenSource(): void`

- [ ] **Step 1: 写失败的测试**

创建 `extension/src/background/__tests__/identity.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

let createCalls: Array<{ publishableKey: string }> = [];
let createImpl: () => Promise<unknown> = async () => ({ isSignedIn: false, session: null });

// The /background subpath, NOT /client. Its createClerkClient forces
// `background: true`, which is what yields a headless client that works
// without a DOM and loads itself. Mocking the wrong path here would let a
// wrong import in the module under test pass unnoticed.
vi.mock("@clerk/chrome-extension/background", () => ({
  createClerkClient: (opts: { publishableKey: string }) => {
    createCalls.push(opts);
    return createImpl();
  },
}));

let storageListener: ((changes: Record<string, unknown>, area: string) => void) | undefined;

beforeEach(() => {
  createCalls = [];
  createImpl = async () => ({ isSignedIn: false, session: null });
  storageListener = undefined;
  vi.resetModules();

  const data: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => {
          const out: Record<string, unknown> = {};
          for (const k of keys) if (k in data) out[k] = data[k];
          return out;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(data, items);
        }),
        remove: vi.fn(async (keys: string[]) => {
          for (const k of keys) delete data[k];
        }),
      },
      onChanged: {
        addListener: vi.fn((cb) => {
          storageListener = cb;
        }),
      },
    },
  });
});

/** Installs the source and hands back the function it registered. */
async function installedSource() {
  const session = await import("@/lib/session");
  const spy = vi.spyOn(session, "setClerkTokenSource");
  const { installBackgroundClerkTokenSource } = await import("../identity");
  installBackgroundClerkTokenSource();
  const source = spy.mock.calls.at(-1)?.[0];
  if (!source) throw new Error("installBackgroundClerkTokenSource did not set a source");
  return source;
}

describe("installBackgroundClerkTokenSource", () => {
  it("installs a source that reports the signed-in user's token", async () => {
    createImpl = async () => ({
      isSignedIn: true,
      session: { getToken: async () => "worker-token" },
    });
    const source = await installedSource();
    expect(await source()).toEqual({ signedIn: true, token: "worker-token" });
  });

  it("passes the publishable key and never calls load() itself", async () => {
    const load = vi.fn();
    createImpl = async () => ({ isSignedIn: false, session: null, load });
    const source = await installedSource();
    await source();

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].publishableKey).toBeTruthy();
    // createClerkClient({background:true}) already calls
    // load({standardBrowser:false}) internally. A second load() here would be
    // a duplicate round trip against Clerk's Frontend API on every cold start.
    expect(load).not.toHaveBeenCalled();
  });

  it("creates the client once and reuses it across requests", async () => {
    createImpl = async () => ({
      isSignedIn: true,
      session: { getToken: async () => "t" },
    });
    const source = await installedSource();
    await source();
    await source();
    expect(createCalls).toHaveLength(1);
  });

  // A transient Clerk outage at worker cold start must not poison every later
  // request for the rest of that worker's life. The panel's client has the
  // same reset for the same reason — see lib/clerk.ts's `load()`.
  it("does not cache a failure forever", async () => {
    const { setHasSignedIn } = await import("@/lib/storage");
    await setHasSignedIn();

    createImpl = async () => {
      throw new Error("clerk unreachable");
    };
    const source = await installedSource();
    await expect(source()).rejects.toThrow("clerk unreachable");

    createImpl = async () => ({
      isSignedIn: true,
      session: { getToken: async () => "recovered" },
    });
    expect(await source()).toEqual({ signedIn: true, token: "recovered" });
  });

  // Sign-out happens in the PANEL. The worker's cached client would go on
  // reporting a signed-in user until the worker died, so a run started after
  // sign-out would transact as someone who is no longer signed in.
  it("drops the cached client when Clerk's stored JWT changes", async () => {
    createImpl = async () => ({
      isSignedIn: true,
      session: { getToken: async () => "first" },
    });
    const source = await installedSource();
    await source();
    expect(createCalls).toHaveLength(1);

    createImpl = async () => ({
      isSignedIn: true,
      session: { getToken: async () => "second" },
    });
    storageListener?.({ "clerk.career-allpath.com|__clerk_client_jwt|v2": {} }, "local");

    expect(await source()).toEqual({ signedIn: true, token: "second" });
    expect(createCalls).toHaveLength(2);
  });

  it("ignores unrelated storage changes", async () => {
    createImpl = async () => ({
      isSignedIn: true,
      session: { getToken: async () => "t" },
    });
    const source = await installedSource();
    await source();
    storageListener?.({ cp_results: {} }, "local");
    await source();
    expect(createCalls).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行测试，确认它失败**

`npx vitest run src/background/__tests__/identity.test.ts`
预期：FAIL，报无法解析 `../identity`

- [ ] **Step 3: 实现**

创建 `extension/src/background/identity.ts`：

```ts
// The /background subpath, NOT /client. Its createClerkClient forces
// `background: true`, which returns a headless client that works with no DOM
// and calls `load({ standardBrowser: false })` on its own. Importing /client
// here would take the non-background branch, which dynamically imports
// @clerk/ui and needs a document — it fails only in a real browser, with
// every test still green.
import { createClerkClient } from "@clerk/chrome-extension/background";
import { CLERK_PUBLISHABLE_KEY } from "@/lib/config";
import { makeClerkTokenSource, type ClerkLike } from "@/lib/clerkTokenSource";
import { setClerkTokenSource } from "@/lib/session";

/**
 * A fragment of Clerk's own storage key, which is
 * `${frontendApi}|__clerk_client_jwt|v2` — the frontendApi half differs by
 * environment, so match on the stable middle rather than the whole key.
 *
 * If Clerk ever renames this internal constant the match silently stops
 * firing, and the cached client goes stale on sign-out. That degrades to the
 * server rejecting the stale token with a 401, which api.ts already turns
 * into `session_expired` — the existing correct behaviour, NOT a wrong
 * charge. That bounded downside is what makes a substring match acceptable
 * here rather than reaching into the SDK for the real key.
 */
const CLERK_JWT_KEY_FRAGMENT = "__clerk_client_jwt";

/**
 * The loaded client, memoized as a PROMISE so concurrent callers share one
 * `createClerkClient` rather than racing several.
 *
 * Cleared on rejection, NOT on success. A service worker can serve many runs
 * within one wake, so a single Clerk blip at cold start must not refuse every
 * request for the rest of that worker's life — the panel's client carries the
 * same reset for the same reason.
 */
let clerkPromise: Promise<ClerkLike> | undefined;

function getBackgroundClerk(): Promise<ClerkLike> {
  if (!clerkPromise) {
    // Deliberately NOT followed by a load() call: createClerkClient resolves
    // only after it has loaded the client itself.
    clerkPromise = createClerkClient({ publishableKey: CLERK_PUBLISHABLE_KEY }).catch(
      (err: unknown) => {
        clerkPromise = undefined;
        throw err;
      },
    );
  }
  return clerkPromise;
}

/**
 * Gives the service worker the same identity the panel has.
 *
 * Without this, `session.ts`'s module-level `clerkTokenSource` keeps its
 * signed-out default in the worker's realm — a separate JS realm from the
 * panel's — and every background run transacts as the device rather than as
 * the signed-in user, spending the 3-per-30-days device trial while the
 * user's own daily count never moves.
 *
 * Cheap to call at module scope: the Clerk client itself is created lazily,
 * on the first request for a token.
 */
export function installBackgroundClerkTokenSource(): void {
  setClerkTokenSource(makeClerkTokenSource(getBackgroundClerk));

  // Sign-out, sign-in, and token refresh all land as a write to Clerk's JWT
  // key in storage.local, which the panel, the sign-in page and this worker
  // all share. Watching it is what keeps a client cached here from outliving
  // the session it represents, with no message passing.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const key of Object.keys(changes)) {
      if (key.includes(CLERK_JWT_KEY_FRAGMENT)) {
        clerkPromise = undefined;
        return;
      }
    }
  });
}
```

- [ ] **Step 4: 运行测试，确认通过**

`npx vitest run src/background/__tests__/identity.test.ts`
预期：PASS，6 个测试

- [ ] **Step 5: 类型检查**

`npx tsc --noEmit`
预期：无错误

- [ ] **Step 6: 提交**

```bash
git add extension/src/background/identity.ts extension/src/background/__tests__/identity.test.ts
git commit -m "feat(extension): give the service worker a Clerk identity of its own"
```

---

## Task 3: `startRun` 的启动前身份检查

**Files:**
- Modify: `extension/src/background/runs.ts:38-68`
- Modify: `extension/src/background/__tests__/runs.test.ts`

**Interfaces:**
- Consumes: `currentAuthToken`（`@/lib/session`）
- Produces: `StartRunResult` 的 `reason` 联合新增 `"session-expired"`

- [ ] **Step 1: 写失败的测试**

在 `extension/src/background/__tests__/runs.test.ts` 中，于文件顶部已有的 `vi.mock("@/lib/run", ...)` 之后加入 session 的 mock：

```ts
let authImpl: () => Promise<
  { kind: "clerk"; token: string } | { kind: "device"; token: string } | { kind: "session_unavailable" } | null
> = async () => ({ kind: "device", token: "device-token" });

// Unmocked, currentAuthToken() calls ensureToken(), which fires a real
// POST to /api/device-token — refused in CI, but on a developer machine with
// the web app running it mints a live token as a side effect of the suite.
vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, currentAuthToken: () => authImpl() };
});
```

在已有的 `beforeEach` 中，于 `runTailorOpts = [];` 之后加入一行：

```ts
  authImpl = async () => ({ kind: "device", token: "device-token" });
```

在 `describe("startRun", ...)` 内加入以下测试：

```ts
  // The bug this whole plan exists to fix used to make every background run a
  // device run. Now that identity is real, a session we cannot confirm has to
  // stop the run BEFORE it starts — otherwise the user watches a spinner for
  // the better part of a minute and then gets an error that looks like a
  // network problem rather than a sign-in problem.
  it("refuses to start when the session cannot be confirmed", async () => {
    authImpl = async () => ({ kind: "session_unavailable" });

    const result = await startRun(msg());

    expect(result).toEqual({ started: false, reason: "session-expired" });
  });

  // Published, not merely returned. The panel's "Sign in again" button keys
  // off the RUN state, not off the start result, so publishing is what puts a
  // route back to sign-in on screen.
  it("publishes a session_expired run state so the panel can offer sign-in", async () => {
    authImpl = async () => ({ kind: "session_unavailable" });

    await startRun(msg());
    await new Promise((r) => setTimeout(r, 0));

    const live = await getLiveRun(JD.url);
    expect(live?.state.phase).toBe("error");
    expect(live?.state.error?.kind).toBe("session_expired");
  });

  it("does not consult runTailor at all when the session cannot be confirmed", async () => {
    authImpl = async () => ({ kind: "session_unavailable" });
    await startRun(msg());
    expect(runTailorOpts).toHaveLength(0);
  });

  // THE CONSTRAINT THIS MUST NOT BREAK. Anonymous use keeps working exactly
  // as before; sign-in is an upgrade, never a gate. A device caller must sail
  // straight through this check.
  it("starts normally for an anonymous caller on the device identity", async () => {
    authImpl = async () => ({ kind: "device", token: "device-token" });
    expect(await startRun(msg())).toEqual({ started: true });
  });

  it("starts normally for a signed-in caller", async () => {
    authImpl = async () => ({ kind: "clerk", token: "clerk-token" });
    expect(await startRun(msg())).toEqual({ started: true });
  });

  // No device token could be minted and the user is not signed in. The
  // request goes out with no Authorization header and the server treats it as
  // the legacy anon caller — a pre-existing path, not this plan's business.
  it("starts normally when there is no token at all", async () => {
    authImpl = async () => null;
    expect(await startRun(msg())).toEqual({ started: true });
  });
```

- [ ] **Step 2: 运行测试，确认它失败**

`npx vitest run src/background/__tests__/runs.test.ts`
预期：FAIL —— "refuses to start" 得到 `{started: true}`

- [ ] **Step 3: 实现**

在 `extension/src/background/runs.ts` 中：

3a. 加入 import：

```ts
import { currentAuthToken } from "@/lib/session";
```

3b. 扩展 `StartRunResult`（约第 38-40 行）：

```ts
export type StartRunResult =
  | { started: true }
  | {
      started: false;
      reason: "at-capacity" | "already-running" | "failed" | "session-expired";
    };
```

3c. **把 `publish` helper 的定义上移**，放到并发上限检查之后、`prior`/`runId` 计算之前 —— 身份检查要用它，而它只依赖 `forUrl` 和 `msg`。移动后紧接着插入身份检查。该段落最终形如：

```ts
  const running = Object.values(await getAllLiveRuns()).filter((r) => isRunning(r.state));
  if (running.length >= MAX_CONCURRENT_RUNS) return { started: false, reason: "at-capacity" };

  // `resumeFingerprint` travels with every publish, not just the final write:
  // the panel displays these records, so each one has to say which resume it
  // was produced from — see LiveRun's own doc comment.
  const publish = (state: RunState) =>
    putLiveRun(forUrl, {
      state,
      jdTitle: msg.jd.title,
      updatedAt: Date.now(),
      resumeFingerprint: msg.fingerprint,
    });

  // Identity is settled BEFORE a run is minted, so a user whose session
  // cannot be confirmed hears about it on the click rather than after a
  // minute of watching a spinner reach an error that reads like a network
  // fault.
  //
  // Deliberately AFTER the two checks above and not before them: those are
  // local storage reads, while this one can cost a Clerk load() round trip on
  // a cold worker. Ordering it later also keeps `already-running` winning,
  // which matters — that path exists so the panel renders the existing run's
  // own progress, and a session hiccup must not replace that with an error.
  //
  // Only `session_unavailable` stops a run. A device caller and a caller with
  // no token at all both proceed: anonymous use keeps working exactly as it
  // did, and sign-in stays an upgrade rather than a gate.
  const auth = await currentAuthToken();
  if (auth?.kind === "session_unavailable") {
    // PUBLISHED, not merely returned. The panel's "Sign in again" button
    // renders off the run state (App.tsx), not off this result, so publishing
    // is the thing that puts a route back to sign-in on screen. The wording
    // matches lib/api.ts's for the same condition, so a user sees one
    // sentence for one problem however they reach it.
    await publish({
      ...INITIAL_RUN_STATE,
      phase: "error",
      error: {
        kind: "session_expired",
        message: "We couldn't confirm your session. Sign in again to continue.",
      },
    });
    return { started: false, reason: "session-expired" };
  }
```

3d. 删除原先位于 `runId` 计算之后的那份 `publish` 定义（含其文档注释），它已上移。

- [ ] **Step 4: 运行测试，确认通过**

`npx vitest run src/background/__tests__/runs.test.ts`
预期：PASS，包含 6 个新测试，且原有测试全部仍然通过

- [ ] **Step 5: 类型检查**

`npx tsc --noEmit`
预期：无错误

- [ ] **Step 6: 提交**

```bash
git add extension/src/background/runs.ts extension/src/background/__tests__/runs.test.ts
git commit -m "feat(extension): settle identity before a background run starts"
```

---

## Task 4: 接线 —— worker 装载 + 面板静默

**Files:**
- Modify: `extension/src/background/index.ts`
- Modify: `extension/src/background/__tests__/panel.test.ts`
- Modify: `extension/src/sidepanel/App.tsx:539-547`
- Modify: `extension/src/sidepanel/__tests__/App.test.tsx`

**Interfaces:**
- Consumes: `installBackgroundClerkTokenSource`（Task 2）；`StartRunResult` 的 `"session-expired"`（Task 3）

**⚠️ 注意连锁反应：** 给 `background/index.ts` 加模块作用域调用后，`panel.test.ts` 会失败 —— 它的 chrome stub 里没有 `storage.onChanged`，而 `installBackgroundClerkTokenSource()` 会在模块加载时注册监听。Step 3 修这个。

- [ ] **Step 1: 写失败的测试**

创建 `extension/src/background/__tests__/identity-wiring.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/token", () => ({ ensureToken: vi.fn(async () => "test-device-token") }));
vi.mock("@clerk/chrome-extension/background", () => ({
  createClerkClient: async () => ({ isSignedIn: false, session: null }),
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("chrome", {
    sidePanel: { setPanelBehavior: vi.fn(async () => {}), setOptions: vi.fn(async () => {}) },
    tabs: { onCreated: { addListener: vi.fn() }, query: vi.fn(async () => []) },
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
    },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn() },
    },
  });
});

/**
 * THE REGRESSION TEST FOR THIS ENTIRE PLAN.
 *
 * session.ts's `clerkTokenSource` is a module-level variable that defaults to
 * signed-out, and the service worker is a JS realm of its own. For the whole
 * life of the background-runs feature nothing in the worker replaced that
 * default, so every run transacted as the device and no user's quota was ever
 * charged — with every test in the suite green, because no test asked whether
 * the worker had an identity. This one asks.
 */
describe("the service worker's identity", () => {
  it("installs a Clerk token source when the worker starts", async () => {
    const session = await import("@/lib/session");
    const spy = vi.spyOn(session, "setClerkTokenSource");

    await import("../index");

    expect(spy).toHaveBeenCalled();
  });
});
```

在 `extension/src/sidepanel/__tests__/App.test.tsx` 中，**紧接在已有的 `it("explains the concurrency cap rather than failing silently", ...)`（约第 2878 行）之后**加入下面这个测试。它逐字沿用该文件既有的模式：`sendMessageImpl`、`activeJdState`、`setResume`、`renderApp`、`findButton`、`flush`。

```ts
  // The refusal has already published a session_expired run state, and the
  // panel renders that with a "Sign in again" button. A notice on top of it
  // would tell the user their run "couldn't start" — true, but useless —
  // right beside the one control that actually fixes it. Silence is the
  // correct amount to say, exactly as for `already-running`.
  it("says nothing extra when the background refuses for an expired session", async () => {
    sendMessageImpl = async () => ({ started: false, reason: "session-expired" });
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await setResume(STORED_RESUME);
    await renderApp();

    await act(async () => {
      findButton(container, "Tailor my resume").click();
    });
    await flush();

    expect(container.textContent).not.toContain("Couldn't start that run.");
  });
```

- [ ] **Step 2: 运行测试，确认它失败**

`npx vitest run src/background/__tests__/identity-wiring.test.ts src/sidepanel/__tests__/App.test.tsx`
预期：FAIL —— worker 未装载 source；面板显示了 "Couldn't start that run"

- [ ] **Step 3: 实现**

3a. 在 `extension/src/background/index.ts` 顶部的 import 之后加入：

```ts
import { installBackgroundClerkTokenSource } from "./identity";
```

并在文件的 `chrome.sidePanel.setPanelBehavior(...)` 调用之前加入：

```ts
// Module scope, so the worker has an identity before any message handler can
// run — including the cold start where the wake IS a start-run message. It
// costs nothing here: the Clerk client is created lazily, on the first
// request for a token. Without this call, session.ts's signed-out default
// stands in this realm and every background run is a device run.
installBackgroundClerkTokenSource();
```

3b. 在 `extension/src/background/__tests__/panel.test.ts` 的 `vi.stubGlobal("chrome", {...})` 中加入 storage（`index.ts` 现在会在模块作用域注册监听）：

```ts
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
      onChanged: { addListener: vi.fn() },
    },
```

并在该文件顶部已有的 `vi.mock("@/lib/token", ...)` 之后加入：

```ts
// index.ts now imports background/identity.ts, which imports the Clerk SDK.
// Nothing here asserts on identity; stub it so these tests stay about panels.
vi.mock("@clerk/chrome-extension/background", () => ({
  createClerkClient: async () => ({ isSignedIn: false, session: null }),
}));
```

3c. 在 `extension/src/sidepanel/App.tsx` 中，把第 539 行的条件改为：

```ts
      if (
        result?.started !== true &&
        result?.reason !== "already-running" &&
        result?.reason !== "session-expired"
      ) {
```

并把其下方已有的注释扩写为：

```ts
        // `already-running` and `session-expired` say nothing, on purpose:
        // the refresh below is about to put a published run state on screen,
        // and in both cases that state tells the user more than a notice
        // could — the run's own progress for the first, and an error carrying
        // a "Sign in again" button for the second. Everything else — the cap,
        // a worker that fell over, an undefined answer from a message channel
        // that closed — has to be said out loud, or the click looks ignored.
```

- [ ] **Step 4: 运行全部测试**

`npx vitest run`
预期：PASS，全绿，含 `panel.test.ts`

- [ ] **Step 5: 类型检查、lint 与构建**

```bash
npm run lint
npm run build
```
预期：均无错误（`build` 已包含 `tsc --noEmit`）。**构建必须过** —— 这是唯一会检查 `@clerk/chrome-extension/background` 能否在 worker 的打包产物中被真正解析的环节，测试里的 mock 绕过了它。

- [ ] **Step 6: 提交**

```bash
git add extension/src/background/index.ts extension/src/background/__tests__/panel.test.ts extension/src/background/__tests__/identity-wiring.test.ts extension/src/sidepanel/App.tsx extension/src/sidepanel/__tests__/App.test.tsx
git commit -m "feat(extension): install the worker's Clerk identity at startup"
```

---

## 真实浏览器验证（不可跳过）

单元测试无法证明这个修复成立。本仓库反复出现"测试全绿、浏览器里坏掉"的情况（`web_accessible_resources`、OAuth 回跳、service worker 回收都是如此）。

按顺序执行：

1. `npm run build`，在 `chrome://extensions` 重新加载解压的 `extension/dist`。
2. **确认装的是新包**：`grep -c "installBackgroundClerkTokenSource\|__clerk_client_jwt" extension/dist/assets/*.js` —— 应有非零命中。
3. 登录，打开一个招聘页，记下面板显示的 "runs left today"。
4. 生成一次，等它完成。**该数字必须减 1。** 不减就是没修好 —— 别继续往下测。
5. 连续生成直到用尽，确认服务端返回 402 且面板给出额度用尽的提示。
6. 登出，再生成一次，确认匿名/设备路径仍然可用。
7. 重新登录，在 DevTools 里执行
   `chrome.storage.local.remove(Object.keys(await chrome.storage.local.get(null)).filter(k => k.includes('__clerk_client_jwt')))`
   然后点 Tailor。**必须立刻**出现 "Sign in again"，而不是转约 40 秒后报错。
8. 开三个招聘页并行生成，确认后台并发未被本次改动破坏。

---

## Self-Review 记录

**Spec 覆盖检查：** 逐条对照 spec 的各节 —— 共享工厂（Task 1）、`getBackgroundClerk` 记忆化契约含失败重置（Task 2 Step 3 + 测试"does not cache a failure forever"）、storage 失效（Task 2）、启动前拒绝及其排序（Task 3）、发布 `session_expired` 状态（Task 3）、`StartRunResult` 新理由（Task 3）、模块作用域装载（Task 4）、面板静默（Task 4）、五条测试要求（分散于四个 Task）、验收标准（真实浏览器验证第 3-7 步）。无遗漏。

**占位符扫描：** 无 TBD/TODO；每个代码步骤都给了可直接粘贴的实际代码。

**类型一致性：** `ClerkLike` 与 `makeClerkTokenSource` 在 Task 1 定义，Task 2 按同名同签名使用；`installBackgroundClerkTokenSource` 在 Task 2 定义，Task 4 使用；`"session-expired"` 在 Task 3 加入联合类型，Task 4 消费。一致。
