# Extension Sign-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user sign in from the side panel, raising their quota from 3 runs per 30 days to 5 per day, letting them save a tailored resume, and making their identity and allowance visible — plus the extension's first icon.

**Architecture:** A new `session.ts` owns the question "which token should this request carry, and what kind is it", with the Clerk source injected so the fork is testable before Clerk exists. `api.ts` consults it and branches on 401 by token kind. Sign-in happens in a standalone extension page driven by Clerk's **vanilla** `createClerkClient`, not the React components — that keeps `ClerkProvider` out of the panel's tree and Clerk's bundle off the panel's open path.

**Tech Stack:** TypeScript, React 19, Vite 7 + `@crxjs/vite-plugin`, Vitest 3 (jsdom), `@clerk/chrome-extension`, Chrome MV3, Next.js 15 (server, unchanged).

**Source spec:** `docs/superpowers/specs/2026-08-17-extension-sign-in-design.md`

## Global Constraints

- **Work in this worktree only:** `/Users/tianzhang/Projects/careerpath/.claude/worktrees/ext-access`, branch `feat/extension-page-access`. Do not `cd` to the main checkout. Never use bare `git stash` / `git stash pop`.
- **The server is not modified by this plan.** `resolveCaller` already prefers a Clerk user id over the device token and `@clerk/backend` already parses the Authorization header. If a task seems to need a server change, stop and report — it means an assumption is wrong.
- **A Clerk 401 must never mint a device token and must never retry.** Doing so silently downgrades a signed-in user to the 3-per-30-days tier while the panel still shows their email and daily allowance. This is the defect the whole design is shaped around.
- **Anonymous use keeps working exactly as today.** Sign-in is an upgrade, never a gate.
- **Use Clerk's vanilla client** (`createClerkClient` from `@clerk/chrome-extension/client`), not `<ClerkProvider>` / React hooks. The panel must not pay Clerk's bundle cost on open.
- **`allowedRedirectProtocols: ['chrome-extension:']`** is required in `clerk.load()` or the OAuth leg cannot return into the extension.
- **The Save control appears only when signed in** — never shown-and-failing.
- **Sign-out asks first**, with a checkbox checked by default reading *"Also remove my resume and saved results from this browser."*
- **Baseline to preserve:** root 84/84, extension 107/107, `npx tsc --noEmit --project extension/tsconfig.json`, both lints, both builds — all clean.
- **Where this plan hands you Clerk API code, verify it against the installed package before trusting it.** The `createClerkClient` / `clerk.load` / `clerk.session` surface below was taken from Clerk's own quickstart, but this plan's author could not execute it. Treat a mismatch as a finding to report, not as licence to improvise.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `extension/public/icons/icon-{16,32,48,128}.png` | The extension's icon at the four sizes Chrome asks for. |
| `extension/src/lib/session.ts` | Which token a request should carry and what kind it is. The one place that knows both identities exist. |
| `extension/src/lib/__tests__/session.test.ts` | Its tests. |
| `extension/src/lib/clerk.ts` | The Clerk client singleton and the small surface the rest of the extension uses. |
| `extension/src/signin/index.html` | The sign-in page's entry. |
| `extension/src/signin/main.ts` | Mounts Clerk's sign-in on that page. |
| `extension/src/sidepanel/AccountBar.tsx` | Signed-in header (email, remaining runs, sign out) and the signed-out Sign in control. |
| `extension/src/sidepanel/SignOutDialog.tsx` | The sign-out confirmation and its default-checked clear box. |

**Modified:**

| File | Change |
|---|---|
| `extension/manifest.config.ts` | Icons; `cookies` permission; Clerk Frontend API host; the sign-in page as a web-accessible entry. |
| `extension/src/__tests__/manifest.test.ts` | Assertions for each of the above. |
| `extension/src/lib/api.ts` | Consults `session.ts`; forks the 401 path on token kind. |
| `extension/src/lib/__tests__/api.test.ts` | The fork's tests. |
| `extension/src/lib/config.ts` | Clerk publishable key and Frontend API host per build mode. |
| `extension/src/sidepanel/App.tsx` | Renders `AccountBar`; opens the sign-in page; passes sign-in state down. |
| `extension/src/sidepanel/Results.tsx` | The Save control, signed-in only. |
| `extension/vite.config.ts` | The sign-in page as a second HTML entry. |
| `src/app/privacy/page.tsx` | Account, Clerk connection, sign-out clearing. |
| `CHANGELOG.md` | New dated section. |

---

## Task 1: The extension icon

**Why first:** it is the only task that touches nothing to do with auth, and it converts a visible gap (Chrome's default puzzle piece) into a finished detail without risk.

**Files:**
- Create: `extension/icons-src/careerpath_512.png`, `extension/icons-src/careerpath_32.png` (copied), `extension/public/icons/icon-{16,32,48,128}.png`
- Modify: `extension/manifest.config.ts`, `extension/src/__tests__/manifest.test.ts`

**Interfaces:** none — assets and manifest keys only.

- [ ] **Step 1: Copy the source artwork onto this branch**

The artwork currently lives in the *main checkout*, which is a different branch. Bring it into this worktree so it is committed with the change that uses it:

```bash
mkdir -p extension/icons-src
```

```bash
cp /Users/tianzhang/Projects/careerpath/extension/icons-src/careerpath_512.png /Users/tianzhang/Projects/careerpath/extension/icons-src/careerpath_32.png extension/icons-src/
```

- [ ] **Step 2: Look at the artwork before resizing it**

```bash
sips -g pixelWidth -g pixelHeight extension/icons-src/careerpath_512.png extension/icons-src/careerpath_32.png
```

Then open `extension/icons-src/careerpath_512.png` and look at it. You are deciding one thing: **how much empty margin surrounds the artwork.** A toolbar icon is 16 logical pixels; margin baked into the image makes the drawing smaller still. If the artwork occupies materially less than the full canvas, crop the margin before resizing, using `sips -c <h> <w>` on a copy. If it already fills the canvas, do not crop.

Record what you saw and what you decided in your report. Do not skip this by assuming — the plan's author only ever saw a rendered preview, not the file.

- [ ] **Step 3: Generate the four sizes**

```bash
mkdir -p extension/public/icons
```

```bash
sips -z 128 128 extension/icons-src/careerpath_512.png --out extension/public/icons/icon-128.png
```

```bash
sips -z 48 48 extension/icons-src/careerpath_512.png --out extension/public/icons/icon-48.png
```

```bash
cp extension/icons-src/careerpath_32.png extension/public/icons/icon-32.png
```

```bash
sips -z 16 16 extension/icons-src/careerpath_32.png --out extension/public/icons/icon-16.png
```

Note which source each size comes from: **16 is derived from the 32, not the 512.** Downscaling detailed artwork straight to 16px turns fine strokes into a grey smear; a source already drawn small survives the step. 32 is used as-authored rather than resampled.

- [ ] **Step 4: Write the failing manifest assertions**

Add to `extension/src/__tests__/manifest.test.ts`:

```ts
  // Without these Chrome shows the default puzzle piece — which is what it
  // showed for the extension's entire life before this.
  it("declares icons at every size Chrome asks for", () => {
    expect(manifest.icons).toEqual({
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png",
    });
  });

  it("gives the toolbar button an icon", () => {
    expect(manifest.action?.default_icon).toEqual({
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
    });
  });
```

- [ ] **Step 5: Run them to verify they fail**

```bash
npm --prefix extension run test -- manifest
```

Expected: FAIL — `manifest.icons` is `undefined` and `action.default_icon` is `undefined`.

- [ ] **Step 6: Declare them in the manifest**

In `extension/manifest.config.ts`, add a top-level `icons` key and extend `action`:

```ts
  icons: {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png",
  },
  action: {
    default_title: "Tailor my resume",
    default_icon: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
    },
  },
```

Paths are relative to the built extension root. Files in `extension/public/` are copied there verbatim by Vite, so `public/icons/icon-16.png` becomes `icons/icon-16.png`.

- [ ] **Step 7: Run the tests, then verify the files actually ship**

```bash
npm --prefix extension run test -- manifest
```

```bash
npm --prefix extension run build
```

```bash
ls -la extension/dist/icons/
```

Expected: four PNGs present in `dist/icons/`. A manifest that names an icon file the build does not emit produces a broken-image toolbar button, and no test can see that — this `ls` is the check.

- [ ] **Step 8: Commit**

```bash
git add extension/icons-src extension/public/icons extension/manifest.config.ts extension/src/__tests__/manifest.test.ts
git commit -m "feat(extension): give the extension its icon"
```

---

## Task 2: Token selection and the 401 fork

**Why before any Clerk code:** this is the change that can silently downgrade a signed-in user, and it is testable *without* Clerk being installed. Building and proving it first means the Clerk work later has a correct foundation to plug into rather than a moving one.

**Files:**
- Create: `extension/src/lib/session.ts`, `extension/src/lib/__tests__/session.test.ts`
- Modify: `extension/src/lib/api.ts`, `extension/src/lib/__tests__/api.test.ts`

**Interfaces:**
- Consumes: `ensureToken(force?: boolean): Promise<string | null>` from `@/lib/token` (existing, unchanged).
- Produces:
  ```ts
  export type AuthToken =
    | { kind: "clerk"; token: string }
    | { kind: "device"; token: string };
  export type ClerkTokenSource = () => Promise<string | null>;
  export function setClerkTokenSource(source: ClerkTokenSource): void;
  export function currentAuthToken(): Promise<AuthToken | null>;
  ```
  and from `api.ts`, `ApiErrorKind` gains the member `"session_expired"`.

- [ ] **Step 1: Write the failing session tests**

Create `extension/src/lib/__tests__/session.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { currentAuthToken, setClerkTokenSource } from "@/lib/session";

vi.mock("@/lib/token", () => ({
  ensureToken: vi.fn(async () => "device-token"),
}));

describe("currentAuthToken", () => {
  beforeEach(() => {
    setClerkTokenSource(async () => null);
  });

  it("uses the device token when there is no Clerk session", async () => {
    expect(await currentAuthToken()).toEqual({
      kind: "device",
      token: "device-token",
    });
  });

  // Signed in, the Clerk token WINS. Sending the device token instead would
  // land the request in the 3-per-30-days bucket while the panel shows a
  // signed-in user their daily allowance.
  it("prefers the Clerk token when there is a session", async () => {
    setClerkTokenSource(async () => "clerk-token");
    expect(await currentAuthToken()).toEqual({
      kind: "clerk",
      token: "clerk-token",
    });
  });

  // A Clerk source that throws must not take the request down with it, but it
  // must also not silently pretend the user is signed out and spend their
  // device trial. Falling back to the device token is the lesser evil only
  // because the 401 fork downstream still tells a signed-in user the truth.
  it("falls back to the device token when the Clerk source throws", async () => {
    setClerkTokenSource(async () => {
      throw new Error("clerk unavailable");
    });
    expect(await currentAuthToken()).toEqual({
      kind: "device",
      token: "device-token",
    });
  });

  it("returns null when neither identity is available", async () => {
    const { ensureToken } = await import("@/lib/token");
    vi.mocked(ensureToken).mockResolvedValueOnce(null);
    expect(await currentAuthToken()).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm --prefix extension run test -- session
```

Expected: FAIL — `Failed to resolve import "@/lib/session"`.

- [ ] **Step 3: Implement `session.ts`**

Create `extension/src/lib/session.ts`:

```ts
import { ensureToken } from "./token";

/**
 * Which identity a request travels under.
 *
 * The extension has two, and they behave differently on failure — which is
 * the whole reason this type exists rather than a bare string. A device token
 * is ours: it expires, we mint another, the user never knows. A Clerk token
 * is the user's session: when it goes, nothing can be minted in its place and
 * the user has to be told.
 */
export type AuthToken =
  | { kind: "clerk"; token: string }
  | { kind: "device"; token: string };

/** Returns the current Clerk session token, or null when signed out. */
export type ClerkTokenSource = () => Promise<string | null>;

/**
 * Injected rather than imported so this module — and the 401 fork that
 * depends on it — is testable without Clerk, and so the panel does not pull
 * Clerk's bundle in just by importing the API client. `lib/clerk.ts` installs
 * the real source; until it does, every caller is a device caller.
 */
let clerkTokenSource: ClerkTokenSource = async () => null;

export function setClerkTokenSource(source: ClerkTokenSource): void {
  clerkTokenSource = source;
}

export async function currentAuthToken(): Promise<AuthToken | null> {
  let clerk: string | null = null;
  try {
    clerk = await clerkTokenSource();
  } catch {
    // Clerk unreachable. Fall through to the device identity rather than
    // failing the request outright — the 401 fork downstream is what keeps a
    // signed-in user from being silently downgraded without being told.
    clerk = null;
  }
  if (clerk) return { kind: "clerk", token: clerk };

  const device = await ensureToken();
  return device ? { kind: "device", token: device } : null;
}
```

- [ ] **Step 4: Run the session tests**

```bash
npm --prefix extension run test -- session
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing api tests for the fork**

Add to `extension/src/lib/__tests__/api.test.ts`, matching that file's existing fetch-mock and token-mock patterns:

Two cases, and they are the point of this task:

1. **A device-token 401 still refreshes once and retries.** Stub `currentAuthToken` to a `{ kind: "device" }` token, have `fetch` return 401 then 200, and assert the request was retried and `ensureToken` was called with `true`.
2. **A Clerk 401 does not refresh and does not retry.** Stub `currentAuthToken` to a `{ kind: "clerk" }` token, have `fetch` return 401, and assert: `fetch` was called exactly **once**, `ensureToken(true)` was **never** called, and the result is `{ ok: false, kind: "session_expired" }`.

Case 2 is the regression guard for the silent downgrade. Write it so it fails if the fork is removed — with the fork gone, `fetch` runs twice and the kind is `"auth"`.

- [ ] **Step 6: Run them to verify they fail**

```bash
npm --prefix extension run test -- api
```

Expected: FAIL — `currentAuthToken` is not used by `api.ts` yet and `"session_expired"` is not a valid `ApiErrorKind`. Record the actual output.

- [ ] **Step 7: Fork the 401 path in `api.ts`**

Add `"session_expired"` to the `ApiErrorKind` union:

```ts
export type ApiErrorKind =
  | "quota"
  | "auth"
  | "session_expired"
  | "rate_limit"
  | "server"
  | "network";
```

Replace the import of `ensureToken` with both it and the session module:

```ts
import { ensureToken } from "./token";
import { currentAuthToken } from "./session";
```

Then rewrite `send`'s token attachment and 401 handling. The existing docstring above `send` describes only the device case and is now wrong — replace it too:

```ts
/**
 * One request, carrying whichever identity currently applies.
 *
 * The 401 handling FORKS on that identity, and the fork is load-bearing:
 *
 * - A device token is ours. Expiry is routine — mint another and retry ONCE.
 *   Never loop: a server that rejects a freshly minted token is broken, and
 *   retrying would hammer it.
 * - A Clerk token is the user's SESSION. There is nothing to mint. Refreshing
 *   here would fetch a device token, the retry would SUCCEED, and the user
 *   would silently continue as a signed-out device on 3 runs per 30 days
 *   while the panel still showed their email and their daily allowance. The
 *   quota on screen would be a lie and nothing would look broken. So: no
 *   refresh, no retry, and a distinct error kind the panel turns into
 *   "your session expired".
 */
async function send<T>(
  path: string,
  init: RequestInit,
  allowRefresh = true,
): Promise<ApiResult<T>> {
  const auth = await currentAuthToken();
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (auth) headers.Authorization = `Bearer ${auth.token}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    return { ok: false, kind: "network", message: "Couldn't reach career-path." };
  }

  if (res.status === 401 && auth?.kind === "clerk") {
    return {
      ok: false,
      kind: "session_expired",
      message: "Your session expired. Sign in again to continue.",
    };
  }

  if (res.status === 401 && allowRefresh) {
    const refreshed = await ensureToken(true);
    if (refreshed) return send<T>(path, init, false);
  }

  if (!res.ok) return toFailure<T>(res);

  try {
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, kind: "server", message: GENERIC_ERROR };
  }
}
```

The Clerk check comes **before** the refresh branch deliberately. Ordering it after would let `allowRefresh` decide first and reintroduce the downgrade.

- [ ] **Step 8: Run the full extension suite, type-check, lint and build**

```bash
npx tsc --noEmit --project extension/tsconfig.json && npm --prefix extension run test && npm --prefix extension run lint && npm --prefix extension run build
```

Expected: clean throughout. Report the test total.

- [ ] **Step 9: Commit**

```bash
git add extension/src/lib/session.ts extension/src/lib/__tests__/session.test.ts extension/src/lib/api.ts extension/src/lib/__tests__/api.test.ts
git commit -m "feat(extension): pick the request identity and fork 401 on its kind"
```

---

## Task 3: Clerk dependency, configuration, and manifest

**Why separate from the sign-in page:** these are the changes with consequences beyond this repository — the install prompt widens and the published extension's host permissions are frozen at submission. A reviewer should be able to gate them on their own.

**Files:**
- Modify: `extension/package.json`, `extension/src/lib/config.ts`, `extension/manifest.config.ts`, `extension/src/__tests__/manifest.test.ts`

**Interfaces:**
- Produces: from `config.ts`, `CLERK_PUBLISHABLE_KEY: string` and `CLERK_FRONTEND_API: string`, both resolved per build mode exactly as `API_BASE` already is.

- [ ] **Step 1: Install the package**

```bash
npm --prefix extension install @clerk/chrome-extension
```

Confirm it landed in `dependencies` (it ships in the extension):

```bash
grep -n "clerk" extension/package.json
```

- [ ] **Step 2: Add the Clerk values to `config.ts`**

`extension/src/lib/config.ts` already resolves `API_BASE` from `import.meta.env.MODE`. Add alongside it:

```ts
/**
 * Clerk's publishable key is public by design — it identifies the instance to
 * Clerk's frontend API and grants nothing on its own. It is compiled in, like
 * API_BASE, because an extension has no server-side config to read.
 */
export const CLERK_PUBLISHABLE_KEY: string =
  import.meta.env.MODE === "production"
    ? "REPLACE_WITH_PRODUCTION_PUBLISHABLE_KEY"
    : "REPLACE_WITH_DEVELOPMENT_PUBLISHABLE_KEY";

/**
 * Clerk's Frontend API host, which MUST also appear in host_permissions or
 * the extension cannot reach Clerk at all. Development and production are
 * different domains, which is why this branches — and why the production
 * value has to be right BEFORE the first Web Store submission: adding a host
 * permission afterwards disables the extension for every existing user until
 * they re-approve it.
 */
export const CLERK_FRONTEND_API: string =
  import.meta.env.MODE === "production"
    ? "https://clerk.career-allpath.com"
    : "https://REPLACE_WITH_DEV_SLUG.clerk.accounts.dev";
```

**The three `REPLACE_WITH_` values are the human's to supply** — they come from the Clerk dashboard and this plan's author does not have them. Stop at this step, report the exact three values you need, and continue once they are provided. Do **not** invent placeholder keys and carry on: a build that compiles against a fake key fails at runtime in a way no test here can see.

- [ ] **Step 3: Write the failing manifest assertions**

Add to `extension/src/__tests__/manifest.test.ts`:

```ts
  // Clerk's SDK reads cookies on its own frontend API domain.
  it("requests the cookies permission Clerk needs", () => {
    expect(manifest.permissions).toContain("cookies");
  });

  // Without this the extension cannot reach Clerk at all and sign-in does not
  // exist. It widens the install prompt, which the page-access design worked
  // to keep narrow — an accepted, deliberate cost.
  it("requests the Clerk frontend API host", () => {
    expect(
      manifest.host_permissions?.some((h) => h.includes("clerk")),
    ).toBe(true);
  });
```

- [ ] **Step 4: Run them to verify they fail**

```bash
npm --prefix extension run test -- manifest
```

Expected: FAIL on both.

- [ ] **Step 5: Add the permission and host to the manifest**

In `extension/manifest.config.ts`, add `"cookies"` to `permissions`, and add the Clerk host to `API_HOSTS`:

```ts
  `${CLERK_FRONTEND_API}/*`,
```

`manifest.config.ts` runs in Node at build time, so it cannot import from `src/lib/config.ts`'s `import.meta.env`. Read the same value from `process.env.MODE`/the Vite mode available to it, or declare the two Clerk hosts literally with a comment tying them to `config.ts`. Whichever you choose, **the two files must not be able to drift** — if you declare them literally, add a test asserting the manifest host matches `CLERK_FRONTEND_API`'s origin for the current mode. This repository has been bitten three times by a value that was load-bearing across two files with nothing pinning them together.

- [ ] **Step 6: Run the tests, type-check, lint and build**

```bash
npm --prefix extension run test && npx tsc --noEmit --project extension/tsconfig.json && npm --prefix extension run lint && npm --prefix extension run build
```

- [ ] **Step 7: Confirm the emitted manifest carries both**

```bash
node -e "const m=require('./extension/dist/manifest.json');console.log(JSON.stringify({permissions:m.permissions,host_permissions:m.host_permissions},null,1))"
```

Expected: `cookies` present, and a Clerk host present. The emitted file is what Chrome reads; asserting only on the source config would not prove it survived the build.

- [ ] **Step 8: Commit**

```bash
git add extension/package.json extension/package-lock.json extension/src/lib/config.ts extension/manifest.config.ts extension/src/__tests__/manifest.test.ts
git commit -m "feat(extension): Clerk dependency, config and manifest permissions"
```

---

## Task 4: The sign-in page

**Files:**
- Create: `extension/src/signin/index.html`, `extension/src/signin/main.ts`, `extension/src/lib/clerk.ts`
- Modify: `extension/vite.config.ts`, `extension/manifest.config.ts`

**Interfaces:**
- Consumes: `CLERK_PUBLISHABLE_KEY` from `@/lib/config`; `setClerkTokenSource` from `@/lib/session`.
- Produces, from `extension/src/lib/clerk.ts`:
  ```ts
  export function getClerk(): Promise<Clerk>;           // loaded singleton
  export function installClerkTokenSource(): void;       // wires session.ts
  export async function currentUserEmail(): Promise<string | null>;
  export async function isSignedIn(): Promise<boolean>;
  export async function signOut(): Promise<void>;
  export function signInPageUrl(): string;               // chrome.runtime.getURL
  ```

- [ ] **Step 1: Write `lib/clerk.ts`**

The verified Clerk vanilla surface is:

```ts
import { createClerkClient } from "@clerk/chrome-extension/client";

const clerk = createClerkClient({ publishableKey });
await clerk.load({
  afterSignOutUrl: <url>,
  signInForceRedirectUrl: <url>,
  signUpForceRedirectUrl: <url>,
  allowedRedirectProtocols: ["chrome-extension:"],
});
```

with `clerk.session`, `clerk.user`, `clerk.openSignIn({})`, and `clerk.signOut({ redirectUrl })` available afterwards.

Build `lib/clerk.ts` on exactly that: a module-level memoized `load()` promise so concurrent callers share one client, and the six functions in the Interfaces block above. `installClerkTokenSource()` calls `setClerkTokenSource(() => clerk.session?.getToken() ?? null)` — that call is the join between this task and Task 2.

**`allowedRedirectProtocols: ["chrome-extension:"]` is not optional.** Without it the OAuth leg cannot redirect back into the extension and Google sign-in fails at the last step.

**Verify each of those members exists on the installed package before relying on it.** Read `extension/node_modules/@clerk/chrome-extension/dist/` or the package's types. If `getToken` is not on `clerk.session`, or `load` takes different options, report the real shape rather than working around it — the plan's author took this from Clerk's quickstart and could not execute it.

- [ ] **Step 2: Write the sign-in page**

`extension/src/signin/index.html` is a minimal page with a container element and a script tag pointing at `main.ts`. `main.ts` awaits `getClerk()`, then calls `clerk.openSignIn({})` mounted into that container. Both email code and Google come from the Clerk dashboard's enabled strategies — there is no per-method code here.

Style it to match `extension/src/styles.css`'s tokens so it does not look like a different product. It is a full page, not a 400px panel, so it has room.

- [ ] **Step 3: Add the page as a second Vite entry**

`extension/vite.config.ts` currently builds the panel via the manifest. Add `src/signin/index.html` as an additional rollup input so it is emitted. CRXJS picks up manifest-referenced HTML automatically; a page reached only via `chrome.runtime.getURL` is not manifest-referenced, so it needs either an explicit input or a `web_accessible_resources` entry in the manifest. Prefer the explicit input plus, if the built page needs to be openable from the panel, a `web_accessible_resources` entry scoped to the extension's own origin.

- [ ] **Step 4: Verify the page builds and loads**

```bash
npm --prefix extension run build:dev
```

```bash
ls extension/dist | grep -i signin
```

Then load `extension/dist` unpacked in Chrome, open the extension's page directly at `chrome-extension://<id>/src/signin/index.html` (adjust to the emitted path), and confirm **Clerk's sign-in renders**. This is the first point at which anything Clerk-related can be seen working, and every later task assumes it does. If it does not render, stop and report with the page's console output — do not proceed to Task 5.

- [ ] **Step 5: Commit**

```bash
git add extension/src/signin extension/src/lib/clerk.ts extension/vite.config.ts extension/manifest.config.ts
git commit -m "feat(extension): a sign-in page driven by Clerk's vanilla client"
```

---

## Task 5: The panel's account bar

**Files:**
- Create: `extension/src/sidepanel/AccountBar.tsx`, `extension/src/sidepanel/SignOutDialog.tsx`
- Modify: `extension/src/sidepanel/App.tsx`, `extension/src/styles.css`

**Interfaces:**
- Consumes: `isSignedIn`, `currentUserEmail`, `signOut`, `signInPageUrl`, `installClerkTokenSource` from `@/lib/clerk`; `clearResume` from `@/lib/storage`; `clearCachedRuns` from `@/lib/cache`.
- Produces: `AccountBar` and `SignOutDialog` components; `App.tsx` calls `installClerkTokenSource()` once on mount.

- [ ] **Step 1: `AccountBar`**

Two states, rendered at the top of the panel above the resume card:

- **Signed out:** a single **Sign in** control opening `signInPageUrl()` in a new tab, with a one-line reason beside it — signing in raises the allowance from 3 runs per 30 days to 5 per day.
- **Signed in:** the account email, the remaining daily runs from the run state's `remaining`, and a **Sign out** control.

The remaining count is already threaded through `RunState.remaining`; do not fetch it separately.

- [ ] **Step 2: `SignOutDialog`**

A confirmation with a checkbox, **checked by default**, reading exactly:

```
Also remove my resume and saved results from this browser.
```

On confirm: call `signOut()`; if the box is checked, also `clearResume()` and `clearCachedRuns()`, and reset the panel's displayed state so nothing from the previous session remains on screen.

The default is checked because only the user knows whether this is a shared machine, and the safe option should be the one that happens if they do not read carefully.

- [ ] **Step 3: The exhausted-trial prompt**

When a signed-out caller's quota is exhausted, the panel today says nothing useful. Change that path to offer sign-in — this is the single place the feature most needs to appear, because it is where a signed-out user is stuck.

- [ ] **Step 4: Handle `session_expired`**

`api.ts` now returns `kind: "session_expired"`. The panel must render that distinctly from a generic auth error and offer the sign-in page — a user whose session lapsed mid-run should be told, not silently downgraded. This is the visible half of Task 2's fork.

- [ ] **Step 5: Verify**

```bash
npx tsc --noEmit --project extension/tsconfig.json && npm --prefix extension run test && npm --prefix extension run lint && npm --prefix extension run build
```

`AccountBar` and `SignOutDialog` are React components in a package whose only React tests drive `App`. State plainly in your report which of this task's behaviour is covered by a test and which is not — do not present a green build as coverage.

- [ ] **Step 6: Commit**

```bash
git add extension/src/sidepanel/AccountBar.tsx extension/src/sidepanel/SignOutDialog.tsx extension/src/sidepanel/App.tsx extension/src/styles.css
git commit -m "feat(extension): account bar, sign-out confirmation, session-expired handling"
```

---

## Task 6: Saving from the panel

**Files:**
- Modify: `extension/src/sidepanel/Results.tsx`, `extension/src/sidepanel/App.tsx`

**Interfaces:**
- Consumes: `apiPost` from `@/lib/api`; the signed-in flag from Task 5.
- Produces: nothing new exported.

- [ ] **Step 1: Add the control**

Beside **Download PDF**, a **Save** control that `POST`s to `/api/saved` with the company, role title, tailored resume and JD summary the route expects. Read `src/app/api/saved/route.ts`'s POST body handling and match it exactly rather than guessing the field names.

It renders **only when signed in**. Signed out it is absent — not present-and-failing.

- [ ] **Step 2: States**

Idle, saving, saved. A save that fails shows why and stays retryable. A `session_expired` result here routes to the same handling Task 5 added.

- [ ] **Step 3: Verify and commit**

```bash
npx tsc --noEmit --project extension/tsconfig.json && npm --prefix extension run test && npm --prefix extension run lint && npm --prefix extension run build
```

```bash
git add extension/src/sidepanel/Results.tsx extension/src/sidepanel/App.tsx
git commit -m "feat(extension): save a tailored resume from the panel"
```

---

## Task 7: Privacy and changelog

**Files:**
- Modify: `src/app/privacy/page.tsx`, `CHANGELOG.md`

- [ ] **Step 1: Update `/privacy`**

Three additions, each describing something this branch actually does:

- Signing in creates an account; Clerk handles it, and **the extension now talks to Clerk directly** — the page names Clerk as a third party but does not say the extension contacts it.
- A signed-in user's usage is counted against their account rather than a device id. The page already describes the device-id case; the account case belongs beside it.
- Signing out can remove the resume and cached results from the browser.

Update the "Last updated" date.

- [ ] **Step 2: Changelog**

A new dated section above the most recent one, with a `---` rule above the section it displaces. Cover: sign-in and what it unlocks; the install-prompt widening and why it was accepted; the 401 fork stated as a user-visible guarantee (an expired session tells you, rather than quietly spending your device trial); the icon. Under Known limits: browsing saved resumes in the panel is still a link out; Sync Host does not work for side panels so signing in on the website does not carry over; and the production Clerk host must be settled before the first Web Store submission because adding a host permission afterwards disables the extension for existing users.

- [ ] **Step 3: Verify and commit**

```bash
npm run lint && npm run build
```

```bash
git add src/app/privacy/page.tsx CHANGELOG.md
git commit -m "docs: privacy and changelog for extension sign-in"
```

---

## Live browser verification

Not a task — no subagent can do this.

Prerequisites that are **not** code: `chrome-extension://<the pinned CRX ID>` added to the Clerk instance's allowed origins, and the three `REPLACE_WITH_` values from Task 3 supplied.

1. The toolbar shows the career-path icon, not the puzzle piece.
2. Signed out, the panel offers Sign in; the sign-in page opens and completes **by email code**.
3. Sign out, then sign in again **with Google** — the OAuth leg returns into the extension.
4. Signed in, the header shows the email and the daily allowance, and a run decrements from 5 rather than the device trial.
5. **Save** appears, and a saved resume shows up at `/app/saved` in the web app.
6. Sign out with the box checked: the resume and cached results are gone. Sign out with it unchecked: they remain.
7. Signed out, exhaust the trial: the panel offers sign-in rather than a dead end.

Also still outstanding from earlier plans on this branch: PDF download, tab-switch persistence, `?utm_source=` cache hits, "Read this site" on a non-listed site, and the frozen baseline.

---

## Self-Review

**Spec coverage:** §2 → Task 4. §3 → Task 2 (fork) + Task 4 (real source) + Task 5 (visible half). §4 → Task 3. §5 → Task 5. §6 → Task 6. §7 → Task 5 Step 2. §8 → Task 1. §9 → Task 7. §10 → recorded in Live browser verification's prerequisites, since it is not a repository change. §11 → nothing implements the out-of-scope items. §12.1–12.10 → 12.4 and 12.5 are covered by tests in Task 2; the rest are in Live browser verification.

**Placeholder scan:** Tasks 1, 2 and 3 carry literal code. Tasks 4, 5 and 6 specify contracts, exact copy and exact verification, but describe rather than transcribe the Clerk-facing and component code — deliberately, and flagged in the Global Constraints. The plan's author verified Clerk's vanilla surface from its quickstart but could not execute it, and transcribing an unverified API into a plan as if it were literal would be worse than saying so. Task 3 Step 2's three `REPLACE_WITH_` values are an explicit stop-and-ask, not a placeholder to fill in silently.

**Type consistency:** `AuthToken`, `ClerkTokenSource`, `setClerkTokenSource`, `currentAuthToken` are defined in Task 2 and consumed in Tasks 2 and 4. `"session_expired"` is added to `ApiErrorKind` in Task 2 and handled in Tasks 5 and 6. `CLERK_PUBLISHABLE_KEY` / `CLERK_FRONTEND_API` are defined in Task 3 and consumed in Tasks 3 and 4. `getClerk` / `installClerkTokenSource` / `currentUserEmail` / `isSignedIn` / `signOut` / `signInPageUrl` are defined in Task 4 and consumed in Task 5.

**Ordering:** Task 2 must precede Task 4 (the source it installs). Task 3 must precede Task 4 (the dependency and key). Tasks 5 and 6 depend on Task 4. Task 1 and Task 7 are independent of the rest.
