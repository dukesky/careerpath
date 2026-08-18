# Extension Sign-In — Design

- **Date:** 2026-08-17
- **Status:** Approved, ready for implementation planning
- **Scope:** Let a user sign in from the side panel, which raises their quota, lets them save a tailored resume, and makes their identity visible. Plus the extension's first icon.

---

## 1. Context

The extension has never had sign-in. Every user is the signed-out device tier: **3 runs per 30 days**, with no in-panel way forward once exhausted. The B1 release recorded this as the reason it is "not shippable outside the team", and it remains the single thing standing between the extension existing and anyone else being able to use it.

Signing in unlocks three things of very different sizes:

- **The user tier — 5 runs per day.** This costs nothing to build. `resolveCaller` already takes a Clerk user id and prefers it over the device token, and `getCaller` already resolves the Clerk session on every request. Sending a Clerk token instead of a device token is the whole change.
- **Saving a tailored resume.** `POST /api/saved` exists and is Clerk-gated. One button.
- **Browsing saved resumes in the panel.** A second screen in a 400px surface. **Deferred** — the panel already links out to the web app's list, and that link works.

### What was verified before designing

- **The server needs no changes.** `@clerk/backend` reads `constants.Headers.Authorization` and parses a Bearer token, so a Clerk session token in that header resolves through `auth()` exactly as a cookie would. `resolveCaller(request, clerkUserId)` then returns `{ kind: "user" }` and the user tier applies.
- **Sync Host does not work here.** Clerk's own documentation states the Chrome Extension SDK "does not fully support Sync Host on side panels". So "sign in on the website and the panel picks it up" is not available. Sign-in must happen inside the extension.
- **The CRX ID is already pinned** via the manifest `key`, which Clerk requires. That fell out of B1 by luck rather than foresight.

---

## 2. Where sign-in happens

A dedicated full-page extension route, `signin.html`, opened from the panel in a new tab. It offers **email code and Google**. The side panel carries no sign-in UI of its own — only a button that opens that page.

The panel is 400px wide, and an OAuth flow launched from a side panel is the least predictable surface in Chrome. A normal extension page makes the OAuth leg an ordinary tab redirect. Extension pages share `chrome.storage` with the panel, so the session the page establishes is the session the panel reads.

Opening it needs no new permission: `chrome.runtime.getURL("signin.html")` in a plain anchor.

---

## 3. How the session reaches the API — and the 401 fork

`api.ts` today attaches `Authorization: Bearer <device token>` to every request, and treats **any** 401 as "the device token expired": mint a fresh one via `ensureToken(true)`, retry once, never loop.

After sign-in the same header carries a **Clerk session token**, and a 401 now has two incompatible meanings:

| Token sent | A 401 means | Correct response |
|---|---|---|
| Device token | The token we issued expired | Mint another, retry once. The user never notices. |
| Clerk token | The user's **session** is gone — expired, or signed out elsewhere | Nothing can be silently minted. The user must sign in again. |

**If the two are not distinguished, the failure is silent rather than loud.** A Clerk 401 falls into the existing branch, `ensureToken(true)` mints a *device* token, the retry **succeeds** — and the user is now transacting as a signed-out device on the 3-per-30-days tier while the panel still shows their email and "5 free runs left today". They burn a trial they cannot see, and the quota on screen is a lie.

That is the same shape as the Redis fallback this project just fixed: not a crash, an invisible downgrade.

**So `send()` must remember which kind of token it attached, and branch:**

- device token + 401 → refresh once and retry, as today
- Clerk token + 401 → **do not** mint a device token, **do not** retry. Return a distinct failure the panel renders as "your session expired", and open the sign-in page.

This logic touches no network and no UI. It is the most testable part of this change and the most dangerous, so it carries tests.

---

## 4. Manifest changes, and what they cost

Clerk requires two additions:

- `permissions` gains `"cookies"`
- `host_permissions` gains the **Clerk Frontend API host** — `<slug>.clerk.accounts.dev` in development, `clerk.<domain>` in production

Two consequences that are not details:

**The install prompt widens.** The entire page-access design existed to keep that prompt to five named job sites and never "all websites". This adds a domain and a permission to it. Accepted deliberately: without that host permission the extension cannot talk to Clerk at all, and sign-in does not exist.

**Publishing is now coupled to the production Clerk domain.** Adding a `host_permissions` entry after publishing disables the extension for every existing user pending re-approval — already recorded as a known limit. The development and production Clerk hosts are *different domains*, so the production host must be in the manifest **before** the first Web Store submission. That ties this work to the `career-allpath.com` move: settle the production Clerk domain first, publish second.

`manifest.config.ts` is TypeScript and already branches on build mode elsewhere, so it can carry the right host per build.

---

## 5. Panel states

**Signed out** — unchanged, plus a **Sign in** affordance. Critically, the dead end at the bottom of the trial becomes the place sign-in is offered: when the device tier is exhausted the panel currently says nothing useful, and that is exactly where "Sign in for 5 runs a day" belongs.

**Signed in** — the header shows the account's email and the remaining daily quota, plus sign-out. Identity and allowance both become visible; without that, signing in changes nothing the user can see, since the quota difference is otherwise invisible and saving navigates away.

---

## 6. Saving from the panel

A **Save** control beside **Download PDF**, `POST`ing the tailored result to the existing `/api/saved`.

It appears **only when signed in**. Showing it signed-out and failing on click would teach the user that the button is broken rather than that they are not signed in.

---

## 7. Signing out

Sign-out asks for confirmation, with a checkbox — **checked by default** — reading approximately *"Also remove my resume and saved results from this browser."*

The extension holds the base resume and up to 20 generated results in `chrome.storage.local`. Sign-out creates the moment a user expects that data to be gone, especially on a shared machine — but on their own machine, clearing means re-uploading and re-parsing the resume. Only the user knows which situation they are in. A default-checked box puts the safe option first while leaving the judgment with them.

---

## 8. The extension icon

The extension currently declares **no icons at all** — `action` carries only `default_title`, so Chrome shows the default puzzle piece.

Source artwork exists at `extension/icons-src/careerpath_512.png` and `careerpath_32.png` (currently in the main checkout; they must be copied onto this branch). Wire both `icons` (16, 32, 48, 128) and `action.default_icon`.

**16px is derived from the 32px source, not the 512px one.** Downscaling detailed artwork straight to 16px turns fine strokes into a grey smear; a source already drawn for small sizes survives the step much better. Whether the artwork needs its padding cropped is decided by looking at the real file during implementation, not from a rendered preview.

---

## 9. Privacy

`/privacy` must change with this, as in every prior release:

- Signing in creates an account, and Clerk is already named as the third party handling it — but the extension now talks to Clerk directly, which the page does not currently say.
- Sign-out can clear the resume and cached results from the device.
- A signed-in user's quota is counted against their account rather than a device id. The page already describes the device-id case and needs the account case beside it.

---

## 10. Configuration, not code

- The Clerk instance needs `chrome-extension://<the pinned CRX ID>` in its allowed origins.
- The production Clerk instance and its Frontend API domain must exist before the manifest's production `host_permissions` can be correct.

Neither is a repository change; both block the feature working.

---

## 11. Out of scope

Browsing saved resumes inside the panel · Sync Host · organizations and teams · migrating a device tier's consumed runs onto a newly signed-in account (the counters are separate keys; signing in simply starts a fresh daily allowance) · changing anything about anonymous use, which keeps working exactly as it does today.

---

## 12. Success criteria

1. A signed-out panel offers a way to sign in, and offers it at the point the trial is exhausted.
2. Sign-in completes in an extension page, by email code and by Google, and the panel reflects it without being reopened.
3. A signed-in request reaches the API as `{ kind: "user" }`, and the panel shows 5 runs per day rather than the device trial.
4. A 401 on a Clerk token does **not** mint a device token, does **not** retry, and surfaces as an expired session.
5. A 401 on a device token still refreshes once and retries, exactly as before.
6. **Save** appears only when signed in, and a saved resume shows up in the web app's saved list.
7. The header shows the signed-in email and the remaining daily quota.
8. Sign-out asks before clearing, and clears the resume and cached results when the box is left checked.
9. The toolbar shows the career-path icon rather than the default puzzle piece.
10. `/privacy` describes the account, the Clerk connection, and the sign-out clearing behaviour.
