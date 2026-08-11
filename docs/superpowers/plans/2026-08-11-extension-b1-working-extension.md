# Chrome Extension B1 — Working Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A loadable Chrome MV3 side-panel extension that reads the job posting from the page the user is on, tailors their locally-stored resume against it through the existing career-path API, and renders the result in two stages.

**Architecture:** `extension/` is a self-contained Vite + CRXJS package inside the existing Next.js repo, sharing only type declarations from `shared/contract.ts`. A background service worker owns side-panel opening and device-token lifecycle. A content script extracts JD text from the live DOM. The side panel is a small React app that holds the resume in `chrome.storage.local` and talks to the API through one fetch wrapper that attaches the bearer token and retries once on `401`.

**Tech Stack:** Vite 8 + `@crxjs/vite-plugin` (MV3), React 19, TypeScript strict, Vitest + jsdom, `@mozilla/readability`.

**Source spec:** `docs/superpowers/specs/2026-08-10-chrome-extension-v1-design.md` (§3 product surface, §4 architecture, §5 JD extraction)

**Depends on:** the merged server foundation (`docs/superpowers/plans/2026-08-10-extension-server-foundation.md`). Every endpoint and header this plan uses already exists and is tested.

## Global Constraints

- **The extension is a strictly thin client.** It reads the DOM, manages the local resume, and renders. No prompts, no model choices, no normalizers — those stay server-side so they ship without store review.
- **The base resume lives in `chrome.storage.local` and is never uploaded for storage.** It goes into a request body during parse/analyze/tailor and is not retained server-side. The `/privacy` page already commits to this in writing.
- **Extract text, never screenshots and never the DOM tree.**
- **`host_permissions` in v1 lists only the API origins.** Page access comes from `activeTab` plus the五-site list added in B2. Do not request `<all_urls>`.
- **Quality gate:** extracted JD text under **300 characters** counts as a failed extraction.
- **One `runId` per generate action, sent to BOTH `/api/analyze` and `/api/tailor`.** This is what makes a run cost one unit instead of two. A `runId` wired to only one call looks correct in isolation and silently double-charges.
- **A `401` means refresh the device token and retry the request exactly once.** Never loop.
- `shared/contract.ts` is imported with `import type` only. It must stay runtime-free.
- Every task ends with `npm --prefix extension run lint` and `npm --prefix extension run test` green.
- The repo root's `npm test`, `npm run build`, and `npm run lint` must stay green — this plan must not disturb the Next.js app.

## API contract this plan consumes (all shipped and tested)

| Endpoint | Request | Success response |
| --- | --- | --- |
| `POST /api/device-token` | — | `{ token }`, or `503 { error }` when unconfigured |
| `POST /api/parse-resume` | multipart `file` (PDF/DOCX ≤5MB) **or** `text` | `{ resume }` |
| `POST /api/parse-jd` | `{ text }` | `{ jd }` |
| `POST /api/analyze` | `{ structuredResume, structuredJD, extraInfo, quality, runId }` | `{ analysis, remaining }` |
| `POST /api/tailor` | same plus `analysis` | `{ tailored, remaining }` |
| `GET /api/quota` | — | `{ remaining, used, limit }` or `{ remaining: null, unlimited: true }` |

Error statuses that matter: `401` invalid/expired bearer token · `402` quota exhausted · `429` rate limited (carries `Retry-After`, exposed via CORS) · `502` LLM failure · `503` store or device-token unavailable.

---

### Task 1: Extension scaffold with a stable extension ID

Nothing exists yet. This task produces a `.crx`-shaped build that Chrome can load, with an ID that does not change between reloads — because the API's CORS allowlist is keyed on that ID, and an ID that drifts turns into a baffling "CORS broke overnight".

**Files:**
- Create: `extension/package.json`
- Create: `extension/vite.config.ts`
- Create: `extension/tsconfig.json`
- Create: `extension/manifest.config.ts`
- Create: `extension/eslint.config.mjs`
- Create: `extension/src/sidepanel/index.html`
- Create: `extension/src/sidepanel/main.tsx`
- Create: `extension/src/sidepanel/App.tsx`
- Create: `extension/src/styles.css`
- Modify: `.gitignore`
- Modify: `package.json` (root — add `test:extension` and `test:all`)

**Interfaces:**
- Consumes: nothing.
- Produces: a build at `extension/dist/` loadable via chrome://extensions → Load unpacked. `npm --prefix extension run build` / `dev` / `test` / `lint` all work. Later tasks add files under `extension/src/`.

- [ ] **Step 1: Create the extension package**

Create `extension/package.json`:

```json
{
  "name": "career-path-extension",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src"
  },
  "dependencies": {
    "@mozilla/readability": "^0.6.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@crxjs/vite-plugin": "^2.2.0",
    "@eslint/js": "^9.0.0",
    "@types/chrome": "^0.0.300",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "eslint": "^9.0.0",
    "jsdom": "^26.0.0",
    "typescript": "^5",
    "typescript-eslint": "^8.0.0",
    "vite": "^7.0.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Install**

```bash
npm --prefix extension install
```

The version ranges above are current-as-of-authoring, not verified against the
registry. If any of them fails to resolve, run `npm view <pkg> versions --json`,
take the highest stable release compatible with its neighbours, and **record
every version you actually installed in your report** — a later reviewer needs
to know what the tree really is.

Two constraints on that latitude:
- `@crxjs/vite-plugin` must be a **2.x** line. Do not fall back to 1.x; its
  MV3 support differs materially.
- `vite`, `@vitejs/plugin-react`, and `@crxjs/vite-plugin` must agree. CRXJS 2.x
  supports Vite 3 through 8, so if the plugin trio conflicts, pin Vite down
  rather than forcing the others up.

- [ ] **Step 3: Declare the manifest**

Create `extension/manifest.config.ts`. `key` is what pins the extension ID; the matching private key is generated in Step 7 and never committed.

```ts
import { defineManifest } from "@crxjs/vite-plugin";

// API origins the panel and worker fetch. Listing them as host_permissions
// lets extension pages make these requests directly; the server's CORS
// allowlist is the second layer, not the only one.
const API_HOSTS = [
  "http://localhost:3000/*",
  "https://careerpath-hazel.vercel.app/*",
];

export default defineManifest({
  manifest_version: 3,
  name: "career-path — tailor your resume",
  version: "0.1.0",
  description:
    "Tailor your resume to the job posting you're looking at — honestly, without inventing experience.",
  minimum_chrome_version: "114",
  permissions: ["storage", "sidePanel", "activeTab", "scripting"],
  host_permissions: API_HOSTS,
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  side_panel: {
    default_path: "src/sidepanel/index.html",
  },
  action: {
    default_title: "Tailor my resume",
  },
});
```

`src/background/index.ts` does not exist until Task 2. Create a placeholder now so the build resolves:

```bash
mkdir -p extension/src/background
printf 'export {};\n' > extension/src/background/index.ts
```

- [ ] **Step 4: Configure Vite**

Create `extension/vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import { fileURLToPath } from "node:url";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("../shared", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
```

- [ ] **Step 5: Configure TypeScript**

Create `extension/tsconfig.json`. This is deliberately separate from the root config — the root one excludes `extension` precisely so Chrome types never leak into the Next.js build.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "types": ["chrome", "vitest/globals"],
    "paths": {
      "@/*": ["./src/*"],
      "@shared/*": ["../shared/*"]
    }
  },
  "include": ["src", "vite.config.ts", "manifest.config.ts", "../shared"]
}
```

- [ ] **Step 5b: Give the extension its own ESLint config**

Without this, `eslint src` walks up and picks the repo root's Next.js flat
config, which is wrong for a Chrome extension. Create
`extension/eslint.config.mjs`:

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { chrome: "readonly", console: "readonly", fetch: "readonly" },
    },
  },
];
```

- [ ] **Step 6: Create a minimal side panel**

Create `extension/src/sidepanel/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>career-path</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

Create `extension/src/styles.css`:

```css
:root {
  --bg: #ffffff;
  --fg: #0e1220;
  --muted: #64748b;
  --line: #e2e8f0;
  --accent: #4f46e5;
  --ok: #16a34a;
  --warn: #ca8a04;
  --miss: #dc2626;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-size: 13px;
  line-height: 1.5;
}

button {
  font: inherit;
  cursor: pointer;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: #fff;
  padding: 6px 10px;
}

button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  width: 100%;
  padding: 10px;
  font-weight: 600;
}

button.primary:disabled { opacity: 0.55; cursor: default; }
```

Create `extension/src/sidepanel/App.tsx`:

```tsx
export default function App() {
  return (
    <main style={{ padding: 12 }}>
      <h1 style={{ fontSize: 15, margin: "0 0 8px" }}>career-path</h1>
      <p style={{ color: "var(--muted)", margin: 0 }}>Side panel is alive.</p>
    </main>
  );
}
```

Create `extension/src/sidepanel/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "../styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 7: Pin the extension ID**

Generate a keypair. The private key stays out of git; only the public key goes in the manifest, and a public key is safe to commit.

```bash
openssl genrsa 2048 2>/dev/null | openssl pkcs8 -topk8 -nocrypt -out extension/key.pem
openssl rsa -in extension/key.pem -pubout -outform DER 2>/dev/null | openssl base64 -A
```

Copy the base64 output and add it to `extension/manifest.config.ts` as a `key` field, immediately after `description`:

```ts
  // Pins the extension ID across reloads. The server's CORS allowlist keys on
  // that ID, so an ID that drifts looks like CORS spontaneously breaking.
  // Public key only — extension/key.pem is gitignored.
  key: "PASTE_THE_BASE64_HERE",
```

- [ ] **Step 8: Ignore build output and the private key**

Add to `.gitignore` (repo root), after the existing `# git worktrees + agent scratch state` block:

```
# chrome extension
/extension/node_modules/
/extension/dist/
/extension/key.pem
```

- [ ] **Step 9: Add root-level test scripts**

In the root `package.json`, add to `"scripts"`:

```json
    "test:extension": "npm --prefix extension run test",
    "test:all": "npm test && npm run test:extension"
```

The root `test` script stays as it is, so nothing about the Next.js workflow changes.

- [ ] **Step 10: Build**

```bash
npm --prefix extension run build
```
Expected: `extension/dist/` is created, containing `manifest.json` and a
service-worker loader. List the directory and record what it actually emitted —
Task 6 needs the emitted content-script filename.

- [ ] **Step 11: Compute the extension ID and configure CORS**

Chrome derives the extension ID from the public key deterministically: SHA-256
of the DER public key, first 16 bytes, hex-encoded, then each hex digit mapped
`0-9a-f` → `a-p`. Compute it rather than reading it off a screen — same answer,
and it does not need a browser:

```bash
openssl rsa -in extension/key.pem -pubout -outform DER 2>/dev/null \
  | openssl dgst -sha256 -binary \
  | head -c 16 \
  | xxd -p \
  | tr '0-9a-f' 'a-p'
```

Expected: a 32-character string of letters a-p.

Append it to the repo-root `.env.local` (the file is gitignored and already
holds the other keys — append, do not overwrite):

```bash
printf '\n# Chrome extension ID (CORS allowlist)\nALLOWED_EXTENSION_IDS=%s\n' "<the computed id>" >> .env.local
```

Then confirm it landed:

```bash
grep -o '^[A-Z_]*=' .env.local | tr -d '='
```
Expected: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`,
`OPENROUTER_API_KEY`, `DEVICE_TOKEN_SECRET`, `ALLOWED_EXTENSION_IDS`.

**Loading it in Chrome is a human step, not yours.** `chrome://extensions` is a
privileged page you cannot drive. Do not claim you loaded it. Instead, end your
report with the exact instructions and the computed ID so the controller can
hand them over:

> Open `chrome://extensions`, enable Developer mode, click **Load unpacked**,
> select `<abs path>/extension/dist`. The ID on the card should read
> `<computed id>`. Click the toolbar icon — the panel should say
> "Side panel is alive."

If the ID Chrome shows ever differs from the computed one, the `key` field is
wrong — that is the single thing to check first, because every CORS failure
downstream traces back to it.

- [ ] **Step 12: Verify the repo root is undisturbed**

```bash
npm test && npm run lint && npm run build
```
Expected: all green, exactly as before this task.

- [ ] **Step 13: Commit**

```bash
npm --prefix extension run lint
git add extension .gitignore package.json
git commit -m "feat(extension): MV3 scaffold with a pinned extension ID"
```

---

### Task 2: Background worker — side panel and device token lifecycle

The worker does two jobs: open the panel when the icon is clicked, and keep a valid device token in storage so the panel never has to think about minting one.

**Files:**
- Create: `extension/src/lib/config.ts`
- Create: `extension/src/lib/storage.ts`
- Create: `extension/src/lib/__tests__/storage.test.ts`
- Create: `extension/src/lib/token.ts`
- Create: `extension/src/lib/__tests__/token.test.ts`
- Modify: `extension/src/background/index.ts`

**Interfaces:**
- Consumes: Task 1's scaffold.
- Produces:
  - `API_BASE: string` from `extension/src/lib/config.ts`
  - `getResume(): Promise<StoredResume | null>`, `setResume(r: StoredResume): Promise<void>`, `clearResume(): Promise<void>`
  - `interface StoredResume { resume: ParsedResume; parsedAt: string; name: string }`
  - `getToken(): Promise<string | null>`, `setToken(token: string): Promise<void>`, `clearToken(): Promise<void>`
  - `ensureToken(force?: boolean): Promise<string | null>` — returns a usable token, minting one if absent or if `force` is true. `null` when the server cannot issue one.
  Tasks 3-6 consume all of these.

- [ ] **Step 1: Write the failing tests**

Create `extension/src/lib/__tests__/storage.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getResume, setResume, clearResume, getToken, setToken, clearToken } from "@/lib/storage";
import type { ParsedResume } from "@shared/contract";

const EMPTY: ParsedResume = {
  contact: { name: "Ada Lovelace", email: "", phone: "", location: "", links: [] },
  summary: "",
  experience: [],
  projects: [],
  skills: [],
  education: [],
};

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

describe("extension storage", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", fakeChromeStorage());
  });

  it("returns null when no resume is stored", async () => {
    expect(await getResume()).toBeNull();
  });

  it("round-trips a stored resume", async () => {
    await setResume({ resume: EMPTY, parsedAt: "2026-08-11T00:00:00.000Z", name: "Ada Lovelace" });
    const got = await getResume();
    expect(got?.name).toBe("Ada Lovelace");
    expect(got?.resume.contact.name).toBe("Ada Lovelace");
  });

  it("clears a stored resume", async () => {
    await setResume({ resume: EMPTY, parsedAt: "x", name: "Ada" });
    await clearResume();
    expect(await getResume()).toBeNull();
  });

  it("round-trips and clears the device token", async () => {
    expect(await getToken()).toBeNull();
    await setToken("tok-123");
    expect(await getToken()).toBe("tok-123");
    await clearToken();
    expect(await getToken()).toBeNull();
  });

  it("survives corrupt stored JSON rather than throwing", async () => {
    await chrome.storage.local.set({ cp_resume: "not json" });
    expect(await getResume()).toBeNull();
  });
});
```

Create `extension/src/lib/__tests__/token.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ensureToken } from "@/lib/token";
import { getToken, setToken } from "@/lib/storage";

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
        set: vi.fn(async (items: Record<string, unknown>) => Object.assign(data, items)),
        remove: vi.fn(async (keys: string[]) => keys.forEach((k) => delete data[k])),
      },
    },
  };
}

describe("ensureToken", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", fakeChromeStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("mints a token when none is stored", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ token: "fresh" }), { status: 200 })),
    );
    expect(await ensureToken()).toBe("fresh");
    expect(await getToken()).toBe("fresh");
  });

  it("reuses a stored token without calling the network", async () => {
    await setToken("cached");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await ensureToken()).toBe("cached");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-mints when forced, even with a token stored", async () => {
    await setToken("stale");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ token: "renewed" }), { status: 200 })),
    );
    expect(await ensureToken(true)).toBe("renewed");
    expect(await getToken()).toBe("renewed");
  });

  it("returns null and stores nothing when the server cannot issue one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 503 })),
    );
    expect(await ensureToken()).toBeNull();
    expect(await getToken()).toBeNull();
  });

  it("returns null when the network throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await ensureToken()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix extension run test`
Expected: FAIL — cannot resolve `@/lib/storage` and `@/lib/token`.

- [ ] **Step 3: Implement config**

Create `extension/src/lib/config.ts`:

```ts
/**
 * The API origin. Vite inlines this at build time, so a dev build points at
 * localhost and a production build at the deployed app. Both origins are in
 * the manifest's host_permissions.
 */
export const API_BASE: string =
  import.meta.env.MODE === "production"
    ? "https://careerpath-hazel.vercel.app"
    : "http://localhost:3000";
```

- [ ] **Step 4: Implement storage**

Create `extension/src/lib/storage.ts`:

```ts
import type { ParsedResume } from "@shared/contract";

/**
 * Everything the extension keeps lives here, in chrome.storage.local — on the
 * user's device, never uploaded for storage. The /privacy page commits to
 * this in writing; do not add a sync-storage or server-side mirror.
 */

const RESUME_KEY = "cp_resume";
const TOKEN_KEY = "cp_device_token";

export interface StoredResume {
  resume: ParsedResume;
  /** ISO 8601, shown in the panel's "My resume" block. */
  parsedAt: string;
  /** Display name pulled off the parsed contact block, for the same block. */
  name: string;
}

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const got = await chrome.storage.local.get([key]);
    const raw = got[key];
    if (typeof raw !== "string") return null;
    return JSON.parse(raw) as T;
  } catch {
    // Corrupt or unreadable — treat as absent rather than breaking the panel.
    return null;
  }
}

export async function getResume(): Promise<StoredResume | null> {
  return readJson<StoredResume>(RESUME_KEY);
}

export async function setResume(value: StoredResume): Promise<void> {
  await chrome.storage.local.set({ [RESUME_KEY]: JSON.stringify(value) });
}

export async function clearResume(): Promise<void> {
  await chrome.storage.local.remove([RESUME_KEY]);
}

export async function getToken(): Promise<string | null> {
  try {
    const got = await chrome.storage.local.get([TOKEN_KEY]);
    const raw = got[TOKEN_KEY];
    return typeof raw === "string" && raw ? raw : null;
  } catch {
    return null;
  }
}

export async function setToken(token: string): Promise<void> {
  await chrome.storage.local.set({ [TOKEN_KEY]: token });
}

export async function clearToken(): Promise<void> {
  await chrome.storage.local.remove([TOKEN_KEY]);
}
```

- [ ] **Step 5: Implement the token lifecycle**

Create `extension/src/lib/token.ts`:

```ts
import { API_BASE } from "./config";
import { getToken, setToken } from "./storage";

/**
 * Device tokens are server-signed and last 24h. We do not decode or check the
 * expiry here: the API answers a stale token with 401, and the API client
 * turns that into exactly one forced refresh. One source of truth for
 * validity — the server — beats two that can disagree.
 */
export async function ensureToken(force = false): Promise<string | null> {
  if (!force) {
    const existing = await getToken();
    if (existing) return existing;
  }

  try {
    const res = await fetch(`${API_BASE}/api/device-token`, { method: "POST" });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: unknown };
    if (typeof body.token !== "string" || !body.token) return null;
    await setToken(body.token);
    return body.token;
  } catch {
    // Offline or blocked. The panel degrades to an anonymous caller.
    return null;
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm --prefix extension run test`
Expected: PASS — 10 tests.

- [ ] **Step 7: Wire the background worker**

Replace `extension/src/background/index.ts`:

```ts
import { ensureToken } from "@/lib/token";

/**
 * Opens the side panel when the toolbar icon is clicked, and keeps a device
 * token warm so the panel never blocks on minting one.
 */

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn("sidePanel.setPanelBehavior failed", err));

// Mint on install and refresh on every browser start. The token lasts 24h, so
// a startup refresh covers any session shorter than a day; the API client's
// 401 retry covers the rest.
chrome.runtime.onInstalled.addListener(() => {
  void ensureToken();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureToken(true);
});
```

- [ ] **Step 8: Verify in Chrome**

```bash
npm --prefix extension run build
```

Reload the extension at `chrome://extensions`. Click **service worker** to open its console.

Expected: no errors. With the Next.js dev server running (`npm run dev` at the repo root) and `DEVICE_TOKEN_SECRET` set in `.env.local`, remove the extension and re-add it to fire `onInstalled`, then run in the service worker console:

```js
chrome.storage.local.get(["cp_device_token"]).then(console.log)
```
Expected: an object containing a JWT string.

If `DEVICE_TOKEN_SECRET` is unset the endpoint returns 503 and the value is absent — that is correct behavior, not a bug. Record which case you observed.

- [ ] **Step 9: Commit**

```bash
npm --prefix extension run lint
git add extension
git commit -m "feat(extension): storage, device-token lifecycle, background worker"
```

---

### Task 3: API client with 401 refresh-and-retry

One place that knows how to talk to the API: attach the bearer token, retry once on `401`, and turn everything else into a typed result the panel can render without knowing about HTTP.

**Files:**
- Create: `extension/src/lib/api.ts`
- Create: `extension/src/lib/__tests__/api.test.ts`

**Interfaces:**
- Consumes: `API_BASE` (Task 2), `ensureToken` (Task 2).
- Produces:
  - `type ApiResult<T> = { ok: true; data: T } | { ok: false; kind: ApiErrorKind; message: string; retryAfter?: number }`
  - `type ApiErrorKind = "quota" | "auth" | "rate_limit" | "server" | "network"`
  - `apiPost<T>(path: string, body: unknown): Promise<ApiResult<T>>`
  - `apiPostForm<T>(path: string, form: FormData): Promise<ApiResult<T>>`
  Tasks 5 and 6 consume these. There is deliberately **no** `apiGet` — nothing
  in B1 issues one (the panel reads `remaining` off the run responses), and an
  exported function with no caller is dead code. B2 adds it when it wires
  `GET /api/quota`.

- [ ] **Step 1: Write the failing test**

Create `extension/src/lib/__tests__/api.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { apiPost } from "@/lib/api";
import { setToken, getToken } from "@/lib/storage";

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
        set: vi.fn(async (items: Record<string, unknown>) => Object.assign(data, items)),
        remove: vi.fn(async (keys: string[]) => keys.forEach((k) => delete data[k])),
      },
    },
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe("apiPost", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", fakeChromeStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns the parsed body on success", async () => {
    await setToken("t1");
    vi.stubGlobal("fetch", vi.fn(async () => json({ jd: { company: "Acme" } })));
    const res = await apiPost<{ jd: { company: string } }>("/api/parse-jd", { text: "x" });
    expect(res).toEqual({ ok: true, data: { jd: { company: "Acme" } } });
  });

  it("sends the stored token as a bearer header", async () => {
    await setToken("t1");
    const fetchMock = vi.fn(async () => json({}));
    vi.stubGlobal("fetch", fetchMock);
    await apiPost("/api/parse-jd", { text: "x" });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t1");
  });

  it("refreshes once on 401 and retries with the new token", async () => {
    await setToken("stale");
    const fetchMock = vi
      .fn()
      // first attempt with the stale token
      .mockResolvedValueOnce(json({ error: "expired" }, 401))
      // the mint call
      .mockResolvedValueOnce(json({ token: "renewed" }))
      // the retry
      .mockResolvedValueOnce(json({ jd: { company: "Acme" } }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiPost<{ jd: { company: string } }>("/api/parse-jd", { text: "x" });
    expect(res.ok).toBe(true);
    expect(await getToken()).toBe("renewed");
    const retryInit = fetchMock.mock.calls[2][1] as RequestInit;
    expect((retryInit.headers as Record<string, string>).Authorization).toBe("Bearer renewed");
  });

  it("does not loop when the retry also 401s", async () => {
    await setToken("stale");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ error: "expired" }, 401))
      .mockResolvedValueOnce(json({ token: "renewed" }))
      .mockResolvedValueOnce(json({ error: "still bad" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiPost("/api/parse-jd", { text: "x" });
    expect(res).toMatchObject({ ok: false, kind: "auth" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("classifies 402 as a quota error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "out of runs" }, 402)));
    const res = await apiPost("/api/tailor", {});
    expect(res).toMatchObject({ ok: false, kind: "quota", message: "out of runs" });
  });

  it("classifies 429 and surfaces Retry-After", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "slow down" }, 429, { "Retry-After": "60" })),
    );
    const res = await apiPost("/api/tailor", {});
    expect(res).toMatchObject({ ok: false, kind: "rate_limit", retryAfter: 60 });
  });

  it("classifies 502 as a server error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "llm down" }, 502)));
    const res = await apiPost("/api/analyze", {});
    expect(res).toMatchObject({ ok: false, kind: "server" });
  });

  it("classifies a thrown fetch as a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const res = await apiPost("/api/analyze", {});
    expect(res).toMatchObject({ ok: false, kind: "network" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix extension run test`
Expected: FAIL — cannot resolve `@/lib/api`.

- [ ] **Step 3: Implement the client**

Create `extension/src/lib/api.ts`:

```ts
import { API_BASE } from "./config";
import { ensureToken } from "./token";

export type ApiErrorKind = "quota" | "auth" | "rate_limit" | "server" | "network";

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: ApiErrorKind; message: string; retryAfter?: number };

const GENERIC_ERROR = "Something went wrong. Please try again.";

async function readMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" && body.error ? body.error : GENERIC_ERROR;
  } catch {
    return GENERIC_ERROR;
  }
}

function classify(status: number): ApiErrorKind {
  if (status === 401) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return "rate_limit";
  return "server";
}

async function toFailure<T>(res: Response): Promise<ApiResult<T>> {
  const kind = classify(res.status);
  const message = await readMessage(res);
  if (kind === "rate_limit") {
    const raw = Number(res.headers.get("Retry-After"));
    return {
      ok: false,
      kind,
      message,
      ...(Number.isFinite(raw) && raw > 0 ? { retryAfter: raw } : {}),
    };
  }
  return { ok: false, kind, message };
}

/**
 * One request, with the bearer token attached. A 401 means the device token
 * expired: mint a fresh one and retry ONCE. Never loop — a server that keeps
 * rejecting a freshly minted token is broken, and retrying would hammer it.
 */
async function send<T>(
  path: string,
  init: RequestInit,
  allowRefresh = true,
): Promise<ApiResult<T>> {
  const token = await ensureToken();
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    return { ok: false, kind: "network", message: "Couldn't reach career-path." };
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

export function apiPost<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  return send<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Multipart — do NOT set Content-Type; the browser adds the boundary. */
export function apiPostForm<T>(path: string, form: FormData): Promise<ApiResult<T>> {
  return send<T>(path, { method: "POST", body: form });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix extension run test`
Expected: PASS — 18 tests total across the three files.

- [ ] **Step 5: Commit**

```bash
npm --prefix extension run lint
git add extension
git commit -m "feat(extension): API client with single 401 refresh-and-retry"
```

---

### Task 4: Generic JD extraction from the live page

The whole reason for an extension: read the posting out of the DOM the user is already looking at, in their already-authenticated browser. B2 adds purpose-written extractors for the five big job sites; this task ships the fallback that works everywhere.

**Files:**
- Create: `extension/src/content/extract.ts`
- Create: `extension/src/content/__tests__/extract.test.ts`
- Create: `extension/src/content/index.ts`
- Considered and deliberately unchanged: `extension/manifest.config.ts` (see Step 5)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface ExtractedJD { text: string; title: string; company: string; url: string }`
  - `type ExtractResult = { ok: true; jd: ExtractedJD } | { ok: false; reason: string }`
  - `extractFromDocument(doc: Document, url: string): ExtractResult` — pure, testable against a jsdom document.
  - `MIN_JD_CHARS = 300`
  - A content script answering `{ type: "CP_EXTRACT_JD" }` messages with `ExtractResult`.
  Task 6 consumes the message contract.

- [ ] **Step 1: Write the failing test**

Create `extension/src/content/__tests__/extract.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { extractFromDocument, MIN_JD_CHARS } from "@/content/extract";

function docFrom(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

const LONG_JD = `
  We are looking for a Senior Backend Engineer to join our platform team.
  You will design and operate distributed services that process millions of
  events per day, mentor other engineers, and own systems end to end.
  Requirements: 5+ years of backend experience, strong Go or Rust, deep
  knowledge of PostgreSQL, and experience running services in production.
  Nice to have: Kubernetes, Terraform, and an interest in developer tooling.
  We offer competitive compensation, equity, and a remote-first culture.
`.repeat(2);

describe("extractFromDocument", () => {
  it("pulls the main article text out of a normal posting", () => {
    const doc = docFrom(`
      <html><head><title>Senior Backend Engineer at Acme</title></head>
      <body>
        <nav>Home Jobs About</nav>
        <article><h1>Senior Backend Engineer</h1><p>${LONG_JD}</p></article>
        <footer>© Acme</footer>
      </body></html>
    `);
    const r = extractFromDocument(doc, "https://acme.com/jobs/1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.jd.text).toContain("Senior Backend Engineer");
    expect(r.jd.text.length).toBeGreaterThanOrEqual(MIN_JD_CHARS);
    expect(r.jd.url).toBe("https://acme.com/jobs/1");
  });

  it("prefers a JobPosting JSON-LD block when present", () => {
    const doc = docFrom(`
      <html><head>
        <script type="application/ld+json">
          {"@type":"JobPosting","title":"Staff Data Engineer",
           "hiringOrganization":{"name":"Globex"},
           "description":"${LONG_JD.replace(/\s+/g, " ").trim()}"}
        </script>
      </head><body><p>irrelevant page chrome</p></body></html>
    `);
    const r = extractFromDocument(doc, "https://globex.com/careers/9");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.jd.title).toBe("Staff Data Engineer");
    expect(r.jd.company).toBe("Globex");
  });

  it("strips HTML tags out of a JSON-LD description", () => {
    const doc = docFrom(`
      <html><head>
        <script type="application/ld+json">
          {"@type":"JobPosting","title":"X","description":"<p>${LONG_JD.replace(/\s+/g, " ").trim()}</p>"}
        </script>
      </head><body></body></html>
    `);
    const r = extractFromDocument(doc, "https://x.com/j/1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.jd.text).not.toContain("<p>");
  });

  it("fails when the page has almost no text", () => {
    const doc = docFrom(`<html><body><p>Loading…</p></body></html>`);
    const r = extractFromDocument(doc, "https://x.com/j/1");
    expect(r).toEqual({ ok: false, reason: "too-short" });
  });

  it("fails when the extracted text is just under the gate", () => {
    const doc = docFrom(`<html><body><article><p>${"a".repeat(MIN_JD_CHARS - 1)}</p></article></body></html>`);
    expect(extractFromDocument(doc, "https://x.com/j/1").ok).toBe(false);
  });

  it("ignores a malformed JSON-LD block and falls back to the article", () => {
    const doc = docFrom(`
      <html><head><script type="application/ld+json">{ not json </script></head>
      <body><article><p>${LONG_JD}</p></article></body></html>
    `);
    expect(extractFromDocument(doc, "https://x.com/j/1").ok).toBe(true);
  });

  it("finds JobPosting inside an @graph array", () => {
    const doc = docFrom(`
      <html><head>
        <script type="application/ld+json">
          {"@graph":[{"@type":"WebSite"},{"@type":"JobPosting","title":"Graph Role",
           "description":"${LONG_JD.replace(/\s+/g, " ").trim()}"}]}
        </script>
      </head><body></body></html>
    `);
    const r = extractFromDocument(doc, "https://x.com/j/1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.jd.title).toBe("Graph Role");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix extension run test`
Expected: FAIL — cannot resolve `@/content/extract`.

- [ ] **Step 3: Implement extraction**

Create `extension/src/content/extract.ts`:

```ts
import { Readability } from "@mozilla/readability";

/**
 * Generic JD extraction. Two strategies, in order of trustworthiness:
 *
 *   1. schema.org JobPosting in JSON-LD — structured, authoritative, present
 *      on most career sites.
 *   2. Readability over the live DOM — good at finding the article body and
 *      dropping nav and footers.
 *
 * This runs in the user's own already-authenticated browser against rendered
 * HTML, which is why it reaches postings the server-side fetcher cannot.
 *
 * B2 adds purpose-written extractors for LinkedIn, Greenhouse, Lever, Ashby
 * and Workday, which take precedence over both of these.
 */

export const MIN_JD_CHARS = 300;

export interface ExtractedJD {
  text: string;
  title: string;
  company: string;
  url: string;
}

export type ExtractResult =
  | { ok: true; jd: ExtractedJD }
  | { ok: false; reason: string };

function clean(text: string): string {
  return text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** JSON-LD descriptions are frequently HTML. Render to text without eval. */
function stripHtml(doc: Document, html: string): string {
  const el = doc.createElement("div");
  el.innerHTML = html;
  return el.textContent ?? "";
}

interface JobPostingLd {
  title?: unknown;
  description?: unknown;
  hiringOrganization?: { name?: unknown } | unknown;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function findJobPosting(node: unknown): JobPostingLd | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;
  if (obj["@type"] === "JobPosting") return obj as JobPostingLd;
  if ("@graph" in obj) return findJobPosting(obj["@graph"]);
  return null;
}

function fromJsonLd(doc: Document): ExtractedJD | null {
  const blocks = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const block of Array.from(blocks)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.textContent ?? "");
    } catch {
      continue; // one malformed block must not sink the page
    }
    const posting = findJobPosting(parsed);
    if (!posting) continue;

    const description = asString(posting.description);
    if (!description) continue;

    const org = posting.hiringOrganization as { name?: unknown } | undefined;
    return {
      text: clean(stripHtml(doc, description)),
      title: asString(posting.title),
      company: asString(org?.name),
      url: "",
    };
  }
  return null;
}

function fromReadability(doc: Document): ExtractedJD | null {
  try {
    // Readability mutates the document it is given; clone so the live page
    // the user is reading is never altered.
    const article = new Readability(doc.cloneNode(true) as Document).parse();
    if (!article?.textContent) return null;
    return {
      text: clean(article.textContent),
      title: clean(article.title ?? ""),
      company: clean(article.siteName ?? ""),
      url: "",
    };
  } catch {
    return null;
  }
}

export function extractFromDocument(doc: Document, url: string): ExtractResult {
  const candidate = fromJsonLd(doc) ?? fromReadability(doc);
  if (!candidate || candidate.text.length < MIN_JD_CHARS) {
    return { ok: false, reason: "too-short" };
  }
  return { ok: true, jd: { ...candidate, url } };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix extension run test`
Expected: PASS — 25 tests total.

- [ ] **Step 5: Add the content script**

Create `extension/src/content/index.ts`:

```ts
import { extractFromDocument, type ExtractResult } from "./extract";

/**
 * Injected on demand by the side panel via chrome.scripting, so it only ever
 * runs on a tab the user explicitly asked us to read. It answers one message
 * and holds no state.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "CP_EXTRACT_JD") return;
  // Responding synchronously, so do NOT return true — that would tell Chrome
  // to hold the message channel open for an async reply that never comes.
  const result: ExtractResult = extractFromDocument(document, location.href);
  sendResponse(result);
});
```

**Do NOT add a `content_scripts` block to the manifest.** The obvious move here
is `content_scripts: [{ matches: ["<all_urls>"], ... }]`, and it is the wrong
one: even though that is a different grant from `<all_urls>` *host
permissions*, it still shows the user "Read and change all your data on all
websites" at install — the exact review friction the spec set out to avoid.

Instead the script is injected on demand, per tab, via `activeTab` +
`chrome.scripting.executeScript`. The user clicking the extension icon *is*
the gesture that grants access to that one tab. Task 6's side panel does the
injecting; this task only creates the script and leaves the manifest alone.

So `extension/manifest.config.ts` is unchanged by this task — the "Modify"
entry in the Files list above is there to tell you the file was considered and
deliberately left alone.

- [ ] **Step 6: Confirm the manifest has no content_scripts block**

Run: `grep -n "content_scripts" extension/manifest.config.ts`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
npm --prefix extension run build
npm --prefix extension run lint
git add extension
git commit -m "feat(extension): generic JD extraction with JSON-LD and Readability"
```

---

### Task 5: The run orchestrator

The two-stage flow, as a plain async function with no React in it. Keeping it separate is what makes the charge-once rule testable without a DOM.

**Files:**
- Create: `extension/src/lib/run.ts`
- Create: `extension/src/lib/__tests__/run.test.ts`

**Interfaces:**
- Consumes: `apiPost` and `ApiResult` (Task 3), `ExtractedJD` (Task 4).
- Produces:
  - `type RunPhase = "idle" | "reading" | "comparing" | "writing" | "done" | "error"`
  - `interface RunState { phase: RunPhase; analysis: GapAnalysis | null; tailored: TailorResult | null; remaining: number | null; error: { kind: ApiErrorKind; message: string } | null }`
  - `runTailor(jd: ExtractedJD, resume: ParsedResume, onUpdate: (patch: Partial<RunState>) => void): Promise<void>`
  Task 6 consumes both the state shape and the function.

- [ ] **Step 1: Write the failing test**

Create `extension/src/lib/__tests__/run.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runTailor, type RunState } from "@/lib/run";
import type { ParsedResume } from "@shared/contract";
import type { ExtractedJD } from "@/content/extract";

const RESUME: ParsedResume = {
  contact: { name: "Ada", email: "", phone: "", location: "", links: [] },
  summary: "",
  experience: [],
  projects: [],
  skills: [],
  education: [],
};

const JD: ExtractedJD = {
  text: "a".repeat(400),
  title: "Senior Backend Engineer",
  company: "Acme",
  url: "https://acme.com/jobs/1",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function collect() {
  const patches: Partial<RunState>[] = [];
  return { patches, onUpdate: (p: Partial<RunState>) => patches.push(p) };
}

function fakeChromeStorage() {
  const data: Record<string, unknown> = { cp_device_token: "tok" };
  return {
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => {
          const out: Record<string, unknown> = {};
          for (const k of keys) if (k in data) out[k] = data[k];
          return out;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => Object.assign(data, items)),
        remove: vi.fn(async (keys: string[]) => keys.forEach((k) => delete data[k])),
      },
    },
  };
}

describe("runTailor", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", fakeChromeStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the SAME runId to analyze and tailor", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/parse-jd")) return json({ jd: { company: "Acme" } });
      if (String(url).endsWith("/api/analyze")) return json({ analysis: { overall_match_score: 70 }, remaining: 4 });
      return json({ tailored: { projected_match_score: 85 }, remaining: 4 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    const bodies = fetchMock.mock.calls
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)))
      .filter((b) => "runId" in b);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].runId).toBe(bodies[1].runId);
    expect(bodies[0].runId).toBeTruthy();
  });

  it("mints a new runId on a second run", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (body.runId) seen.push(body.runId);
        if (String(url).endsWith("/api/parse-jd")) return json({ jd: {} });
        if (String(url).endsWith("/api/analyze")) return json({ analysis: {}, remaining: 3 });
        return json({ tailored: {}, remaining: 3 });
      }),
    );
    await runTailor(JD, RESUME, () => {});
    await runTailor(JD, RESUME, () => {});
    expect(new Set(seen).size).toBe(2);
  });

  it("reports analysis before the tailored result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/api/parse-jd")) return json({ jd: {} });
        if (String(url).endsWith("/api/analyze")) return json({ analysis: { overall_match_score: 61 }, remaining: 2 });
        return json({ tailored: { projected_match_score: 80 }, remaining: 2 });
      }),
    );
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);

    const analysisAt = patches.findIndex((p) => p.analysis);
    const tailoredAt = patches.findIndex((p) => p.tailored);
    expect(analysisAt).toBeGreaterThanOrEqual(0);
    expect(tailoredAt).toBeGreaterThan(analysisAt);
    expect(patches.at(-1)?.phase).toBe("done");
  });

  it("surfaces a quota error and stops", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/api/parse-jd")) return json({ jd: {} });
        return json({ error: "You've used all your free runs." }, 402);
      }),
    );
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);
    expect(patches.at(-1)?.phase).toBe("error");
    expect(patches.at(-1)?.error?.kind).toBe("quota");
  });

  it("stops at a parse-jd failure without calling analyze", async () => {
    const fetchMock = vi.fn(async () => json({ error: "bad jd" }, 422));
    vi.stubGlobal("fetch", fetchMock);
    const { patches, onUpdate } = collect();
    await runTailor(JD, RESUME, onUpdate);
    expect(patches.at(-1)?.phase).toBe("error");
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/api/analyze"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix extension run test`
Expected: FAIL — cannot resolve `@/lib/run`.

- [ ] **Step 3: Implement the orchestrator**

Create `extension/src/lib/run.ts`:

```ts
import type { GapAnalysis, ParsedJD, ParsedResume, TailorResult } from "@shared/contract";
import type { ExtractedJD } from "@/content/extract";
import { apiPost, type ApiErrorKind } from "./api";

export type RunPhase = "idle" | "reading" | "comparing" | "writing" | "done" | "error";

export interface RunState {
  phase: RunPhase;
  analysis: GapAnalysis | null;
  tailored: TailorResult | null;
  remaining: number | null;
  error: { kind: ApiErrorKind; message: string } | null;
}

export const INITIAL_RUN_STATE: RunState = {
  phase: "idle",
  analysis: null,
  tailored: null,
  remaining: null,
  error: null,
};

/** Collision-resistant enough for a per-run key, and defined everywhere. */
function newRunId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * One generate action.
 *
 * The single most important line here is that `runId` is minted ONCE and sent
 * to BOTH analyze and tailor. That is what makes the pair cost one unit of
 * quota instead of two — the server dedupes on it. Wiring it into only one of
 * the two calls looks correct in isolation and silently double-charges.
 *
 * analyze and tailor are fired in parallel: tailor does not need the analysis,
 * so total latency is max(analyze, tailor), not their sum. The panel still
 * renders analysis first because it lands first.
 */
export async function runTailor(
  jd: ExtractedJD,
  resume: ParsedResume,
  onUpdate: (patch: Partial<RunState>) => void,
): Promise<void> {
  const fail = (kind: ApiErrorKind, message: string) =>
    onUpdate({ phase: "error", error: { kind, message } });

  onUpdate({ phase: "reading", analysis: null, tailored: null, error: null });

  const parsed = await apiPost<{ jd: ParsedJD }>("/api/parse-jd", { text: jd.text });
  if (!parsed.ok) return fail(parsed.kind, parsed.message);

  const runId = newRunId();
  const payload = {
    structuredResume: resume,
    structuredJD: parsed.data.jd,
    extraInfo: "",
    quality: "quality",
    runId,
  };

  onUpdate({ phase: "comparing" });

  const analyzeCall = apiPost<{ analysis: GapAnalysis; remaining: number | null }>(
    "/api/analyze",
    payload,
  );
  const tailorCall = apiPost<{ tailored: TailorResult; remaining: number | null }>(
    "/api/tailor",
    payload,
  );

  const analyzed = await analyzeCall;
  if (!analyzed.ok) {
    // tailorCall is already in flight and apiPost never rejects, so there is
    // nothing to clean up. Be aware of the consequence: if analyze fails while
    // tailor succeeds, tailor's result is charged and then discarded. Known,
    // accepted, and recorded against the server plan — it needs both requests
    // to land on opposite sides of the quota boundary to happen at all.
    return fail(analyzed.kind, analyzed.message);
  }
  onUpdate({
    phase: "writing",
    analysis: analyzed.data.analysis,
    remaining: analyzed.data.remaining,
  });

  const tailored = await tailorCall;
  if (!tailored.ok) return fail(tailored.kind, tailored.message);

  onUpdate({
    phase: "done",
    tailored: tailored.data.tailored,
    remaining: tailored.data.remaining,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix extension run test`
Expected: PASS — 30 tests total.

- [ ] **Step 5: Commit**

```bash
npm --prefix extension run lint
git add extension
git commit -m "feat(extension): run orchestrator with one shared runId per generate"
```

---

### Task 6: Side panel — resume, extraction, and the two-stage result

Assemble everything into the panel the spec describes: company and role on open with zero network requests, one button, then match score and requirements, then the rewrite.

**Files:**
- Modify: `extension/src/sidepanel/App.tsx`
- Create: `extension/src/sidepanel/useActiveJd.ts`
- Create: `extension/src/sidepanel/ResumeBlock.tsx`
- Create: `extension/src/sidepanel/Results.tsx`
- Modify: `extension/src/styles.css`

**Interfaces:**
- Consumes: `getResume`/`setResume`/`clearResume`/`StoredResume` (Task 2), `apiPostForm` (Task 3), `extractFromDocument`/`ExtractedJD`/`ExtractResult` (Task 4), `runTailor`/`RunState`/`INITIAL_RUN_STATE` (Task 5).
- Produces: the finished v1 panel. B2 replaces `useActiveJd`'s extraction path with site-specific extractors and adds SPA-navigation handling.

- [ ] **Step 1: Extract the JD from the active tab**

Create `extension/src/sidepanel/useActiveJd.ts`:

```ts
import { useCallback, useEffect, useState } from "react";
import type { ExtractResult, ExtractedJD } from "@/content/extract";

/**
 * Reads the JD from the active tab by injecting the content script on demand.
 * `activeTab` means the user clicking our icon IS the permission grant for
 * that tab — which is why the manifest asks for no host permissions on job
 * sites and the install prompt stays narrow.
 */
export function useActiveJd() {
  const [jd, setJd] = useState<ExtractedJD | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const read = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setFailure("No active tab.");
        return;
      }
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["src/content/index.ts.js"],
      });
      const result = (await chrome.tabs.sendMessage(tab.id, {
        type: "CP_EXTRACT_JD",
      })) as ExtractResult | undefined;

      if (!result || !result.ok) {
        setJd(null);
        setFailure("We couldn't read a job posting on this page.");
        return;
      }
      setJd(result.jd);
    } catch {
      setJd(null);
      setFailure("We couldn't read this page. Try reloading it.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void read();
  }, [read]);

  return { jd, failure, loading, reread: read, setJd };
}
```

**Verify the injected filename in Step 8** — CRXJS rewrites content-script paths during build, and `src/content/index.ts.js` is the shape it commonly emits. Open `extension/dist/manifest.json` and the `dist/` tree after building, find the actual emitted filename, and use that. Do not guess: a wrong path fails silently as "couldn't read this page".

- [ ] **Step 2: Build the resume block**

Create `extension/src/sidepanel/ResumeBlock.tsx`:

```tsx
import { useRef, useState } from "react";
import { apiPostForm } from "@/lib/api";
import { setResume, type StoredResume } from "@/lib/storage";
import type { ParsedResume } from "@shared/contract";

export function ResumeBlock({
  stored,
  onChange,
}: {
  stored: StoredResume | null;
  onChange: (r: StoredResume) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append("file", file);
    const res = await apiPostForm<{ resume: ParsedResume }>("/api/parse-resume", form);
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    const record: StoredResume = {
      resume: res.data.resume,
      parsedAt: new Date().toISOString(),
      name: res.data.resume.contact.name || "Your resume",
    };
    await setResume(record);
    onChange(record);
  }

  return (
    <section className="card">
      <div className="row">
        <div>
          <div className="label">My resume</div>
          <div className="muted">
            {stored
              ? `${stored.name} · added ${new Date(stored.parsedAt).toLocaleDateString()}`
              : "No resume yet"}
          </div>
        </div>
        <button onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? "Reading…" : stored ? "Replace" : "Add resume"}
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.docx"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = "";
        }}
      />
      {error && <p className="error">{error}</p>}
      <p className="muted tiny">
        Stored in this browser only — never uploaded for storage.
      </p>
    </section>
  );
}
```

- [ ] **Step 3: Build the results view**

Create `extension/src/sidepanel/Results.tsx`:

```tsx
import type { RunState } from "@/lib/run";
import type { ReqStatus } from "@shared/contract";

const STATUS_MARK: Record<ReqStatus, string> = {
  met: "✅",
  partially_met: "⚠️",
  missing: "❌",
};

const PHASE_COPY: Record<string, string> = {
  reading: "Reading the role's requirements…",
  comparing: "Comparing against your experience…",
  writing: "Writing the tailored version…",
};

export function Results({ state }: { state: RunState }) {
  if (state.phase === "error" && state.error) {
    return <p className="error">{state.error.message}</p>;
  }

  const progress = PHASE_COPY[state.phase];
  const { analysis, tailored } = state;

  return (
    <div>
      {progress && !analysis && <p className="muted">{progress}</p>}

      {analysis && (
        <section className="card">
          <div className="score">
            {analysis.overall_match_score}
            {tailored && <span className="after"> → {tailored.projected_match_score}</span>}
            <span className="muted tiny"> match</span>
          </div>
          {analysis.rationale && <p className="muted">{analysis.rationale}</p>}

          <ul className="reqs">
            {analysis.requirements_matrix.map((row, i) => (
              <li key={i}>
                <span>{STATUS_MARK[row.status]}</span>{" "}
                <strong>{row.requirement}</strong>
                {row.evidence && <div className="muted tiny">{row.evidence}</div>}
              </li>
            ))}
          </ul>

          {analysis.gaps.length > 0 && (
            <>
              <div className="label">Honest gaps</div>
              <ul className="reqs">
                {analysis.gaps.map((g, i) => (
                  <li key={i}>
                    <strong>{g.gap}</strong>
                    {g.mitigation && <div className="muted tiny">{g.mitigation}</div>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {progress && analysis && !tailored && <p className="muted">{progress}</p>}

      {tailored && (
        <section className="card">
          <div className="label">What changed</div>
          <ul className="reqs">
            {tailored.change_log.map((c, i) => (
              <li key={i}>
                <strong>{c.section}</strong>
                <div className="muted tiny">{c.reason}</div>
              </li>
            ))}
          </ul>
          <button
            onClick={() =>
              void navigator.clipboard.writeText(JSON.stringify(tailored.resume, null, 2))
            }
          >
            Copy tailored resume
          </button>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Assemble the panel**

Replace `extension/src/sidepanel/App.tsx`:

```tsx
import { useEffect, useState } from "react";
import { getResume, type StoredResume } from "@/lib/storage";
import { runTailor, INITIAL_RUN_STATE, type RunState } from "@/lib/run";
import { useActiveJd } from "./useActiveJd";
import { ResumeBlock } from "./ResumeBlock";
import { Results } from "./Results";

export default function App() {
  const [stored, setStored] = useState<StoredResume | null>(null);
  const [state, setState] = useState<RunState>(INITIAL_RUN_STATE);
  const { jd, failure, loading } = useActiveJd();

  useEffect(() => {
    void getResume().then(setStored);
  }, []);

  const running = ["reading", "comparing", "writing"].includes(state.phase);
  const canRun = Boolean(jd && stored) && !running;

  async function generate() {
    if (!jd || !stored) return;
    setState(INITIAL_RUN_STATE);
    await runTailor(jd, stored.resume, (patch) =>
      setState((prev) => ({ ...prev, ...patch })),
    );
  }

  return (
    <main>
      <header>
        <div className="label">{jd?.company || (loading ? "Reading page…" : "career-path")}</div>
        <h1>{jd?.title || (failure ? "No posting found" : " ")}</h1>
      </header>

      <ResumeBlock stored={stored} onChange={setStored} />

      <button className="primary" onClick={generate} disabled={!canRun}>
        {running ? "Working…" : "Tailor my resume"}
      </button>
      {state.remaining !== null && (
        <p className="muted tiny center">{state.remaining} free runs left today</p>
      )}
      {!stored && <p className="muted tiny center">Add your resume to get started.</p>}
      {failure && <p className="muted tiny center">{failure}</p>}

      <Results state={state} />
    </main>
  );
}
```

- [ ] **Step 5: Add the panel styles**

Append to `extension/src/styles.css`:

```css
main { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
header h1 { font-size: 15px; margin: 2px 0 0; }
.label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; }
.card { border: 1px solid var(--line); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.muted { color: var(--muted); margin: 0; }
.tiny { font-size: 11px; }
.center { text-align: center; }
.error { color: var(--miss); margin: 0; font-size: 12px; }
.score { font-size: 28px; font-weight: 700; }
.score .after { color: var(--ok); }
.reqs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.reqs li { border-bottom: 1px solid var(--line); padding-bottom: 6px; }
.reqs li:last-child { border-bottom: 0; padding-bottom: 0; }
```

- [ ] **Step 6: Type-check and lint**

Run: `npm --prefix extension run build`
Expected: `tsc --noEmit` passes, then Vite emits `dist/`.

Run: `npm --prefix extension run lint`
Expected: clean.

- [ ] **Step 7: Confirm the repo root is still green**

Run: `npm test && npm run lint && npm run build`
Expected: all green.

- [ ] **Step 8: End-to-end check in Chrome**

Prerequisites: repo-root `.env.local` has `OPENROUTER_API_KEY`, `DEVICE_TOKEN_SECRET`, and `ALLOWED_EXTENSION_IDS` set to the ID from Task 1; `npm run dev` running at the repo root.

1. `npm --prefix extension run build`, then reload the extension.
2. **Fix the injected content-script path.** Open `extension/dist/manifest.json` and list `extension/dist/`; find the emitted content-script file and correct the `files:` entry in `useActiveJd.ts` to match. Rebuild.
3. Open a real job posting in a tab. Click the extension icon.
4. Expected: the panel opens showing the company and role **immediately**, with no network request (check the Network tab of the panel's devtools — right-click inside the panel → Inspect).
5. Add a resume (PDF or DOCX). Expected: it parses and the block shows the name.
6. Click **Tailor my resume**. Expected: progress copy, then the match score and requirement rows, then the change log with the score becoming `before → after`.
7. In the Next.js dev-server terminal, confirm **three** `evt: "llm_call"` lines (parse_jd, analyze, tailor) and that the panel's remaining count dropped by exactly **one**, not two.

Record what you actually observed at each step, including anything that did not work.

- [ ] **Step 9: Commit**

```bash
git add extension
git commit -m "feat(extension): side panel with resume block and two-stage results"
```

---

## Verification checklist

Run after Task 6.

- [ ] `npm --prefix extension run test` — all green
- [ ] `npm --prefix extension run build` — type-checks and emits `dist/`
- [ ] `npm --prefix extension run lint` — clean
- [ ] Repo root `npm test`, `npm run build`, `npm run lint` — all still green
- [ ] Extension loads unpacked with no errors, and its ID matches `ALLOWED_EXTENSION_IDS`
- [ ] Panel shows company and role on open with zero network requests
- [ ] Resume persists across a panel close/reopen and across a browser restart
- [ ] A generate run decrements the remaining count by exactly **one**
- [ ] A page with no posting shows the "couldn't read" message rather than hanging
- [ ] Deleting `cp_device_token` from storage, then running, still succeeds (mint-on-demand works)
- [ ] `extension/key.pem` is untracked (`git status --porcelain extension/key.pem` prints nothing)

## Known limits of B1 — deliberate, not oversights

**Three runs, then a dead end.** B1 has no sign-in, so every user is the
signed-out device tier: `quota:device:<deviceId>`, 3 runs per 30-day window.
When those are gone the panel shows the server's 402 message and offers no way
forward, because "Sign in to continue — 5 free per day" is B2's work. That is
fine for a development and dogfooding milestone and **not** shippable to real
users. Do not put B1 in front of anyone outside the team.

To keep testing past three runs, set `BETA_ACCESS_CODES` in the repo-root
`.env.local` — but note the extension has no UI for entering one in B1, so the
practical path is to clear `cp_device_token` from `chrome.storage.local` and let
the worker mint a fresh identity.

**Generic extraction only.** On LinkedIn and Workday specifically, Readability
will sometimes pull in the "related jobs" rail along with the posting. B2's
purpose-written extractors are what fix that; until then, treat a scruffy
extraction on those two sites as expected rather than as a bug in this plan.

## Deferred to B2

Purpose-written extractors for LinkedIn / Greenhouse / Lever / Ashby / Workday with offline HTML fixtures · SPA-navigation detection and result reset · the Advanced panel (view/edit extracted JD, extra info, Fast/Quality toggle) · auto-expanding Advanced on extraction failure · Clerk sign-in inside the panel and the "Sign in to continue" state · PDF export and Copy as Markdown · Save to cloud · `optional_host_permissions` prompt for unsupported sites · Web Store listing assets and submission.
