# Extension Page Access & Resume Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the extension able to read job postings — five job sites at install, everything else behind one user-initiated grant — and let the user see and correct how their resume was parsed.

**Architecture:** The manifest gains `host_permissions` for five job sites and `optional_host_permissions` for everything else. `useActiveJd` stops returning a bare failure string and returns a typed failure, so the panel can tell "no permission" (offer a button) from "restricted page" (don't). The resume card becomes expandable over a pure `toBreakdown()` function, which keeps the display testable without a React harness.

**Tech Stack:** Chrome MV3, `chrome.permissions`, React 19, TypeScript strict, Vitest.

**Source spec:** `docs/superpowers/specs/2026-08-12-extension-page-access-and-resume-review-design.md`

## Global Constraints

- **No `content_scripts` manifest entry, ever.** It would show "Read and change all your data on all websites" at install. Page access is `host_permissions` (five sites) + `optional_host_permissions` (granted on request) + `activeTab`.
- **Optional host permissions must not appear in the install prompt.** That is why they are `optional_host_permissions` and not `host_permissions`.
- **`chrome.permissions.request` requires a user gesture** — it may only be called from a click handler, never from an effect or on mount.
- **The broad grant is requested exactly once and is global.** `["http://*/*", "https://*/*"]`.
- **The resume breakdown is read-only.** No in-place editing.
- **Empty resume sections render as "Not detected", never omitted.** Hiding them makes a wrong parse look right.
- The base resume stays in `chrome.storage.local` and is never uploaded for storage.
- `shared/contract.ts` is imported with `import type` only.
- `npm --prefix extension run lint` / `test` / `build` green; repo root `npm test` / `lint` / `build` green.

## What cannot be unit-tested here

`chrome.permissions` has no harness in this repo and the grant dialog is browser-native, so the **permission request flow is verified in a live browser only**. Each task says which of its parts are covered by tests and which are not — do not let a green suite imply otherwise.

---

### Task 1: Manifest permissions

The one change that fixes the reported failure. After this task, a Workday/LinkedIn/Greenhouse/Lever/Ashby posting reads with no click and no prompt.

**Files:**
- Modify: `extension/manifest.config.ts`
- Modify: `extension/src/__tests__/manifest.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `host_permissions` = the two API origins followed by the five job-site patterns, in that order; `optional_host_permissions` = `["http://*/*", "https://*/*"]`. Task 2 relies on the optional entry existing — `chrome.permissions.request` rejects origins not declared there.

- [ ] **Step 1: Write the failing test**

Replace the `host_permissions` assertion in `extension/src/__tests__/manifest.test.ts` and add two more. Widen the narrowing cast at the top of that file to include the new key:

```ts
const manifest = manifestExport as {
  content_scripts?: unknown;
  host_permissions?: string[];
  optional_host_permissions?: string[];
};
```

Then replace the existing `"requests no host permission beyond the API origins"` test with:

```ts
  it("requests the API origins plus exactly the five supported job sites", () => {
    expect(manifest.host_permissions).toEqual([
      "http://localhost:3000/*",
      "https://careerpath-hazel.vercel.app/*",
      "*://*.linkedin.com/*",
      "*://*.greenhouse.io/*",
      "*://*.lever.co/*",
      "*://*.ashbyhq.com/*",
      "*://*.myworkdayjobs.com/*",
    ]);
  });

  // Optional host permissions are NOT shown in the install prompt. Declaring
  // them is what lets chrome.permissions.request ask for them later, from a
  // user gesture — requesting an origin that is not declared here fails.
  it("declares the broad origins as OPTIONAL, not granted at install", () => {
    expect(manifest.optional_host_permissions).toEqual([
      "http://*/*",
      "https://*/*",
    ]);
    expect(manifest.host_permissions).not.toContain("http://*/*");
    expect(manifest.host_permissions).not.toContain("https://*/*");
  });
```

Leave the `declares no content_scripts` test exactly as it is.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix extension run test -- src/__tests__/manifest.test.ts`
Expected: FAIL — `host_permissions` is still just the two API origins, and `optional_host_permissions` is `undefined`.

- [ ] **Step 3: Update the manifest**

In `extension/manifest.config.ts`, add below the existing `API_HOSTS` constant:

```ts
// The five job sites the product targets. Granted at install, so the panel
// reads them with no click and no per-tab grant — which activeTab alone
// cannot provide for a window-global side panel that follows tab switches.
// The install prompt names these five domains rather than "all websites".
//
// Note what this does NOT cover: a company that white-labels Workday on its
// own domain (careers.example.com) does not match *.myworkdayjobs.com. Those
// fall to the optional grant below, same as any other site.
const JOB_SITES = [
  "*://*.linkedin.com/*",
  "*://*.greenhouse.io/*",
  "*://*.lever.co/*",
  "*://*.ashbyhq.com/*",
  "*://*.myworkdayjobs.com/*",
];

// Everything else. Optional permissions do NOT appear in the install prompt;
// the panel requests these from a click handler when the user asks to read a
// site we do not already cover. Declaring them here is a precondition —
// chrome.permissions.request rejects origins that are not declared.
const OPTIONAL_HOSTS = ["http://*/*", "https://*/*"];
```

Then change the manifest body:

```ts
  host_permissions: [...API_HOSTS, ...JOB_SITES],
  optional_host_permissions: OPTIONAL_HOSTS,
```

Leave `permissions`, `key`, `background`, `side_panel`, and `action` untouched. Do not add `content_scripts`. Do not add the `tabs` permission.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix extension run test -- src/__tests__/manifest.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Verify the whole suite and both builds**

Run: `npm --prefix extension run test && npm --prefix extension run build && npm --prefix extension run lint`
Expected: all green.

Run: `npm test && npm run lint` at the repo root.
Expected: green.

- [ ] **Step 6: Confirm the built manifest**

Run: `grep -c 'optional_host_permissions' extension/dist/manifest.json` and read `extension/dist/manifest.json`.
Expected: the built manifest carries `host_permissions` with 7 entries and `optional_host_permissions` with 2. The point is to confirm CRXJS passed the optional key through rather than dropping it — a silently-dropped `optional_host_permissions` would make every `chrome.permissions.request` in Task 2 fail at runtime while every test still passed.

- [ ] **Step 7: Commit**

```bash
git add extension/manifest.config.ts extension/src/__tests__/manifest.test.ts
git commit -m "feat(extension): grant five job sites at install, broad origins as optional"
```

---

### Task 2: Typed read failures and the "Read this site" button

`useActiveJd` currently returns a failure *string*, so the panel cannot tell "we lack permission for this host" (offer a grant) from "this is a chrome:// page" (offering one would prompt the user for nothing). This task gives the failure a type and adds the button.

**Files:**
- Create: `extension/src/lib/permissions.ts`
- Create: `extension/src/lib/__tests__/permissions.test.ts`
- Modify: `extension/src/sidepanel/useActiveJd.ts`
- Modify: `extension/src/sidepanel/App.tsx`

**Interfaces:**
- Consumes: Task 1's `optional_host_permissions`.
- Produces:
  - `BROAD_ORIGINS: string[]` — `["http://*/*", "https://*/*"]`
  - `classifyInjectionError(err: unknown): "restricted" | "permission"` — pure, testable
  - `hasBroadHostAccess(): Promise<boolean>`
  - `requestBroadHostAccess(): Promise<boolean>`
  - `useActiveJd()` returns `failure: ReadFailure | null` instead of `failure: string | null`, where
    `type ReadFailure = { kind: "permission" | "restricted" | "no-posting" | "no-tab"; message: string }`,
    plus the existing `jd`, `loading`, `reread`, `setJd`.
  Task 3 does not consume any of this.

- [ ] **Step 1: Write the failing test**

Create `extension/src/lib/__tests__/permissions.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  BROAD_ORIGINS,
  classifyInjectionError,
  hasBroadHostAccess,
  requestBroadHostAccess,
} from "@/lib/permissions";

describe("classifyInjectionError", () => {
  // Chrome's own wording, captured from a real failure during the
  // investigation that produced this plan.
  it("classifies a missing host permission", () => {
    const err = new Error(
      "Cannot access contents of the page. Extension manifest must request permission to access the respective host.",
    );
    expect(classifyInjectionError(err)).toBe("permission");
  });

  it("classifies a chrome:// page as restricted", () => {
    expect(classifyInjectionError(new Error("Cannot access a chrome:// URL"))).toBe(
      "restricted",
    );
  });

  it("classifies the Web Store as restricted", () => {
    expect(
      classifyInjectionError(
        new Error("The extensions gallery cannot be scripted."),
      ),
    ).toBe("restricted");
  });

  it("defaults an unrecognised error to permission, the actionable case", () => {
    expect(classifyInjectionError(new Error("something else entirely"))).toBe(
      "permission",
    );
    expect(classifyInjectionError("not an error object")).toBe("permission");
    expect(classifyInjectionError(undefined)).toBe("permission");
  });
});

describe("host access", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      permissions: {
        contains: vi.fn(async () => false),
        request: vi.fn(async () => true),
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("asks about exactly the declared broad origins", async () => {
    await hasBroadHostAccess();
    expect(chrome.permissions.contains).toHaveBeenCalledWith({
      origins: BROAD_ORIGINS,
    });
  });

  it("reports whether the grant is already held", async () => {
    expect(await hasBroadHostAccess()).toBe(false);
    vi.mocked(chrome.permissions.contains).mockResolvedValue(true);
    expect(await hasBroadHostAccess()).toBe(true);
  });

  it("returns the grant outcome from a request", async () => {
    expect(await requestBroadHostAccess()).toBe(true);
    vi.mocked(chrome.permissions.request).mockResolvedValue(false);
    expect(await requestBroadHostAccess()).toBe(false);
  });

  it("treats a rejected permissions call as 'not granted' rather than throwing", async () => {
    vi.mocked(chrome.permissions.contains).mockRejectedValue(new Error("nope"));
    vi.mocked(chrome.permissions.request).mockRejectedValue(new Error("nope"));
    await expect(hasBroadHostAccess()).resolves.toBe(false);
    await expect(requestBroadHostAccess()).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix extension run test -- src/lib/__tests__/permissions.test.ts`
Expected: FAIL — cannot resolve `@/lib/permissions`.

- [ ] **Step 3: Implement the permissions module**

Create `extension/src/lib/permissions.ts`:

```ts
/**
 * The optional host grant, and the one heuristic this feature depends on.
 */

/** Must stay identical to `optional_host_permissions` in manifest.config.ts. */
export const BROAD_ORIGINS = ["http://*/*", "https://*/*"];

/**
 * Why a `chrome.scripting.executeScript` call failed.
 *
 * HEURISTIC — string-matching a browser's error message is brittle, and this
 * is a deliberate stopgap. The robust signal is the tab's URL, but `tab.url`
 * is gated behind the very permission we are trying to obtain, so it is not
 * available at the moment we need to classify. Once the broad grant is held,
 * `tab.url` becomes readable everywhere and this should be rewritten against
 * it rather than against Chrome's wording.
 *
 * An unrecognised error defaults to "permission", the actionable case: at
 * worst the user is offered a grant that turns out not to help, which is
 * recoverable. Defaulting to "restricted" would strand them with no action.
 */
export function classifyInjectionError(err: unknown): "restricted" | "permission" {
  const text = err instanceof Error ? err.message : String(err ?? "");
  if (/chrome:\/\/|extensions gallery|chrome-extension:\/\//i.test(text)) {
    return "restricted";
  }
  return "permission";
}

export async function hasBroadHostAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: BROAD_ORIGINS });
  } catch {
    // Unavailable or rejected — treat as not granted. The panel then offers
    // the button, and the request itself will surface any real problem.
    return false;
  }
}

/** MUST be called from a user gesture; Chrome rejects it otherwise. */
export async function requestBroadHostAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.request({ origins: BROAD_ORIGINS });
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix extension run test -- src/lib/__tests__/permissions.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Give the read failure a type**

In `extension/src/sidepanel/useActiveJd.ts`, add the import and the exported type:

```ts
import { classifyInjectionError } from "@/lib/permissions";

/**
 * Why a read failed. The panel needs the kind, not just a sentence: only
 * "permission" is worth offering a grant for.
 */
export interface ReadFailure {
  kind: "permission" | "restricted" | "no-posting" | "no-tab";
  message: string;
}
```

Change the state declaration:

```ts
  const [failure, setFailure] = useState<ReadFailure | null>(null);
```

Replace the three `setFailure(...)` calls in `read()` with typed values:

- the no-active-tab branch:
```ts
        setFailure({ kind: "no-tab", message: "No active tab." });
```
- the extraction-returned-too-little branch:
```ts
        setFailure({
          kind: "no-posting",
          message: "We couldn't read a job posting on this page.",
        });
```
- the `catch (err)` branch — keep the existing `console.warn` diagnostic exactly as it is, and replace the `setFailure` beneath it:
```ts
      const kind = classifyInjectionError(err);
      setJd(null);
      setFailure(
        kind === "restricted"
          ? { kind, message: "This page can't be read by extensions." }
          : {
              kind,
              message: "career-path doesn't have permission to read this site.",
            },
      );
```

Delete the old comment block above that `setFailure` that told the user to click the icon — that advice is superseded by the button.

- [ ] **Step 6: Add the button to the panel**

In `extension/src/sidepanel/App.tsx`, add the imports:

```ts
import { hasBroadHostAccess, requestBroadHostAccess } from "@/lib/permissions";
```

Add state and an effect that checks the grant whenever a permission failure appears:

```tsx
  const [hasBroadAccess, setHasBroadAccess] = useState(true);
  const [granting, setGranting] = useState(false);

  useEffect(() => {
    if (failure?.kind !== "permission") return;
    void hasBroadHostAccess().then(setHasBroadAccess);
  }, [failure?.kind]);
```

`hasBroadAccess` starts `true` so the button never flashes on mount before the check resolves.

Add the handler. It must be called from the click, not from an effect — `chrome.permissions.request` requires a user gesture:

```tsx
  async function grantAccess() {
    setGranting(true);
    const granted = await requestBroadHostAccess();
    setGranting(false);
    setHasBroadAccess(granted);
    if (granted) await reread();
  }
```

`reread` comes from `useActiveJd()` — add it to the destructuring, which currently takes only `{ jd, failure, loading }`.

Replace the existing failure line — currently `{failure && <p className="muted tiny center">{failure}</p>}` — with:

```tsx
      {failure && <p className="muted tiny center">{failure.message}</p>}
      {failure?.kind === "permission" && !hasBroadAccess && (
        <button onClick={() => void grantAccess()} disabled={granting}>
          {granting ? "Waiting for Chrome…" : "Read this site"}
        </button>
      )}
```

- [ ] **Step 7: Verify everything**

Run: `npm --prefix extension run test && npm --prefix extension run build && npm --prefix extension run lint`
Expected: all green. The build's `tsc --noEmit` is what catches any remaining place that still treats `failure` as a string.

Run: `npm test && npm run lint` at the repo root.
Expected: green.

- [ ] **Step 8: Record what is NOT covered**

The permission request flow — the button, Chrome's dialog, the re-read after granting — has **no automated coverage**, and cannot have any in this repo. Say so plainly in your report rather than letting the passing suite imply otherwise. The tests cover the error classifier and the two wrappers; they do not cover the flow.

- [ ] **Step 9: Commit**

```bash
git add extension/src/lib/permissions.ts extension/src/lib/__tests__/permissions.test.ts extension/src/sidepanel/useActiveJd.ts extension/src/sidepanel/App.tsx
git commit -m "feat(extension): typed read failures and a Read this site grant button"
```

---

### Task 3: Resume breakdown

The extension stores a structured parse and never shows it. When the parse is wrong — common for PDFs with columns or graphical layouts — every downstream result is wrong and the tailored output still reads fluently, so the user cannot tell.

**Files:**
- Create: `extension/src/sidepanel/breakdown.ts`
- Create: `extension/src/sidepanel/__tests__/breakdown.test.ts`
- Create: `extension/src/sidepanel/ResumeBreakdown.tsx`
- Modify: `extension/src/sidepanel/ResumeBlock.tsx`
- Modify: `extension/src/styles.css`

**Interfaces:**
- Consumes: `ParsedResume` from `@shared/contract`; `apiPostForm` and `setResume` (already imported by `ResumeBlock`).
- Produces:
  - `interface BreakdownEntry { title: string; detail: string; bullets: string[] }`
  - `interface BreakdownSection { label: string; entries: BreakdownEntry[] }`
  - `toBreakdown(resume: ParsedResume): BreakdownSection[]` — pure; a section the parser returned empty comes back with `entries: []`, which the component renders as "Not detected".

- [ ] **Step 1: Write the failing test**

Create `extension/src/sidepanel/__tests__/breakdown.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toBreakdown } from "@/sidepanel/breakdown";
import type { ParsedResume } from "@shared/contract";

const EMPTY: ParsedResume = {
  contact: { name: "", email: "", phone: "", location: "", links: [] },
  summary: "",
  experience: [],
  projects: [],
  skills: [],
  education: [],
};

describe("toBreakdown", () => {
  it("always returns all six sections, in a stable order", () => {
    expect(toBreakdown(EMPTY).map((s) => s.label)).toEqual([
      "Contact",
      "Summary",
      "Experience",
      "Projects",
      "Skills",
      "Education",
    ]);
  });

  // The point of the whole feature: a section the parser dropped must still
  // appear, empty, so the user can SEE that it was dropped. Hiding it would
  // make a wrong parse look right.
  it("keeps a section the parser returned empty, with no entries", () => {
    const projects = toBreakdown(EMPTY).find((s) => s.label === "Projects");
    expect(projects).toBeDefined();
    expect(projects!.entries).toEqual([]);
  });

  it("renders an experience entry with its bullets", () => {
    const r: ParsedResume = {
      ...EMPTY,
      experience: [
        {
          company: "Acme",
          title: "Backend Engineer",
          dates: "2022–2024",
          bullets: ["Built a thing", "Fixed another thing"],
        },
      ],
    };
    const exp = toBreakdown(r).find((s) => s.label === "Experience")!;
    expect(exp.entries).toEqual([
      {
        title: "Backend Engineer · Acme",
        detail: "2022–2024",
        bullets: ["Built a thing", "Fixed another thing"],
      },
    ]);
  });

  it("collapses contact into one entry and drops blank fields", () => {
    const r: ParsedResume = {
      ...EMPTY,
      contact: {
        name: "Ada Lovelace",
        email: "ada@example.com",
        phone: "",
        location: "London",
        links: ["https://example.com"],
      },
    };
    const contact = toBreakdown(r).find((s) => s.label === "Contact")!;
    expect(contact.entries).toHaveLength(1);
    expect(contact.entries[0].title).toBe("Ada Lovelace");
    expect(contact.entries[0].bullets).toEqual([
      "ada@example.com",
      "London",
      "https://example.com",
    ]);
  });

  it("puts every skill in one entry rather than one entry per skill", () => {
    const r: ParsedResume = { ...EMPTY, skills: ["Go", "Postgres", "Kubernetes"] };
    const skills = toBreakdown(r).find((s) => s.label === "Skills")!;
    expect(skills.entries).toEqual([
      { title: "Go, Postgres, Kubernetes", detail: "", bullets: [] },
    ]);
  });

  it("treats a whitespace-only summary as not detected", () => {
    const r: ParsedResume = { ...EMPTY, summary: "   " };
    expect(toBreakdown(r).find((s) => s.label === "Summary")!.entries).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix extension run test -- src/sidepanel/__tests__/breakdown.test.ts`
Expected: FAIL — cannot resolve `@/sidepanel/breakdown`.

- [ ] **Step 3: Implement the transform**

Create `extension/src/sidepanel/breakdown.ts`:

```ts
import type { ParsedResume } from "@shared/contract";

/**
 * Flattens a ParsedResume into what the panel draws.
 *
 * This is a pure function on purpose: the extension has no React test
 * harness, so keeping the shaping logic out of the component is what makes
 * the display's one load-bearing rule — an empty section still appears —
 * testable at all.
 */

export interface BreakdownEntry {
  title: string;
  detail: string;
  bullets: string[];
}

export interface BreakdownSection {
  label: string;
  /** Empty means the parser did not detect this section. Render it as such. */
  entries: BreakdownEntry[];
}

const entry = (
  title: string,
  detail = "",
  bullets: string[] = [],
): BreakdownEntry => ({ title, detail, bullets });

const present = (s: string): boolean => s.trim() !== "";

export function toBreakdown(resume: ParsedResume): BreakdownSection[] {
  const { contact } = resume;
  const contactBullets = [contact.email, contact.phone, contact.location, ...contact.links]
    .filter(present);
  const hasContact = present(contact.name) || contactBullets.length > 0;

  return [
    {
      label: "Contact",
      entries: hasContact ? [entry(contact.name, "", contactBullets)] : [],
    },
    {
      label: "Summary",
      entries: present(resume.summary) ? [entry(resume.summary)] : [],
    },
    {
      label: "Experience",
      entries: resume.experience.map((e) =>
        entry(
          [e.title, e.company].filter(present).join(" · "),
          e.dates,
          e.bullets,
        ),
      ),
    },
    {
      label: "Projects",
      entries: resume.projects.map((p) => entry(p.name, p.description, p.bullets)),
    },
    {
      label: "Skills",
      entries: resume.skills.length > 0 ? [entry(resume.skills.join(", "))] : [],
    },
    {
      label: "Education",
      entries: resume.education.map((e) =>
        entry([e.degree, e.school].filter(present).join(" · "), e.dates),
      ),
    },
  ];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix extension run test -- src/sidepanel/__tests__/breakdown.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Build the breakdown component**

Create `extension/src/sidepanel/ResumeBreakdown.tsx`:

```tsx
import type { ParsedResume } from "@shared/contract";
import { toBreakdown } from "./breakdown";

export function ResumeBreakdown({ resume }: { resume: ParsedResume }) {
  return (
    <div className="breakdown">
      {toBreakdown(resume).map((section) => (
        <div key={section.label}>
          <div className="label">{section.label}</div>
          {section.entries.length === 0 ? (
            <p className="muted tiny">Not detected</p>
          ) : (
            section.entries.map((e, i) => (
              <div key={i} className="bd-entry">
                {e.title && <div className="bd-title">{e.title}</div>}
                {e.detail && <div className="muted tiny">{e.detail}</div>}
                {e.bullets.length > 0 && (
                  <ul className="bd-bullets">
                    {e.bullets.map((b, j) => (
                      <li key={j}>{b}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Make the resume card expandable and add the paste fallback**

In `extension/src/sidepanel/ResumeBlock.tsx`:

Add to the imports:

```tsx
import { ResumeBreakdown } from "./ResumeBreakdown";
```

Add state beside the existing `busy` / `error`:

```tsx
  const [open, setOpen] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState("");
```

Add a text-submitting sibling to the existing `upload`. It posts to the same endpoint using its `text` field, so no server change is needed:

```tsx
  async function submitText() {
    if (text.trim().length < 30) {
      setError("That looks too short to be a resume.");
      return;
    }
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append("text", text);
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
    setPasting(false);
    setText("");
  }
```

Add a disclosure control next to the Replace button — only when a resume exists, since there is nothing to expand otherwise. Inside the existing `<div className="row">`, alongside the button:

```tsx
        {stored && (
          <button onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? "Hide" : "Review"}
          </button>
        )}
```

Then, after the existing `error` line and before the "Stored in this browser only" paragraph:

```tsx
      {open && stored && (
        <>
          <ResumeBreakdown resume={stored.resume} />
          {!pasting ? (
            <button onClick={() => setPasting(true)}>
              Parsed wrong? Paste your resume text instead
            </button>
          ) : (
            <>
              <textarea
                className="paste"
                rows={8}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Paste the full text of your resume here."
              />
              <div className="row">
                <button onClick={() => setPasting(false)}>Cancel</button>
                <button onClick={() => void submitText()} disabled={busy}>
                  {busy ? "Reading…" : "Use this text"}
                </button>
              </div>
            </>
          )}
        </>
      )}
```

The card stays **collapsed by default**, so the main flow — company and role, one button, results — is unchanged.

- [ ] **Step 7: Add the styles**

Append to `extension/src/styles.css`:

```css
.breakdown { display: flex; flex-direction: column; gap: 10px; }
.bd-entry { margin: 4px 0 8px; }
.bd-title { font-weight: 600; }
.bd-bullets { margin: 4px 0 0; padding-left: 16px; }
.bd-bullets li { margin-bottom: 2px; }
.paste {
  width: 100%;
  font: inherit;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px;
  resize: vertical;
}
```

- [ ] **Step 8: Verify everything**

Run: `npm --prefix extension run test && npm --prefix extension run build && npm --prefix extension run lint`
Expected: all green.

Run: `npm test && npm run lint` at the repo root.
Expected: green.

- [ ] **Step 9: Record what is NOT covered**

`toBreakdown` is tested; the component, the disclosure toggle, and the paste flow are not — there is no React test harness in this repo. State that in your report.

- [ ] **Step 10: Commit**

```bash
git add extension/src/sidepanel/breakdown.ts extension/src/sidepanel/__tests__/breakdown.test.ts extension/src/sidepanel/ResumeBreakdown.tsx extension/src/sidepanel/ResumeBlock.tsx extension/src/styles.css
git commit -m "feat(extension): show the parsed resume and offer a paste-text redo"
```

---

## Verification checklist

Automated, after Task 3:

- [ ] `npm --prefix extension run test` — all green
- [ ] `npm --prefix extension run build` and `lint` — green
- [ ] Repo root `npm test`, `npm run build`, `npm run lint` — green
- [ ] `extension/dist/manifest.json` carries both `host_permissions` (7 entries) and `optional_host_permissions` (2 entries), and still has no `content_scripts`

Live browser — **none of this can be automated; a human must do it:**

- [ ] Install prompt names the five job domains and does **not** say "all websites"
- [ ] A Workday / LinkedIn / Greenhouse / Lever / Ashby posting reads with no click beyond opening the panel
- [ ] A site outside that list shows "Read this site"; granting makes it read, and the button never returns — on that site or any other
- [ ] A `chrome://` page says the page can't be read and shows **no** button
- [ ] Expanding the resume card shows all six sections, with empty ones reading "Not detected"
- [ ] Pasting resume text replaces the stored parse and the breakdown updates
