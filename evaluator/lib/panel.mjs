/**
 * Reading and driving the real side panel, opened as an ordinary tab.
 *
 * Tab layout is load-bearing. useActiveJd reads the ACTIVE tab of the panel's
 * own window; if the panel itself is active, the tab it reads is a
 * chrome-extension:// page, executeScript fails, and the panel sets jd=null —
 * which disables the Tailor button and resets the displayed state. So the JD
 * fixture tab is kept ACTIVE and the panel is driven as a BACKGROUND tab in
 * the same window.
 *
 * Consequence: clicks are dispatched in-page rather than through Playwright's
 * input pipeline, because Playwright's actionability checks and screenshots
 * both want the tab in front. That is safe HERE and only here: the one code
 * path in this extension that needs a trusted user gesture is
 * chrome.permissions.request (the panel's "Read this site" button), and the
 * fixture is served on a host the manifest already grants, so that path is
 * never reached. Every other handler — including "Tailor my resume" — is a
 * plain React onClick that a dispatched click drives identically.
 */

const RESULTS_KEY = "cp_results";
const LIVE_RUNS_KEY = "cp_live_runs";
const RESUME_KEY = "cp_resume";
const BETA_CODE_KEY = "cp_beta_code";

export function panelUrl(extensionId) {
  return `chrome-extension://${extensionId}/src/sidepanel/index.html`;
}

export function signinUrl(extensionId) {
  return `chrome-extension://${extensionId}/src/signin/index.html`;
}

export async function seedResume(page, storedResume) {
  await page.evaluate(
    async ([key, value]) => {
      await chrome.storage.local.set({ [key]: JSON.stringify(value) });
    },
    [RESUME_KEY, storedResume],
  );
}

export async function readStorage(page, keys) {
  return page.evaluate((k) => chrome.storage.local.get(k), keys);
}

export async function panelText(page) {
  return page.evaluate(() => document.body?.innerText ?? "");
}

/**
 * The allowance exactly as the panel states it.
 *
 * The two wordings are different tiers and must not be conflated: "N runs
 * left today" is the signed-in daily allowance, "N runs left" (no "today") is
 * the signed-out device trial. A4 turns on that distinction.
 */
export async function readQuotaLine(page) {
  const text = await panelText(page);
  if (/Beta\s*·\s*unlimited/i.test(text)) {
    return { kind: "unlimited", remaining: null, line: "Beta · unlimited", text };
  }
  const daily = /(\d+)\s+runs?\s+left\s+today/i.exec(text);
  if (daily) {
    return { kind: "daily", remaining: Number(daily[1]), line: daily[0], text };
  }
  const trial = /(\d+)\s+runs?\s+left/i.exec(text);
  if (trial) {
    return { kind: "trial", remaining: Number(trial[1]), line: trial[0], text };
  }
  return { kind: "unknown", remaining: null, line: null, text };
}

/**
 * The score card exactly as rendered: "72 → 79 match".
 *
 * A7 turns on the AFTER number specifically. Read from the DOM rather than
 * from chrome.storage on purpose — storage says what the worker measured, and
 * the assertion is about what the user is shown. The two disagreeing is
 * precisely the failure worth catching.
 */
export async function readScoreLine(page) {
  const text = await page.evaluate(
    () => document.querySelector(".score")?.textContent ?? "",
  );
  const match = /(\d+)\s*→\s*(\d+)/.exec(text);
  return {
    line: text.trim() || null,
    before: match ? Number(match[1]) : null,
    after: match ? Number(match[2]) : null,
  };
}

export async function readAccount(page) {
  const text = await panelText(page);
  return {
    signedIn: /Signed in/i.test(text) && !/Sign in for 5 runs a day/i.test(text),
    emailShown: /evaluator\+clerk_test@example\.com/i.test(text),
    hasSignInButton: /\bSign in\b/.test(text),
    text,
  };
}

export async function primaryButtonLabel(page) {
  return page.evaluate(() => {
    const button = document.querySelector("button.primary");
    return button ? { label: button.textContent ?? "", disabled: button.disabled } : null;
  });
}

/** Waits until the panel has extracted the JD from the active tab. */
export async function waitForJd(page, expectedTitle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const info = await page.evaluate(() => ({
      heading: document.querySelector("header h1")?.textContent ?? "",
      label: document.querySelector("header .label")?.textContent ?? "",
      button: document.querySelector("button.primary")?.disabled ?? null,
    }));
    last = info;
    if (info.heading.trim() === expectedTitle) return { ok: true, ...info };
    await page.waitForTimeout(400);
  }
  return { ok: false, ...last };
}

export async function clickPrimary(page) {
  return page.evaluate(() => {
    const button = document.querySelector("button.primary");
    if (!button) return { clicked: false, reason: "no primary button" };
    if (button.disabled) return { clicked: false, reason: "button disabled" };
    button.click();
    return { clicked: true, label: button.textContent ?? "" };
  });
}

/**
 * Waits for the run to reach a terminal state, read from chrome.storage
 * rather than from the DOM.
 *
 * Storage is the contract between the worker and the panel, so it is the
 * least ambiguous place to ask. `cp_results` gaining an entry means the run
 * succeeded and was cached; a `cp_live_runs` entry in phase "error" means it
 * failed. Deliberately NOT read from lib/runLog.ts, which is documented as
 * lossy and has misled previous rounds of this investigation.
 */
export async function readRunStores(page) {
  return page.evaluate(
    async ([resultsKey, liveKey]) => {
      const got = await chrome.storage.local.get([resultsKey, liveKey]);
      const parse = (raw) => {
        try {
          return typeof raw === "string" ? JSON.parse(raw) : null;
        } catch {
          return null;
        }
      };
      const results = parse(got[resultsKey]) ?? {};
      const live = parse(got[liveKey]) ?? {};
      return {
        results: Object.fromEntries(
          Object.entries(results).map(([url, rec]) => [
            url,
            {
              generatedAt: rec?.generatedAt ?? null,
              runId: rec?.runId ?? null,
              // Absent on entries written before rescoring existed and on runs
              // whose rescore leg failed — both are legitimate, so this is
              // read as null rather than treated as corruption.
              rescoredScore: rec?.rescoredScore ?? null,
              projected: rec?.tailored?.projected_match_score ?? null,
            },
          ]),
        ),
        live: Object.fromEntries(
          Object.entries(live).map(([url, rec]) => [
            url,
            {
              phase: rec?.state?.phase ?? null,
              remaining: rec?.state?.remaining ?? null,
              rescoredScore: rec?.state?.rescoredScore ?? null,
              error: rec?.state?.error ?? null,
            },
          ]),
        ),
      };
    },
    [RESULTS_KEY, LIVE_RUNS_KEY],
  );
}

/**
 * @param {object} opts
 * @param {string[]} opts.knownGeneratedAt result timestamps that were already
 *   cached before this click. A second run for the same posting overwrites the
 *   same cache entry, so "an entry exists" is not evidence a NEW run finished.
 *
 * A5 measures FIRST PAINT — the moment a completed result is on screen — and
 * that is why a live run reaching phase "done" counts as the outcome, not just
 * a fresh cache entry. Since the rescore change the worker holds the run open
 * for one more API call after publishing `done`, and only writes `cp_results`
 * once that call settles; keying solely on the cache would silently fold 20-30
 * seconds of a background refinement into the latency budget for a screen the
 * user is already looking at. The cache check stays as the second way in, for
 * the case where the panel is polled after the entry has already been written
 * and the live record cleared.
 */
export async function waitForRunOutcome(page, timeoutMs, { knownGeneratedAt = [], pollMs = 500 } = {}) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  const phases = [];
  let snapshot = null;
  while (Date.now() < deadline) {
    snapshot = await readRunStores(page);

    const phase = Object.values(snapshot.live)[0]?.phase ?? null;
    if (phases[phases.length - 1] !== phase) phases.push(phase);

    if (phase === "done") {
      return { outcome: "done", elapsedMs: Date.now() - started, phases, snapshot, result: null };
    }
    const fresh = Object.entries(snapshot.results).find(
      ([, rec]) => rec.generatedAt && !knownGeneratedAt.includes(rec.generatedAt),
    );
    if (fresh) {
      return { outcome: "done", elapsedMs: Date.now() - started, phases, snapshot, result: fresh };
    }
    const failed = Object.values(snapshot.live).find((r) => r.phase === "error");
    if (failed) {
      return {
        outcome: "error",
        elapsedMs: Date.now() - started,
        phases,
        snapshot,
        error: failed.error,
      };
    }
    await page.waitForTimeout(pollMs);
  }
  return { outcome: "timeout", elapsedMs: Date.now() - started, phases, snapshot };
}

/** P3: prove no beta code is present, which would lift the cap and void every quota assertion. */
export async function readBetaCode(page) {
  const got = await readStorage(page, [BETA_CODE_KEY]);
  return got?.[BETA_CODE_KEY] ?? null;
}

/**
 * Signs out through the panel's own dialog, with the "remove my resume"
 * checkbox UNCHECKED so the seeded resume survives for the anonymous run
 * (A6). Everything is dispatched in-page for the reason at the top of the
 * file — the dialog's controls are ordinary React handlers.
 */
export async function signOutViaPanel(page, timeoutMs = 30_000) {
  const opened = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Sign out" && !b.closest(".dialog"),
    );
    if (!button) return { ok: false, reason: "no sign-out button" };
    if (button.disabled) return { ok: false, reason: "sign-out button disabled" };
    button.click();
    return { ok: true };
  });
  if (!opened.ok) return opened;

  await page.waitForFunction(() => Boolean(document.querySelector(".dialog")), null, {
    timeout: 10_000,
  });

  const confirmed = await page.evaluate(() => {
    const dialog = document.querySelector(".dialog");
    if (!dialog) return { ok: false, reason: "dialog vanished" };
    const box = dialog.querySelector('input[type="checkbox"]');
    // Keep the seeded resume: the anonymous regression run (A6) needs it, and
    // clearing it would turn A6 into a test of the resume upload flow.
    // HTMLElement.click() runs the checkbox's activation behaviour and fires
    // the click event React listens to for onChange, so the controlled
    // component really does see the box come unchecked.
    if (box && box.checked) box.click();
    const confirm = [...dialog.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Sign out",
    );
    if (!confirm) return { ok: false, reason: "no confirm button" };
    confirm.click();
    return { ok: true, checkboxWas: box ? box.checked : null };
  });
  if (!confirmed.ok) return confirmed;

  // Clerk's signOut() is called with a redirectUrl (lib/clerk.ts), so the
  // panel TAB ITSELF navigates to the extension's sign-in page. That is real
  // product behaviour, not an artefact of driving it from a tab: the panel is
  // gone after a sign-out and the caller has to reopen it. Both endings count
  // as success — the navigation, and (if a build ever stops redirecting) the
  // panel simply rendering its signed-out state.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = page.url();
    if (url.includes("/src/signin/index.html")) {
      return { ok: true, endedAt: "signin-page", navigatedAway: true };
    }
    const account = await readAccount(page).catch(() => null);
    if (account && !account.signedIn) {
      return { ok: true, endedAt: "panel", navigatedAway: false };
    }
    await page.waitForTimeout(500);
  }
  return { ok: false, reason: "still signed in after confirming", url: page.url() };
}
