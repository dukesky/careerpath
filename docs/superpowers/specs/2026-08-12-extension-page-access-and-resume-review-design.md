# Extension Page Access & Resume Review — Design

- **Date:** 2026-08-12
- **Status:** Approved, ready for implementation planning
- **Scope:** Two changes to the shipped B1 extension: a working page-access model, and a way for the user to see and correct how their resume was parsed.

---

## 1. Context

B1 shipped a complete side-panel extension and merged to `main`. The first live browser test found it could not read any job posting. The cause is now confirmed from Chrome's own error, captured by diagnostic logging added during the investigation:

> `Error: Cannot access contents of the page. Extension manifest must request permission to access the respective host.`

This is the failure the final whole-branch review predicted and rated Critical. It is not a bug in any one task — it is a **seam between three individually-correct decisions**:

- B1 Tasks 1–2 made the side panel **window-global**, so it outlives the tab it was opened from.
- B1 Task 4 relied on **`activeTab` only**, to keep the install prompt narrow.
- B1 Task 6 added **tab-following re-reads** (`chrome.tabs.onActivated` / `onUpdated`).

Any two compose fine. All three do not: `activeTab` grants host access to one tab, from the gesture that invoked the extension, and Chrome drops that grant on navigation. A panel that follows the user across tabs is therefore reading tabs it has no grant for.

The root cause of the split is a planning error rather than an implementation one. The v1 design spec (`2026-08-10-chrome-extension-v1-design.md` §5) always called for `host_permissions` on five job sites with `optional_host_permissions` elsewhere; the B1 plan deferred **all** of that to B2 and left `activeTab` alone to carry page access, which it cannot do.

A second error appeared in the same log — `Cannot access a chrome:// URL` — fired while the user was on `chrome://extensions`. That one is benign and useful: it confirms the tab-following listeners work correctly. Triggering was never the problem.

### The second change, and why it belongs here

`POST /api/parse-resume` returns a structured `ParsedResume` that the extension stores and uses for every run — and never shows the user. When the parse is wrong (common for PDFs with columns, tables, or graphical layouts, where text extraction garbles reading order), every downstream result is wrong and the user has no way to notice: the tailored output still reads fluently.

Showing the parse is what makes "we only found two of your three internships" discoverable.

---

## 2. Part 1 — Page access

### Manifest

`host_permissions` keeps the two API origins and gains the five job sites the v1 spec named:

```
*://*.linkedin.com/*
*://*.greenhouse.io/*
*://*.lever.co/*
*://*.ashbyhq.com/*
*://*.myworkdayjobs.com/*
```

These are granted at install, so the panel reads those sites with no click, no prompt, and no per-tab grant. The install prompt names five specific domains rather than "all websites". This alone fixes the case that prompted the investigation — GM's careers site is Workday.

`optional_host_permissions` is added for everything else:

```
http://*/*
https://*/*
```

**Optional host permissions do not appear in the install prompt.** The install experience is unchanged from the five named sites.

`activeTab` stays. It is harmless and still covers the tab a user explicitly invokes on.

### The "Read this site" button

Shown in the panel when extraction fails for lack of permission **and** the broad grant is not already held (`chrome.permissions.contains`).

On click — a user gesture, which `chrome.permissions.request` requires — the extension calls:

```ts
chrome.permissions.request({ origins: ["http://*/*", "https://*/*"] })
```

Chrome shows its own dialog. On grant, the panel immediately re-reads the current tab.

**Why one broad grant rather than per-origin:** requesting a single origin requires knowing the current tab's URL, and `tab.url` is itself gated behind either the `tabs` permission or an existing host grant for that tab — the same permission we are trying to obtain. That circularity leaves two ways out, and this design deliberately picks the second:

- Add the `tabs` permission. The install prompt gains "Read your browsing history", and the extension gains the URL and title of *every* tab — far more than the feature needs, and in tension with the product's privacy positioning.
- Request the broad origin set on an explicit button click. The Chrome dialog is heavier ("all your data on all websites"), but it is an **informed, user-initiated, revocable** grant rather than an install-time one, and the install prompt stays narrow.

Because the grant is global and persistent, this button appears at most once in a user's lifetime.

### Restricted pages

`chrome://` pages, the Web Store, and PDF viewer cannot be granted host access at all, so offering the button there would prompt the user for nothing.

The panel distinguishes them by **matching Chrome's error text** (`Cannot access a chrome:// URL`), showing a plain "this page can't be read" message with no button.

This is explicitly a heuristic and must be commented as one in the code: string-matching a browser's error message is brittle. It is what is available today, because the more robust signal — reading `tab.url` — is behind the very permission being requested. Once the broad grant is held, `tab.url` becomes readable and the check should be rewritten against it.

---

## 3. Part 2 — Resume breakdown

### Shape

The existing "My resume" card becomes expandable. It is **collapsed by default**, so the main flow stays what it is: company and role, one button, results. No tab bar; no change to the panel's information architecture.

- **Collapsed:** unchanged from today — `<name> · added <date>` plus **Replace**, with a disclosure control.
- **Expanded:** the parsed resume rendered in the six sections of `ParsedResume` — contact, summary, experience (each entry with its bullets), projects, skills, education — followed by the paste-text fallback.

### Empty sections are shown, not hidden

A section the parser returned empty renders as a muted **"Not detected"** rather than disappearing.

This is the point of the feature. A user who scrolls past a missing Projects section learns nothing; a user who sees "Projects — not detected" learns that the parse dropped something. Hiding empty sections would make the display look correct precisely when it is wrong.

### Correcting a bad parse

Below the breakdown: **"Parsed wrong? Paste your resume text instead"** — a textarea and a submit, posting to the same `POST /api/parse-resume` using its existing `text` field. No server change.

Re-uploading the same PDF cannot help, because the failure happens during text extraction from that file. Pasting plain text skips that step entirely and is by far the highest-yield recovery.

The breakdown is **read-only**. In-place editing of a three-level nested structure (experience → entry → bullets) in a 400px panel is a large amount of UI for a case that pasting text solves better and faster.

---

## 4. Testing

- **Manifest invariants** extend the existing test: `host_permissions` is exactly the two API origins plus the five job sites; `optional_host_permissions` is exactly the two broad patterns; there is still **no `content_scripts` entry**.
- **The breakdown renderer** is a pure function of `ParsedResume` and is testable without a DOM harness: given a resume with an empty `projects` array, it must produce a "not detected" marker rather than omitting the section.
- **Permission flow** cannot be unit-tested — `chrome.permissions` has no harness in this repo and the grant dialog is browser-native. It is verified in a live browser, and the plan must say so rather than implying coverage.

## 5. Out of scope

Editing the parsed resume in place · per-origin permission requests · the `tabs` permission · a tab bar in the panel · the five sites' purpose-written extractors (still B2) · SPA navigation · sign-in · export formats.

## 6. Success criteria

1. On a Workday, LinkedIn, Greenhouse, Lever, or Ashby posting, the panel reads the JD with no prompt and no click beyond opening the panel.
2. On any other site, the panel offers "Read this site"; after granting, that site and every other site read without further prompting.
3. On a `chrome://` page, the panel says the page cannot be read and offers no button.
4. The install prompt names five specific domains and does not say "all websites".
5. Expanding the resume card shows all six sections, with empty ones marked "not detected".
6. Pasting resume text replaces the stored parse, and the breakdown updates to match.
