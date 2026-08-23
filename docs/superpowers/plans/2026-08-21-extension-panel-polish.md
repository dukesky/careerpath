# Extension Panel Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the extension panel from looking like it requires an account — lead with the quota the user already has, return them to the panel automatically after sign-in, explain the permission prompt before it appears, give them a way out to the web app, and let a beta code work in the panel the way it already does on the web.

**Architecture:** Five additive changes to the side panel plus one to the sign-in page. A new `lib/quota.ts` fetches the caller's real allowance from the existing `GET /api/quota` so the panel can lead with a number instead of a sign-in pitch; a `chrome.storage.onChanged` listener replaces guessing at side-panel visibility semantics as the signal that sign-in completed; the rest is copy, links, and one new request header. No server changes.

**Tech Stack:** TypeScript, React 19, Vite + @crxjs/vite-plugin, Vitest + jsdom, Chrome MV3.

## Global Constraints

- **Work in this worktree only:** `/Users/tianzhang/Projects/careerpath/.claude/worktrees/ext-access`, branch `feat/extension-page-access`. Do not `cd` to the main checkout. Never use bare `git stash` / `git stash pop`.
- **The server is not modified by this plan.** Every requirement here is satisfied by existing endpoints. If a task seems to need a server change, stop and report — it means an assumption is wrong.
- **Anonymous use must not regress.** A signed-out user stays on 3 runs per rolling 30 days and never needs to sign in for anything.
- **UI copy is English. Code and comments are English.** Use the exact strings this plan gives; do not paraphrase them.
- **Do not touch the concurrency machinery in `App.tsx`:** `generate()`'s internals, the JD-change effect, `runningForUrlRef`, `runningSupplementRef`, or the `busy`/`saving` gating. Every change in this plan is additive.
- **Do not modify** `extension/src/lib/session.ts` or `extension/src/lib/cache.ts`.
- **Baseline to preserve:** extension 153/153, root 84/84, `npx tsc --noEmit --project extension/tsconfig.json`, both lints, both builds — all clean.
- **The permission copy must not imply Chrome scopes the grant to one site.** Chrome grants all sites; the copy states what career-path *does* with it. Keep those two claims separate — this is a truthfulness requirement, not a style preference.

---

## File Structure

| File | Responsibility | Task |
|------|----------------|------|
| `extension/src/lib/api.ts` | Add `apiGet`; add the `x-access-code` header | 1, 5 |
| `extension/src/lib/quota.ts` (new) | `QuotaInfo` type + `fetchQuota()` — the panel's only quota source | 1 |
| `extension/src/lib/storage.ts` | Export `HAS_SIGNED_IN_KEY`; add the beta-code triplet | 3, 5 |
| `extension/src/sidepanel/AccountBar.tsx` | Quota-first signed-out rendering; `unlimited` support | 2 |
| `extension/src/sidepanel/App.tsx` | Quota state + refresh rule; storage listener; permission copy; links; beta box wiring | 2, 3, 4, 5 |
| `extension/src/sidepanel/BetaCodeBox.tsx` (new) | The beta-code input and its own apply/remove state machine | 5 |
| `extension/src/signin/main.ts` | Write the signed-in flag, then close the tab | 3 |
| `extension/src/lib/__tests__/quota.test.ts` (new) | `fetchQuota()` mapping | 1 |
| `extension/src/lib/__tests__/api.test.ts` | `apiGet`; the beta header | 1, 5 |
| `extension/src/sidepanel/__tests__/App.test.tsx` | Everything reachable through `App` | 2, 3, 4, 5 |

---

## Task 1: The quota data layer

**Files:**
- Modify: `extension/src/lib/api.ts`
- Create: `extension/src/lib/quota.ts`
- Test: `extension/src/lib/__tests__/api.test.ts`, `extension/src/lib/__tests__/quota.test.ts` (new)

**Interfaces:**
- Consumes: `send()` and `ApiResult<T>` from `./api` (both already exist).
- Produces:
  - `export function apiGet<T>(path: string): Promise<ApiResult<T>>`
  - `export type QuotaInfo = { remaining: number | null; unlimited: boolean }`
  - `export async function fetchQuota(): Promise<QuotaInfo | null>` — `null` means "could not determine", which callers must render as *unknown*, never as zero.

**Background the implementer needs:** `GET /api/quota` already exists and already works for signed-in, signed-out-device, and beta callers. It returns `{ remaining, used, limit }` normally, `{ remaining: null, unlimited: true }` when a valid beta code is present, and `{ remaining: null }` when the Redis store is unreachable. It is a read — it does not consume any allowance.

- [ ] **Step 1: Write the failing test for `apiGet`**

Add to `extension/src/lib/__tests__/api.test.ts`. Read the top of that file first and follow its existing `fetch` stubbing pattern rather than inventing a new one.

```ts
it("apiGet issues a GET to the API base", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ remaining: 3 }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  const res = await apiGet<{ remaining: number }>("/api/quota");

  expect(res).toEqual({ ok: true, data: { remaining: 3 } });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url.endsWith("/api/quota")).toBe(true);
  expect(init.method).toBe("GET");
});
```

Add `apiGet` to that file's import from `../api`.

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm --prefix extension run test -- src/lib/__tests__/api.test.ts
```

Expected: FAIL — `apiGet` is not exported.

- [ ] **Step 3: Add `apiGet`**

In `extension/src/lib/api.ts`, directly above the existing `apiPost`:

```ts
/**
 * A GET through the same identity and 401 handling as every other call —
 * `send()` is where the Clerk-vs-device fork lives, so a GET that bypassed it
 * would report a different caller's quota than the POSTs it is describing.
 */
export function apiGet<T>(path: string): Promise<ApiResult<T>> {
  return send<T>(path, { method: "GET" });
}
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
npm --prefix extension run test -- src/lib/__tests__/api.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the failing tests for `fetchQuota`**

Create `extension/src/lib/__tests__/quota.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ApiResult } from "../api";
import { fetchQuota } from "../quota";

let apiGetImpl: (path: string) => Promise<ApiResult<unknown>> = async () => ({
  ok: true,
  data: {},
});
let apiGetPaths: string[] = [];

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    apiGet: <T,>(path: string) => {
      apiGetPaths.push(path);
      return apiGetImpl(path) as Promise<ApiResult<T>>;
    },
  };
});

beforeEach(() => {
  apiGetPaths = [];
  apiGetImpl = async () => ({ ok: true, data: {} });
});

describe("fetchQuota", () => {
  it("reads the caller's remaining count from /api/quota", async () => {
    apiGetImpl = async () => ({ ok: true, data: { remaining: 3, used: 0, limit: 3 } });

    expect(await fetchQuota()).toEqual({ remaining: 3, unlimited: false });
    expect(apiGetPaths).toEqual(["/api/quota"]);
  });

  it("reports unlimited when a beta code is in force", async () => {
    apiGetImpl = async () => ({ ok: true, data: { remaining: null, unlimited: true } });

    expect(await fetchQuota()).toEqual({ remaining: null, unlimited: true });
  });

  // The server returns this shape when its store is unreachable. "Remaining
  // is unknown" must not collapse into "remaining is zero" — the panel would
  // tell a user with a full allowance that they are out of runs.
  it("reports an unknown remaining count as null, not zero", async () => {
    apiGetImpl = async () => ({ ok: true, data: { remaining: null } });

    expect(await fetchQuota()).toEqual({ remaining: null, unlimited: false });
  });

  // A failed request is NOT the same as "no allowance". Returning null lets
  // the panel render "unknown" rather than inventing a number.
  it("returns null when the request itself fails", async () => {
    apiGetImpl = async () => ({ ok: false, kind: "network", message: "nope" });

    expect(await fetchQuota()).toBeNull();
  });

  // Guards against a shape change on the server silently becoming NaN or a
  // string in the panel's headline.
  it("ignores a non-numeric remaining", async () => {
    apiGetImpl = async () => ({ ok: true, data: { remaining: "3" } });

    expect(await fetchQuota()).toEqual({ remaining: null, unlimited: false });
  });
});
```

- [ ] **Step 6: Run them and confirm they fail**

```bash
npm --prefix extension run test -- src/lib/__tests__/quota.test.ts
```

Expected: FAIL — `../quota` does not exist.

- [ ] **Step 7: Write `lib/quota.ts`**

```ts
import { apiGet } from "./api";

/**
 * What the panel knows about the caller's allowance right now.
 *
 * `remaining: null` means UNKNOWN, never zero. The two are rendered
 * differently and must not be conflated: an unknown count shows no number at
 * all, while zero tells the user they are out of runs. The server returns an
 * unknown count whenever its store is unreachable, which is exactly when
 * telling a user they have no runs left would be both wrong and unhelpful.
 */
export type QuotaInfo = { remaining: number | null; unlimited: boolean };

/** The subset of GET /api/quota this module reads. */
interface QuotaResponse {
  remaining?: unknown;
  unlimited?: unknown;
}

/**
 * The caller's current allowance, or `null` if it could not be determined.
 *
 * Callers MUST treat `null` as "unknown" and render no number — see the note
 * on QuotaInfo. This is a read: it costs the user nothing.
 */
export async function fetchQuota(): Promise<QuotaInfo | null> {
  const res = await apiGet<QuotaResponse>("/api/quota");
  if (!res.ok) return null;
  const { remaining, unlimited } = res.data;
  return {
    remaining:
      typeof remaining === "number" && Number.isFinite(remaining) ? remaining : null,
    unlimited: unlimited === true,
  };
}
```

- [ ] **Step 8: Run the full verification**

```bash
npx tsc --noEmit --project extension/tsconfig.json && npm --prefix extension run test && npm --prefix extension run lint && npm --prefix extension run build
```

Expected: all clean; test count 153 + 6 new.

- [ ] **Step 9: Commit**

```bash
git add extension/src/lib/api.ts extension/src/lib/quota.ts extension/src/lib/__tests__/api.test.ts extension/src/lib/__tests__/quota.test.ts
git commit -m "feat(extension): read the caller's real quota from the API"
```

---

## Task 2: Lead with the quota, not the sign-in pitch

**Files:**
- Modify: `extension/src/sidepanel/AccountBar.tsx`, `extension/src/sidepanel/App.tsx`
- Test: `extension/src/sidepanel/__tests__/App.test.tsx`

**Interfaces:**
- Consumes: `fetchQuota`, `QuotaInfo` from `@/lib/quota` (Task 1).
- Produces: `AccountBar` gains a required `unlimited: boolean` prop alongside its existing `remaining: number | null`. `App` gains `refreshQuota()`, which Tasks 3 and 5 also call.

**Why this task exists:** `AccountBar`'s signed-out branch currently leads with the label **"Not signed in"** and a sentence about what signing in would buy. `remaining` comes from `RunState`, which is `null` until a run finishes — so on first open the one reassuring fact (*you already have 3 runs*) is the one thing not shown. The panel's first impression is a pitch for an account the user does not need.

**The trap in this task, stated plainly:** you are adding a SECOND source for `remaining`. The last review round fixed a bug where signing out left the previous account's daily count on screen under 30-day-tier wording. A fallback to `quota.remaining` reintroduces exactly that bug unless the quota is refetched — and cleared first — whenever the identity changes.

- [ ] **Step 1: Write the failing tests**

Add to `extension/src/sidepanel/__tests__/App.test.tsx`. First extend the existing `@/lib/api` mock (around line 171) to also intercept `apiGet`, following the shape already used for `apiPost`:

```ts
let apiGetImpl: (path: string) => Promise<ApiResult<unknown>> = async () => ({
  ok: true,
  data: { remaining: 3 },
});
let apiGetPaths: string[] = [];
```

Add `apiGet` to the mock's returned object:

```ts
apiGet: <T,>(path: string) => {
  apiGetPaths.push(path);
  return apiGetImpl(path) as Promise<ApiResult<T>>;
},
```

and reset both in the existing `beforeEach`:

```ts
apiGetImpl = async () => ({ ok: true, data: { remaining: 3 } });
apiGetPaths = [];
```

Then add a new describe block:

```ts
describe("App - quota-first account bar", () => {
  it("shows the caller's real remaining count on open, before any run", async () => {
    apiGetImpl = async () => ({ ok: true, data: { remaining: 3 } });
    await renderApp();

    expect(apiGetPaths).toContain("/api/quota");
    expect(container.textContent).toContain("3 runs left");
  });

  // The single line most responsible for the panel reading as a gate.
  it("never labels the signed-out state 'Not signed in'", async () => {
    await renderApp();

    expect(container.textContent).not.toContain("Not signed in");
    expect(findAnchor(container, "Sign in")).toBeTruthy();
  });

  it("invents no number when the quota cannot be determined", async () => {
    apiGetImpl = async () => ({ ok: false, kind: "network", message: "nope" });
    await renderApp();

    expect(container.textContent).not.toContain("runs left");
    expect(container.textContent).toContain("Sign in for 5 runs a day.");
  });

  it("shows Beta · unlimited instead of a number when a beta code is in force", async () => {
    apiGetImpl = async () => ({ ok: true, data: { remaining: null, unlimited: true } });
    await renderApp();

    expect(container.textContent).toContain("Beta · unlimited");
    expect(container.textContent).not.toContain("runs left");
  });

  // A completed run's count is fresher than the one fetched at open.
  it("prefers the count a completed run reported over the one fetched at open", async () => {
    apiGetImpl = async () => ({ ok: true, data: { remaining: 3 } });
    clerkState = { signedIn: true, email: "ada@example.com" };
    activeJdState = { jd: JD_A, failure: null, loading: false };
    await setResume(STORED_RESUME);
    await renderApp();

    runTailorImpl = async (_jd, _resume, onUpdate) => {
      onUpdate({ phase: "done", analysis: ANALYSIS, tailored: TAILORED, remaining: 1 });
    };
    await act(async () => {
      findButton(container, "Tailor my resume").click();
    });
    await flush();

    expect(container.textContent).toContain("1 run left today");
    expect(container.textContent).not.toContain("3 runs left");
  });

  // THE REGRESSION GUARD. Signing out switches quota buckets (5/day ->
  // 3-per-30-days). Without a refetch the panel falls back to the quota
  // fetched for the PREVIOUS identity and shows that account's leftovers
  // under signed-out wording — the exact bug the last review round fixed,
  // arriving through the new fallback path.
  it("does not show the previous account's allowance after signing out", async () => {
    apiGetImpl = async () => ({ ok: true, data: { remaining: 5 } });
    clerkState = { signedIn: true, email: "ada@example.com" };
    await setResume(STORED_RESUME);
    await renderApp();
    expect(container.textContent).toContain("5 runs left today");

    // The signed-out identity has a different allowance.
    apiGetImpl = async () => ({ ok: true, data: { remaining: 2 } });

    await act(async () => {
      findButton(container, "Sign out").click();
    });
    const dialog = container.querySelector(".dialog") as HTMLElement;
    await act(async () => {
      findButton(dialog, "Sign out").click();
    });
    await flush();

    expect(container.textContent).not.toContain("5 runs left");
    expect(container.textContent).toContain("2 runs left");
  });
});
```

If `ANALYSIS` / `TAILORED` / `JD_A` / `STORED_RESUME` / `renderApp` / `flush` are named differently in this file, use the file's own names — do not add duplicates.

- [ ] **Step 2: Run them and confirm they fail**

```bash
npm --prefix extension run test -- src/sidepanel/__tests__/App.test.tsx
```

Expected: FAIL — no `/api/quota` call, and "Not signed in" still present.

- [ ] **Step 3: Rewrite `AccountBar`'s two branches**

Add the `unlimited` prop. In the props type, beside the existing `remaining`:

```ts
  /**
   * From GET /api/quota, not from the run — a beta code lifts the cap
   * entirely, so there is no number to show and showing one would be a lie.
   */
  unlimited: boolean;
```

Replace the signed-out branch's inner `<div>` (currently the "Not signed in" label, the sign-in sentence, and the conditional count) with:

```tsx
          <div>
            {/* The allowance leads. What the user HAS is the fact that
                belongs first; what signing in would add is secondary. The
                old "Not signed in" label led with what they lacked, which
                is why the panel read as a gate for a feature that has never
                required an account. */}
            {unlimited ? (
              <div className="label">Beta · unlimited</div>
            ) : remaining !== null ? (
              // No "today" here — the signed-out device tier is 3 runs per
              // 30 days, not a daily allowance, so borrowing the signed-in
              // branch's "left today" wording would misstate the period.
              <div className="label">
                {remaining} run{remaining === 1 ? "" : "s"} left
              </div>
            ) : null}
            <p className="muted tiny">Sign in for 5 runs a day.</p>
          </div>
```

In the signed-in branch, replace the existing conditional count paragraph with:

```tsx
          {unlimited ? (
            <p className="muted tiny">Beta · unlimited</p>
          ) : remaining !== null ? (
            <p className="muted tiny">
              {remaining} run{remaining === 1 ? "" : "s"} left today
            </p>
          ) : null}
```

- [ ] **Step 4: Wire the quota into `App.tsx`**

Add the import:

```ts
import { fetchQuota, type QuotaInfo } from "@/lib/quota";
```

Add state beside the existing `signedIn`/`email` declarations:

```ts
  // The allowance as of the last identity change, from GET /api/quota.
  // `state.remaining` (what a completed run reported) takes precedence when
  // present — it is strictly fresher. Null here means UNKNOWN, not zero.
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
```

Add the refresher next to `refreshAccount`:

```ts
  /**
   * Re-reads the allowance. MUST be called on every identity change —
   * sign-in, sign-out, and a beta code taking effect all move the caller to
   * a different quota bucket, and a stale number here is not a cosmetic
   * problem: it is the panel stating an allowance that is not the user's.
   *
   * Clears to null BEFORE awaiting, deliberately. The request takes a round
   * trip, and leaving the old value up during it shows the PREVIOUS
   * identity's allowance — briefly, but wrongly. Rendering "unknown" for a
   * moment is the honest option.
   */
  const refreshQuota = useCallback(async () => {
    setQuota(null);
    setQuota(await fetchQuota());
  }, []);
```

Call it from the existing mount effect, beside `void refreshAccount()`:

```ts
    void refreshQuota();
```

and add `refreshQuota` to that effect's dependency array.

Call it from `handleSignedOut()`, after the two existing setters:

```ts
    // The identity just changed — the signed-out tier has a different
    // allowance than the account that was signed in a moment ago.
    void refreshQuota();
```

Derive the displayed values just above the `return (`:

```ts
  // A completed run's count is fresher than the one fetched when the panel
  // opened, so it wins when present.
  const displayRemaining = state.remaining ?? quota?.remaining ?? null;
  const displayUnlimited = quota?.unlimited === true;
```

Pass them to `AccountBar`, replacing `remaining={state.remaining}`:

```tsx
        remaining={displayRemaining}
        unlimited={displayUnlimited}
```

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
npm --prefix extension run test -- src/sidepanel/__tests__/App.test.tsx
```

Expected: PASS, including the sign-out regression guard.

- [ ] **Step 6: Full verification**

```bash
npx tsc --noEmit --project extension/tsconfig.json && npm --prefix extension run test && npm --prefix extension run lint && npm --prefix extension run build
```

- [ ] **Step 7: Commit**

```bash
git add extension/src/sidepanel/AccountBar.tsx extension/src/sidepanel/App.tsx extension/src/sidepanel/__tests__/App.test.tsx
git commit -m "feat(extension): lead the account bar with the allowance the user already has"
```

---

## Task 3: Return to the panel automatically after sign-in

**Files:**
- Modify: `extension/src/lib/storage.ts`, `extension/src/signin/main.ts`, `extension/src/sidepanel/App.tsx`
- Test: `extension/src/sidepanel/__tests__/App.test.tsx`

**Interfaces:**
- Consumes: `refreshAccount` and `refreshQuota` from `App` (Task 2); `setHasSignedIn` from `@/lib/storage` (already exists).
- Produces: `export const HAS_SIGNED_IN_KEY = "cp_has_signed_in"` from `@/lib/storage`.

**Two separate defects, one mechanism fixes both:**

1. The sign-in page tells the user to close the tab themselves.
2. **The panel may never learn the sign-in happened.** It re-checks on `document.visibilitychange`, but a side panel is persistent — it stays visible while the user is over in the sign-in tab, so `visibilityState` may never change and the event may never fire. Task 5's implementer flagged this as unverifiable at the time; the user's browser testing confirmed it.

`chrome.storage.onChanged` broadcasts across every extension context and does not depend on visibility semantics at all, which is precisely the thing the current approach guesses at.

**This also closes a finding parked at the final review:** `signin/main.ts` never writes `cp_has_signed_in`, so between completing sign-in and the panel's next successful Clerk contact, an unreachable Clerk would misclassify a genuinely signed-in user as anonymous. The write added here closes that window.

- [ ] **Step 1: Export the storage key**

In `extension/src/lib/storage.ts`, change the private constant to an exported one:

```ts
/**
 * Exported because App.tsx filters chrome.storage.onChanged on it. This
 * repository has been bitten three times by a constant that had to agree
 * across two files with nothing tying them together — importing it is
 * cheaper than another drift guard.
 */
export const HAS_SIGNED_IN_KEY = "cp_has_signed_in";
```

Leave every existing use of it in that file as-is.

- [ ] **Step 2: Write the failing test**

The test file's `fakeChromeStorage()` helper has no `onChanged`. Extend it so listeners can be registered and fired:

```ts
function fakeChromeStorage() {
  const data: Record<string, unknown> = {};
  const listeners: Array<
    (changes: Record<string, { newValue?: unknown }>, area: string) => void
  > = [];
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
      onChanged: {
        addListener: vi.fn(
          (fn: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => {
            listeners.push(fn);
          },
        ),
        removeListener: vi.fn(
          (fn: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => {
            const i = listeners.indexOf(fn);
            if (i >= 0) listeners.splice(i, 1);
          },
        ),
      },
    },
    // Test-only hook: fires what Chrome would fire.
    __fireStorageChange(changes: Record<string, { newValue?: unknown }>, area = "local") {
      for (const fn of [...listeners]) fn(changes, area);
    },
  };
}
```

Add the test:

```ts
describe("App - noticing a sign-in from the other tab", () => {
  // The side panel stays visible while the user is over in the sign-in tab,
  // so visibilitychange may never fire. chrome.storage.onChanged does not
  // depend on visibility at all — it is the signal that actually arrives.
  it("picks up a completed sign-in from a storage change, with no visibility event", async () => {
    await renderApp();
    expect(findAnchor(container, "Sign in")).toBeTruthy();

    clerkState = { signedIn: true, email: "ada@example.com" };
    apiGetImpl = async () => ({ ok: true, data: { remaining: 5 } });

    await act(async () => {
      (globalThis.chrome as unknown as {
        __fireStorageChange: (c: Record<string, { newValue?: unknown }>) => void;
      }).__fireStorageChange({ cp_has_signed_in: { newValue: true } });
    });
    await flush();

    expect(container.textContent).toContain("ada@example.com");
    expect(container.textContent).toContain("5 runs left today");
  });

  it("ignores storage changes to unrelated keys", async () => {
    await renderApp();
    clerkState = { signedIn: true, email: "ada@example.com" };

    await act(async () => {
      (globalThis.chrome as unknown as {
        __fireStorageChange: (c: Record<string, { newValue?: unknown }>) => void;
      }).__fireStorageChange({ cp_resume: { newValue: "something" } });
    });
    await flush();

    expect(container.textContent).not.toContain("ada@example.com");
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

```bash
npm --prefix extension run test -- src/sidepanel/__tests__/App.test.tsx
```

Expected: FAIL — no listener is registered, so the panel stays signed out.

- [ ] **Step 4: Add the storage listener to `App.tsx`**

Import the key:

```ts
import { HAS_SIGNED_IN_KEY } from "@/lib/storage";
```

(add it to the existing `@/lib/storage` import rather than a second import statement)

Add this effect directly after the existing `visibilitychange` effect:

```ts
  // The signal that actually arrives when sign-in completes in its own tab.
  //
  // The visibility effect above is a guess: a side panel stays visible the
  // whole time the user is over in that tab, so `visibilityState` may never
  // change and that listener may never fire. chrome.storage.onChanged
  // broadcasts to every extension context regardless of what is visible, and
  // the sign-in page writes HAS_SIGNED_IN_KEY as its last act before closing
  // itself. Both listeners stay: this one covers the sign-in path, and the
  // visibility one still covers changes made somewhere this never hears
  // about, such as signing out in Clerk's own account portal.
  useEffect(() => {
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== "local" || !(HAS_SIGNED_IN_KEY in changes)) return;
      void refreshAccount();
      void refreshQuota();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [refreshAccount, refreshQuota]);
```

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
npm --prefix extension run test -- src/sidepanel/__tests__/App.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Update the sign-in page**

In `extension/src/signin/main.ts`, add the import:

```ts
import { setHasSignedIn } from "@/lib/storage";
```

Replace `renderSignedIn`'s two message strings with:

```ts
  p.textContent = email
    ? `Signed in as ${email}. The panel is ready — you can close this tab.`
    : "You're signed in. The panel is ready — you can close this tab.";
```

(The old copy said "return to the panel", which asked the user to do something. By the time this renders, the panel has already updated itself via the storage listener, so the accurate statement is that it is ready.)

Replace the `.then` callback with:

```ts
  .then(async (clerk) => {
    if (clerk.isSignedIn) {
      // Order matters. The flag is what tells the panel (via
      // chrome.storage.onChanged) that sign-in finished, so it must be
      // written BEFORE this tab tries to close itself — a close that lands
      // first would take the notification with it. setHasSignedIn swallows
      // its own failures, so this cannot reject.
      await setHasSignedIn();
      // Rendered before the close attempt, not after: window.close() may be
      // refused for a tab the extension did not open with script (this one
      // is opened by a plain <a target="_blank">), and the user must not be
      // left staring at a blank page in that case.
      renderSignedIn(container, clerk.user?.primaryEmailAddress?.emailAddress ?? null);
      window.close();
      return;
    }
    clerk.mountSignIn(container, {});
  })
```

- [ ] **Step 7: Full verification**

```bash
npx tsc --noEmit --project extension/tsconfig.json && npm --prefix extension run test && npm --prefix extension run lint && npm --prefix extension run build
```

**State plainly in your report that `signin/main.ts` has no test coverage** — this package has no page-level test harness, so the flag write, the close attempt, and the copy are all unverified until someone loads the extension. Do not present a green build as coverage for them.

- [ ] **Step 8: Commit**

```bash
git add extension/src/lib/storage.ts extension/src/signin/main.ts extension/src/sidepanel/App.tsx extension/src/sidepanel/__tests__/App.test.tsx
git commit -m "feat(extension): return to the panel automatically after sign-in"
```

---

## Task 4: Explain the permission prompt, and offer a way out to the web app

**Files:**
- Modify: `extension/src/sidepanel/App.tsx`
- Test: `extension/src/sidepanel/__tests__/App.test.tsx`

**Interfaces:**
- Consumes: `API_BASE` from `@/lib/config` and `signedIn` from `App`'s own state — both already present.
- Produces: nothing new exported.

**On the permission copy.** Clicking **Read this site** calls `chrome.permissions.request({ origins: ["http://*/*", "https://*/*"] })`, and Chrome renders that as *"Read and change all your data on all websites"* — the most alarming string it has, shown at the moment the user is trying to get something done.

Narrowing the request to just the current site is **not available**: it would require knowing the tab's URL, and `tab.url` is gated behind the `tabs` permission, which the project has decided not to add. The chicken-and-egg is real — the code reaches this branch precisely because `executeScript` failed, which means `activeTab` is not in force for this tab, which means `tab.url` is unreadable. So the request stays broad and the fix is to tell the user what is about to happen.

**The copy must keep two claims separate, and this is a correctness requirement:** Chrome really does grant access to every site — do not imply it scopes the grant to one. What is limited is what career-path *does* with it. Every sentence below is already promised on `/privacy`; none of it is new.

- [ ] **Step 1: Write the failing tests**

```ts
describe("App - permission explanation and the way out to the web app", () => {
  it("explains what Chrome will ask for before the user clicks", async () => {
    activeJdState = {
      jd: null,
      failure: { kind: "permission", message: "Can't read this page." },
      loading: false,
    } as never;
    await renderApp();

    expect(container.textContent).toContain("Chrome only offers one option here");
    expect(container.textContent).toContain("chrome://extensions");
    expect(findButton(container, "Read this site")).toBeTruthy();
  });

  it("shows no permission explanation when the read failed for another reason", async () => {
    activeJdState = {
      jd: null,
      failure: { kind: "no-posting", message: "No posting found." },
      loading: false,
    } as never;
    await renderApp();

    expect(container.textContent).not.toContain("Chrome only offers one option here");
  });

  it("always offers a link to the web app", async () => {
    await renderApp();

    const link = findAnchor(container, "Open career-path ↗");
    expect(link.getAttribute("href")).toBe(`${API_BASE}/app`);
    expect(link.getAttribute("target")).toBe("_blank");
  });

  // Signed out, that page is Clerk-gated: the link would drop the user on a
  // sign-in screen they did not ask for. A dead end is worse than no link.
  it("offers the saved-resumes link only when signed in", async () => {
    await renderApp();
    expect(
      Array.from(container.querySelectorAll("a")).find(
        (a) => a.textContent?.trim() === "Your saved resumes ↗",
      ),
    ).toBeUndefined();

    clerkState = { signedIn: true, email: "ada@example.com" };
    await renderApp();
    expect(findAnchor(container, "Your saved resumes ↗")).toBeTruthy();
  });
});
```

Import `API_BASE` from `@/lib/config` at the top of the test file if it is not already imported. If `activeJdState`'s declared type does not permit a `failure` object, widen that type declaration rather than casting at every call site — and drop the `as never` above if the widened type accepts it.

- [ ] **Step 2: Run them and confirm they fail**

```bash
npm --prefix extension run test -- src/sidepanel/__tests__/App.test.tsx
```

Expected: FAIL — no explanation text, no "Open career-path ↗" link.

- [ ] **Step 3: Add the explanation**

Replace the existing permission button block in `App.tsx`:

```tsx
      {failure?.kind === "permission" && !hasBroadAccess && (
        <section className="card">
          {/* Two claims, deliberately kept apart. Chrome really does grant
              access to every site — saying otherwise would be false, and
              this product's whole pitch is not lying to people. What IS
              limited is what career-path does with the grant, and every
              sentence here is already promised on /privacy.

              Narrowing the request itself to the current origin is not
              available: it needs tab.url, which is gated behind the `tabs`
              permission this extension deliberately does not request. The
              code only reaches this branch because executeScript failed,
              which means activeTab is not in force for this tab either — so
              there is no path to the URL from here. */}
          <p className="muted tiny">
            Chrome only offers one option here — access to every site.
            career-path uses it to read the job posting on the tab you&rsquo;re
            looking at, and nothing else: it doesn&rsquo;t read other pages,
            and it doesn&rsquo;t collect your browsing history. You can take it
            back any time at chrome://extensions.
          </p>
          <button onClick={() => void grantAccess()} disabled={granting}>
            {granting ? "Waiting for Chrome…" : "Read this site"}
          </button>
        </section>
      )}
```

- [ ] **Step 4: Add the web-app link and gate the saved-resumes one**

Replace the existing single `outlink` anchor at the bottom of the render with:

```tsx
      {/* Plain anchors, not chrome.tabs.create: opening a tab this way needs
          no `tabs` permission. */}
      <a
        className="outlink"
        href={`${API_BASE}/app`}
        target="_blank"
        rel="noreferrer"
      >
        Open career-path ↗
      </a>
      {/* Signed out this page is Clerk-gated, so the link would strand the
          user on a sign-in screen they did not ask for. */}
      {signedIn && (
        <a
          className="outlink"
          href={`${API_BASE}/app/saved`}
          target="_blank"
          rel="noreferrer"
        >
          Your saved resumes ↗
        </a>
      )}
```

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
npm --prefix extension run test -- src/sidepanel/__tests__/App.test.tsx
```

- [ ] **Step 6: Full verification**

```bash
npx tsc --noEmit --project extension/tsconfig.json && npm --prefix extension run test && npm --prefix extension run lint && npm --prefix extension run build
```

- [ ] **Step 7: Commit**

```bash
git add extension/src/sidepanel/App.tsx extension/src/sidepanel/__tests__/App.test.tsx
git commit -m "feat(extension): explain the permission prompt and link out to the web app"
```

---

## Task 5: Beta codes in the panel

**Files:**
- Modify: `extension/src/lib/storage.ts`, `extension/src/lib/api.ts`, `extension/src/sidepanel/App.tsx`
- Create: `extension/src/sidepanel/BetaCodeBox.tsx`
- Test: `extension/src/lib/__tests__/api.test.ts`, `extension/src/sidepanel/__tests__/App.test.tsx`

**Interfaces:**
- Consumes: `fetchQuota` from `@/lib/quota` (Task 1); `refreshQuota` from `App` (Task 2).
- Produces: `getBetaCode`, `setBetaCode`, `clearBetaCode` from `@/lib/storage`; the `BetaCodeBox` component.

**Why:** the web app grants unlimited beta access on the `x-access-code` header (`src/lib/identity.ts`'s `hasBetaAccess`). The extension has never sent that header, so a beta tester is an ordinary 5-per-day caller in the panel, and the panel's storage is isolated from the web page's — a code entered on the site cannot be seen here. **The server needs no change**: `hasBetaAccess()` already reads this header on every route.

- [ ] **Step 1: Add the storage triplet**

In `extension/src/lib/storage.ts`, beside the other key constants:

```ts
const BETA_CODE_KEY = "cp_beta_code";
```

and beside the other accessors:

```ts
/**
 * The beta access code, sent as `x-access-code` on every request (see
 * lib/api.ts). Stored per-browser here because the panel cannot read the web
 * app's storage — a code entered on the website is invisible to the
 * extension, so the user has to enter it in both places.
 */
export async function getBetaCode(): Promise<string | null> {
  try {
    const got = await chrome.storage.local.get([BETA_CODE_KEY]);
    const raw = got[BETA_CODE_KEY];
    return typeof raw === "string" && raw ? raw : null;
  } catch {
    return null;
  }
}

export async function setBetaCode(code: string): Promise<void> {
  await chrome.storage.local.set({ [BETA_CODE_KEY]: code });
}

export async function clearBetaCode(): Promise<void> {
  await chrome.storage.local.remove([BETA_CODE_KEY]);
}
```

- [ ] **Step 2: Write the failing test for the header**

Add to `extension/src/lib/__tests__/api.test.ts`, following that file's existing `fetch` stubbing and `chrome.storage` faking:

```ts
it("sends the beta access code when one is stored", async () => {
  await setBetaCode("LETMEIN");
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  await apiGet("/api/quota");

  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect((init.headers as Record<string, string>)["x-access-code"]).toBe("LETMEIN");
});

it("sends no beta access header when none is stored", async () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  await apiGet("/api/quota");

  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect("x-access-code" in (init.headers as Record<string, string>)).toBe(false);
});
```

- [ ] **Step 3: Run them and confirm they fail**

```bash
npm --prefix extension run test -- src/lib/__tests__/api.test.ts
```

Expected: FAIL — the header is absent.

- [ ] **Step 4: Send the header**

In `extension/src/lib/api.ts`, add `getBetaCode` to the existing `./storage`-adjacent imports (create the import if the file does not already import from `./storage`):

```ts
import { getBetaCode } from "./storage";
```

In `send()`, directly after the existing `if (auth) headers.Authorization = ...` line:

```ts
  // Independent of identity: the server's hasBetaAccess() reads only this
  // header and does not change who the caller IS, just what they are allowed
  // to spend. A signed-in beta tester stays a signed-in caller.
  const betaCode = await getBetaCode();
  if (betaCode) headers["x-access-code"] = betaCode;
```

- [ ] **Step 5: Run them and confirm they pass**

```bash
npm --prefix extension run test -- src/lib/__tests__/api.test.ts
```

- [ ] **Step 6: Write the failing tests for the UI**

```ts
describe("App - beta code", () => {
  it("applies a valid code and shows the unlimited state", async () => {
    apiGetImpl = async () => ({ ok: true, data: { remaining: 3 } });
    await renderApp();

    await act(async () => {
      findButton(container, "Have a beta code?").click();
    });

    // From here the server accepts the code.
    apiGetImpl = async () => ({ ok: true, data: { remaining: null, unlimited: true } });
    const input = container.querySelector(
      'input[placeholder="Beta code"]',
    ) as HTMLInputElement;
    await act(async () => {
      input.value = "LETMEIN";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      findButton(container, "Apply").click();
    });
    await flush();

    expect(container.textContent).toContain("Beta · unlimited");
    expect(await getBetaCode()).toBe("LETMEIN");
  });

  // A rejected code must not stay in storage — every later request would
  // carry a header the server ignores, and the panel would look like it had
  // beta access it does not have.
  it("clears a code the server does not accept, and says so", async () => {
    apiGetImpl = async () => ({ ok: true, data: { remaining: 3 } });
    await renderApp();

    await act(async () => {
      findButton(container, "Have a beta code?").click();
    });
    const input = container.querySelector(
      'input[placeholder="Beta code"]',
    ) as HTMLInputElement;
    await act(async () => {
      input.value = "WRONG";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      findButton(container, "Apply").click();
    });
    await flush();

    expect(container.textContent).toContain("That code didn't work.");
    expect(await getBetaCode()).toBeNull();
    expect(container.textContent).not.toContain("Beta · unlimited");
  });
});
```

Add `getBetaCode` to the test file's `@/lib/storage` import.

- [ ] **Step 7: Run them and confirm they fail**

```bash
npm --prefix extension run test -- src/sidepanel/__tests__/App.test.tsx
```

Expected: FAIL — no "Have a beta code?" button.

- [ ] **Step 8: Write `BetaCodeBox.tsx`**

```tsx
import { useState } from "react";
import { fetchQuota } from "@/lib/quota";
import { clearBetaCode, setBetaCode } from "@/lib/storage";

/**
 * The panel's beta-code entry, mirroring the web app's header control.
 *
 * A code has to be entered here separately from the website: the extension's
 * chrome.storage.local is isolated from the page's storage, so there is no
 * way to read one the user already entered there.
 *
 * Validation has no dedicated endpoint and does not need one — applying the
 * code and re-reading GET /api/quota answers the question directly. If the
 * quota comes back unlimited the server accepted it; if it does not, the code
 * is wrong and is removed again immediately, because a rejected code left in
 * storage would ride along on every later request while buying nothing.
 */
export function BetaCodeBox({
  unlimited,
  onChanged,
}: {
  /** From App's quota state — whether a code is currently in force. */
  unlimited: boolean;
  /** Fired after storage changed, so App can re-read the allowance. */
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    const trimmed = code.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await setBetaCode(trimmed);
      // Deliberately a second read rather than reusing App's: this component
      // needs the answer to decide accept-or-reject before App is told
      // anything, and a rare user-initiated action is the wrong place to
      // trade clarity for one saved request.
      const quota = await fetchQuota();
      if (quota?.unlimited) {
        setOpen(false);
        setCode("");
        onChanged();
      } else {
        await clearBetaCode();
        setError("That code didn't work.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await clearBetaCode();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  if (unlimited) {
    return (
      <p className="muted tiny center">
        Beta · unlimited{" "}
        <button className="textbtn" onClick={() => void remove()} disabled={busy}>
          Remove
        </button>
      </p>
    );
  }

  if (!open) {
    return (
      <button className="textbtn" onClick={() => setOpen(true)}>
        Have a beta code?
      </button>
    );
  }

  return (
    <div>
      <input
        type="text"
        placeholder="Beta code"
        value={code}
        onChange={(e) => {
          setCode(e.target.value);
          setError(null);
        }}
      />
      <button onClick={() => void apply()} disabled={busy || code.trim().length === 0}>
        {busy ? "Checking…" : "Apply"}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 9: Wire it into `App.tsx`**

Import it:

```ts
import { BetaCodeBox } from "./BetaCodeBox";
```

Render it directly above the two `outlink` anchors added in Task 4:

```tsx
      <BetaCodeBox unlimited={displayUnlimited} onChanged={() => void refreshQuota()} />
```

- [ ] **Step 10: Run the tests and confirm they pass**

```bash
npm --prefix extension run test -- src/sidepanel/__tests__/App.test.tsx
```

- [ ] **Step 11: Full verification**

```bash
npx tsc --noEmit --project extension/tsconfig.json && npm --prefix extension run test && npm --prefix extension run lint && npm --prefix extension run build
```

- [ ] **Step 12: Commit**

```bash
git add extension/src/lib/storage.ts extension/src/lib/api.ts extension/src/sidepanel/BetaCodeBox.tsx extension/src/sidepanel/App.tsx extension/src/lib/__tests__/api.test.ts extension/src/sidepanel/__tests__/App.test.tsx
git commit -m "feat(extension): accept a beta access code in the panel"
```

---

## Live browser verification

Not a task — no subagent can do this, and nothing below is covered by any test in this repository.

1. Open the panel signed out on a fresh profile. The first line is the allowance (**"3 runs left"**), **not** "Not signed in".
2. Sign in. The sign-in tab closes by itself, and the panel already shows the email and **"5 runs left today"** without being reopened. (If the tab does not close, confirm the message reads "The panel is ready — you can close this tab" and that the panel did update anyway.)
3. Sign out with the box unchecked. The bar shows the signed-out allowance, **not** the account's leftover daily count.
4. On a site outside the five job boards, the explanation appears above **Read this site**, and Chrome's prompt still says "all websites" — as documented.
5. **Open career-path ↗** opens `/app`. Signed out, **Your saved resumes ↗** is absent; signed in, it is present.
6. Enter a valid beta code: the panel shows **Beta · unlimited** and a run no longer decrements. Enter an invalid one: it reports the failure and does not stick.

Still outstanding from earlier plans: PDF download, tab-switch persistence, `?utm_source=` cache hits, and the frozen baseline.

---

## Self-Review

**Spec coverage:** ① → Task 2 (with the data layer in Task 1). ② → Task 3. ③ → Task 4. ④ → Task 4. ⑤ → Task 5. The spec's "clear the quota before refetching" requirement → Task 2 Step 4's `refreshQuota`. The spec's "identity change triggers a refetch" rule → Task 2 (mount, sign-out), Task 3 (sign-in), Task 5 (beta code) — all three triggers have a home.

**Placeholder scan:** none. Every step carries the code it needs.

**Type consistency:** `QuotaInfo` is defined in Task 1 and consumed in Tasks 2 and 5 under the same name. `refreshQuota` is created in Task 2 and called in Tasks 3 and 5. `HAS_SIGNED_IN_KEY` is exported in Task 3 Step 1 and imported in Step 4 of the same task. `AccountBar`'s `unlimited` prop is added in Task 2 and supplied from `displayUnlimited`, defined in the same task. `fetchQuota` returns `QuotaInfo | null` everywhere it is used.

**Known cross-task ordering requirement:** Task 2 must land before Tasks 3 and 5 — both call `refreshQuota`, which Task 2 creates. Task 4 is independent and could run at any point.
