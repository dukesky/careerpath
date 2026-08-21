import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getResume, type StoredResume } from "@/lib/storage";
import { runTailor, newRunId, INITIAL_RUN_STATE, type RunState } from "@/lib/run";
import { hasBroadHostAccess, requestBroadHostAccess } from "@/lib/permissions";
import { resumeFingerprint } from "@/lib/fingerprint";
import {
  cacheKey,
  clearCachedRuns,
  countCachedRuns,
  getCachedRun,
  putCachedRun,
} from "@/lib/cache";
import { API_BASE } from "@/lib/config";
import {
  currentUserEmail,
  installClerkTokenSource,
  isSignedIn,
  signInPageUrl,
} from "@/lib/clerk";
import { useActiveJd } from "./useActiveJd";
import { ResumeBlock } from "./ResumeBlock";
import { Results } from "./Results";
import { AccountBar } from "./AccountBar";

export default function App() {
  const [stored, setStored] = useState<StoredResume | null>(null);
  const [state, setState] = useState<RunState>(INITIAL_RUN_STATE);
  // When the currently-displayed result was generated, ISO 8601. Non-null for
  // both a fresh run and a restored one — a result is a result.
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  // What the DISPLAYED result was generated with. Distinct from the draft
  // below: the draft is what is typed but not yet sent.
  const [appliedSupplement, setAppliedSupplement] = useState("");
  const [supplementDraft, setSupplementDraft] = useState("");
  // The run this posting's displayed result came from. Reusing it makes a
  // regeneration free. "" means there is nothing to refine, so the next
  // generate mints a fresh id and is charged.
  const [runIdForPosting, setRunIdForPosting] = useState("");
  // Drives the clear control, which stays hidden while there is nothing to
  // clear. Refreshed after every write and after clearing.
  const [cachedCount, setCachedCount] = useState(0);
  // Whether a runTailor() promise is currently unresolved. This is tracked
  // SEPARATELY from `state.phase` and set/cleared ONLY inside generate()'s
  // try/finally below — nothing else may write it. That separation is load-
  // bearing: the JD-change effect a few lines down calls
  // setState(INITIAL_RUN_STATE) on every tab switch, including a switch back
  // to a URL whose run is still executing. If "is a run in flight" were
  // derived from `state.phase` (as it originally was, via `phase ===
  // "reading" | "comparing" | "writing"`), that reset would silently flip it
  // back to "idle" mid-run and re-enable the button with no on-screen sign a
  // run was still going — letting a second click start a second paid run
  // against the same posting while the first was still charging quota.
  // `busy` cannot be cleared by that effect because the effect never
  // touches it.
  const [busy, setBusy] = useState(false);
  const { jd, failure, loading, reread } = useActiveJd();
  const [hasBroadAccess, setHasBroadAccess] = useState(true);
  const [granting, setGranting] = useState(false);
  // Identity, for AccountBar. Both are one-shot Clerk reads (see lib/clerk.ts)
  // — there is no push notification when a sign-in completes in the separate
  // tab it opens in, so this starts signed-out and is re-checked below on
  // mount and whenever the panel's document becomes visible again, which is
  // the moment a user returns from that tab. `remaining` is NOT duplicated
  // here: AccountBar reads it straight off `state.remaining`.
  const [signedIn, setSignedIn] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  // Whether a Save (SaveButton, inside Results) currently has a POST to
  // /api/saved in flight. Folded into `canRun` below so a regenerate cannot
  // start while a save is pending — see SaveButton.tsx's doc comment for the
  // lost-feedback race this closes: without it, a regenerate completing
  // mid-save changes `generatedAt`, which remounts SaveButton (it is keyed
  // on that value in Results.tsx) out from under the still-in-flight
  // request, and the request's eventual result lands on an unmounted
  // component as a silent no-op.
  const [saving, setSaving] = useState(false);

  // Recomputed only when the stored resume object changes, because it walks
  // the whole resume. It is also an effect dependency below, which is what
  // makes replacing a resume clear a displayed result.
  const fingerprint = useMemo(
    () => (stored ? resumeFingerprint(stored.resume) : ""),
    [stored],
  );
  // This posting's frozen baseline, restored from cache or set by the first
  // run. Null means "not measured yet", and the display falls back to the
  // current analyze score — which is the value about to become the baseline,
  // so nothing jumps when the run completes.
  const [baselineForPosting, setBaselineForPosting] = useState<number | null>(null);

  useEffect(() => {
    void getResume().then(setStored);
    void countCachedRuns().then(setCachedCount);
  }, []);

  // isSignedIn()/currentUserEmail() are one-shot reads (see lib/clerk.ts),
  // so this is the one place that re-queries them; everything else — the
  // mount effect below and the visibility effect after it — just calls this.
  //
  // Both go through getClerk(), which clerk.ts documents as able to reject
  // transiently (a `load()` that briefly can't reach Clerk's Frontend API).
  // A rejection here is benign for display — AccountBar just keeps showing
  // whatever it last knew — but silent otherwise, so record it the same
  // structured way session.ts does for the equivalent Clerk-source failure,
  // rather than letting it surface as an unhandled rejection.
  const refreshAccount = useCallback(async () => {
    try {
      const signed = await isSignedIn();
      setSignedIn(signed);
      setEmail(signed ? await currentUserEmail() : null);
    } catch (err) {
      console.warn(
        JSON.stringify({
          evt: "refresh_account_failed",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }, []);

  // installClerkTokenSource() wires lib/clerk.ts's Clerk client into
  // session.ts as the source api.ts consults for every request (see
  // clerk.ts's own doc comment). It MUST run exactly once, and here, at the
  // panel's bootstrap — without it every request carries the device
  // identity and this whole feature is inert, silently: nothing throws,
  // requests just never look signed in.
  useEffect(() => {
    installClerkTokenSource();
    void refreshAccount();
  }, [refreshAccount]);

  // Sign-in happens in a separate tab (see AccountBar) — Clerk's
  // chrome-extension sync host does not work inside a side panel, so there
  // is no push notification back into this panel when it completes. The
  // panel document regaining visibility is the best available signal that
  // the user has come back from that tab, so re-check then. Best-effort: if
  // a browser never fires this for a side panel that was never actually
  // hidden, the user still sees the right state on the next full panel
  // open — this just saves them that reopen in the common case.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshAccount();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refreshAccount]);

  // `hasBroadAccess` starts `true` so the button never flashes on mount
  // before this async check resolves.
  useEffect(() => {
    if (failure?.kind !== "permission") return;
    void hasBroadHostAccess().then(setHasBroadAccess);
  }, [failure?.kind]);

  // `jd` is re-read on tab switch/navigation (see useActiveJd), so its `url`
  // is the panel's source of truth for "which posting am I looking at now."
  // Track it in a ref (readable synchronously from the runTailor callback
  // below), keyed on `url` specifically — not the `jd` object, which is a
  // fresh reference on every read even when the posting hasn't changed.
  //
  // This used to reset and stop. That is what destroyed a result the user had
  // just paid for the moment they opened another tab. It now clears the
  // display and then restores whatever this posting already has.
  //
  // It intentionally leaves `busy` alone: switching tabs must clear what's on
  // screen, but must not make the button clickable again while generate() is
  // still running.
  const activeJdUrlRef = useRef<string | undefined>(jd?.url);
  // Which posting generate() currently owns the display for, or undefined.
  // Written ONLY alongside `busy`, in generate()'s try/finally — same
  // discipline, same reason.
  const runningForUrlRef = useRef<string | undefined>(undefined);
  // The supplement the in-flight run was started with. `supplementDraft` is a
  // single global piece of state, but the effect below early-returns for a
  // posting whose run is still going — so without this, switching A -> B -> A
  // mid-run leaves B's text in the box under A, and regenerating would submit
  // B's claimed experience as A's. Written only where `busy` is.
  const runningSupplementRef = useRef("");
  useEffect(() => {
    // Normalized, not raw: `activeJdUrlRef` and `runningForUrlRef` (below) are
    // both compared against this value, and cache.ts already keys entries on
    // `cacheKey(url)` rather than the raw URL. Without normalizing here too,
    // "same posting" means one thing to these guards and another to the
    // cache: a navigation that only drops `?utm_source=…` changes the raw URL
    // while normalizing to the same posting, so every raw comparison below
    // would conclude "different posting" while getCachedRun/putCachedRun
    // conclude "same" — wiping a live run's display and repainting a stale
    // cached result over it, then losing the fresh result once it lands
    // because the raw comparison fails again. cacheKey is idempotent, so
    // re-normalizing an already-normalized value before getCachedRun/
    // putCachedRun below is harmless.
    const url = jd?.url ? cacheKey(jd.url) : undefined;
    activeJdUrlRef.current = url;
    // A run in flight for THIS posting already owns the display. Wiping and
    // restoring here would replace the live run with the PREVIOUS cached
    // result — labelled "done", carrying its old timestamp — while the button
    // still reads "Working…". In the ordering where this read resolves after
    // the run's own write, it never corrects itself, and the user's freshly
    // paid result is hidden behind an older one. That is the exact loss this
    // cache exists to prevent, so leave a live run alone.
    //
    // `url &&` is load-bearing, not defensive noise. runningForUrlRef.current
    // is `undefined` when idle, and `url` is ALSO `undefined` on any page with
    // no detected posting (useActiveJd sets jd to null there). Without this
    // guard the two `undefined`s compare equal, the wipe is skipped, and the
    // previous posting's result stays frozen on screen while the user browses
    // unrelated pages.
    if (url && runningForUrlRef.current === url) {
      // Returning to a posting whose run is still going. Leave the display to
      // the run, but put its own supplement back — the draft may hold another
      // posting's text from the tab we just came from.
      setSupplementDraft(runningSupplementRef.current);
      return;
    }
    setState(INITIAL_RUN_STATE);
    setGeneratedAt(null);
    setAppliedSupplement("");
    setSupplementDraft("");
    setRunIdForPosting("");
    setBaselineForPosting(null);
    if (!url || !fingerprint) return;
    void getCachedRun(url, fingerprint).then((hit) => {
      // chrome.storage reads are async and tab switches are fast, so this can
      // resolve after the user has already moved on. Painting it then would
      // show one posting's result underneath another posting's header.
      if (!hit || activeJdUrlRef.current !== url) return;
      // A run may also have STARTED while this read was pending — same stale
      // paint, no tab switch needed.
      if (runningForUrlRef.current === url) return;
      setState({
        phase: "done",
        analysis: hit.analysis,
        tailored: hit.tailored,
        // Not cached: it is a live server-side count, and showing a stale one
        // is worse than showing none. The next run refreshes it.
        remaining: null,
        error: null,
      });
      setGeneratedAt(hit.generatedAt);
      setAppliedSupplement(hit.extraInfo);
      setSupplementDraft(hit.extraInfo);
      setRunIdForPosting(hit.runId);
      setBaselineForPosting(hit.baselineScore);
    });
    // `fingerprint` is a dependency deliberately, not incidentally: it is the
    // mechanism by which replacing a resume clears a displayed result. The
    // fingerprint changes, this effect re-runs, the display is wiped, and the
    // now-invalid entry fails getCachedRun's provenance rule so nothing is
    // restored over it.
  }, [jd?.url, fingerprint]);

  const canRun = Boolean(jd && stored) && !busy && !saving;

  async function generate(supplement: string) {
    // `saving` as well as `busy`, and checked HERE rather than only on the
    // buttons: `canRun` already disables both regenerate triggers during a
    // save, but that is the callers' guard, not this function's. Defence in
    // depth for a race whose symptom is silent (a save's outcome lost to an
    // unmounted SaveButton — see SaveButton.tsx's doc comment) is worth one
    // line.
    if (!jd || !stored || busy || saving) return;
    // Pin which posting this run is for. If the user switches tabs while a
    // run is in flight, activeJdUrlRef.current moves on; a patch that lands
    // after that point is for a posting the user is no longer looking at,
    // so drop it instead of painting stale results over the new page.
    const forUrl = cacheKey(jd.url);
    // Refining reuses this posting's run id, which is what makes it free.
    // A first generate — or one after a cache entry too old to carry an id —
    // mints a new one and is charged.
    const runId = supplement.trim().length > 0 && runIdForPosting
      ? runIdForPosting
      : newRunId();
    setState(INITIAL_RUN_STATE);
    setGeneratedAt(null);
    setAppliedSupplement("");
    runningForUrlRef.current = forUrl;
    runningSupplementRef.current = supplement;
    setBusy(true);
    // Accumulate the run's own result HERE rather than reading it back out of
    // `state` when the run finishes. The line below deliberately drops the
    // final patch from the DISPLAY when the user has switched tabs — so
    // `state` would hold nothing to cache, losing exactly the result this
    // cache exists to preserve, in exactly the case that motivated it.
    let latest: RunState = INITIAL_RUN_STATE;
    try {
      await runTailor(
        jd,
        stored.resume,
        (patch) => {
          latest = { ...latest, ...patch };
          if (activeJdUrlRef.current !== forUrl) return;
          setState((prev) => ({ ...prev, ...patch }));
        },
        { extraInfo: supplement, runId },
      );
      if (latest.phase === "done" && latest.analysis && latest.tailored) {
        const finishedAt = new Date().toISOString();
        // Read the baseline from storage rather than from `baselineForPosting`.
        // That state is null between the JD-change effect firing and its
        // storage read resolving, and the button is live during that window —
        // so a user who clicks regenerate on a still-blank panel would
        // otherwise re-measure and durably overwrite the stored baseline,
        // which is the exact symptom this whole change exists to remove.
        //
        // Keyed by `forUrl`, and deliberately NOT via a ref: a ref is mutated
        // by the JD-change effect, so it would hand another posting's baseline
        // to this run. This lookup also gives the right answer when the resume
        // has changed — getCachedRun rejects the entry on the fingerprint, so
        // a new resume correctly gets a new measurement.
        const cachedForBaseline = await getCachedRun(forUrl, fingerprint);
        const baseline =
          cachedForBaseline?.baselineScore ?? latest.analysis.overall_match_score;
        await putCachedRun(forUrl, {
          analysis: latest.analysis,
          tailored: latest.tailored,
          generatedAt: finishedAt,
          extraInfo: supplement,
          runId,
          baselineScore: baseline,
          resumeFingerprint: fingerprint,
        });
        setCachedCount(await countCachedRuns());
        // These describe THIS posting's displayed result, so they belong
        // inside the guard with setState. Outside it, a run finishing while
        // the user is on another posting stamps that posting with this run's
        // marker and run id — mislabelling it, and spending this id's free
        // refinements under the wrong entry. Nothing is lost by guarding
        // them: the correct values went into the cache entry above and come
        // back on the next restore.
        if (activeJdUrlRef.current === forUrl) {
          setAppliedSupplement(supplement);
          setRunIdForPosting(runId);
          setBaselineForPosting(baseline);
          // Paint the completed run rather than only stamping it. `latest` is a
          // complete RunState, so this is a no-op on the normal path — but it
          // also covers the window between runTailor resolving and the finally
          // below, where the display can have been wiped by a tab switch back
          // to this same posting while runningForUrlRef still suppressed the
          // cache restore. Without it the user's freshly paid result is
          // invisible until they switch tabs again.
          setState(latest);
          setGeneratedAt(finishedAt);
        }
      }
    } finally {
      runningForUrlRef.current = undefined;
      runningSupplementRef.current = "";
      setBusy(false);
    }
  }

  // Must be called from a click handler, not an effect: chrome.permissions.request
  // requires a user gesture, or Chrome rejects it.
  async function grantAccess() {
    setGranting(true);
    const granted = await requestBroadHostAccess();
    setGranting(false);
    setHasBroadAccess(granted);
    if (granted) await reread();
  }

  // Clearing wipes what is on screen too: a displayed result is, by this
  // point, also a cached one, so leaving it up would make the control look
  // like it did nothing. Disabled while a run OR a save is in flight (see
  // the JSX) so it cannot yank a run's output out from under it mid-flight,
  // and so it cannot null `tailored` mid-save — which unmounts SaveButton
  // through Results.tsx's `tailored &&` gate and loses the save's outcome.
  async function clearCache() {
    await clearCachedRuns();
    setCachedCount(0);
    setState(INITIAL_RUN_STATE);
    setGeneratedAt(null);
    setAppliedSupplement("");
    setSupplementDraft("");
    setRunIdForPosting("");
    setBaselineForPosting(null);
  }

  // SignOutDialog reports local-data clearing and session end as two
  // SEPARATE signals now, not one bundled behind the other — see
  // SignOutDialog's own doc comments for why. clearResume()/clearCachedRuns()
  // succeeding and signOut() itself failing are independent outcomes: if we
  // only reset this display after BOTH had resolved, a signOut()-specific
  // failure (storage genuinely emptied, Clerk session genuinely still live)
  // would leave the panel showing the previous session's resume/cache/run
  // state as if nothing happened, when storage underneath had already lost
  // it. Splitting the handler in two lets each side of App's state track the
  // side of reality that actually changed, exactly when it changed.

  // Mirrors exactly what SignOutDialog cleared in storage (only called when
  // the box was checked and clearResume()/clearCachedRuns() both succeeded)
  // — leaving these untouched on screen would make the panel lie about what
  // is still there once storage is empty.
  function handleLocalDataCleared() {
    setStored(null);
    setCachedCount(0);
    setState(INITIAL_RUN_STATE);
    setGeneratedAt(null);
    setAppliedSupplement("");
    setSupplementDraft("");
    setRunIdForPosting("");
    setBaselineForPosting(null);
  }

  // Only called once signOut() itself has resolved successfully — ending the
  // session is what "sign out" means, independent of whether the box was
  // checked or local clearing succeeded.
  function handleSignedOut() {
    setSignedIn(false);
    setEmail(null);
    // The remaining count, and ONLY it. `remaining` is per-identity: the
    // number on screen was counted against the account that just ended, at
    // 5 per day. AccountBar's signed-out branch renders the same value under
    // 30-day-tier wording ("3 runs left"), so leaving it would state the
    // previous account's daily figure as this device's 30-day trial — a
    // number that is simply wrong, and unfalsifiable until the next run.
    // With the box UNCHECKED, handleLocalDataCleared never runs, so nothing
    // else resets this.
    //
    // A partial update, deliberately: resetting the rest of `state` here
    // would wipe the displayed result, which is exactly what leaving the box
    // unchecked asked us not to do.
    setState((s) => ({ ...s, remaining: null }));
  }

  return (
    <main>
      <header>
        <div className="label">{jd?.company || (loading ? "Reading page…" : "career-path")}</div>
        <h1>{jd?.title || (failure ? "No posting found" : " ")}</h1>
      </header>

      <AccountBar
        signedIn={signedIn}
        email={email}
        remaining={state.remaining}
        busy={busy}
        saving={saving}
        onLocalDataCleared={handleLocalDataCleared}
        onSignedOut={handleSignedOut}
      />

      <ResumeBlock stored={stored} onChange={setStored} />

      {cachedCount > 0 && (
        <button
          className="textbtn"
          onClick={() => void clearCache()}
          disabled={busy || saving}
        >
          Clear {cachedCount} cached result{cachedCount === 1 ? "" : "s"}
        </button>
      )}

      <button className="primary" onClick={() => void generate(supplementDraft)} disabled={!canRun}>
        {busy ? "Working…" : state.tailored ? "Tailor again" : "Tailor my resume"}
      </button>
      {!stored && <p className="muted tiny center">Add your resume to get started.</p>}
      {failure && <p className="muted tiny center">{failure.message}</p>}
      {failure?.kind === "permission" && !hasBroadAccess && (
        <button onClick={() => void grantAccess()} disabled={granting}>
          {granting ? "Waiting for Chrome…" : "Read this site"}
        </button>
      )}

      <Results
        state={state}
        company={jd?.company ?? ""}
        roleTitle={jd?.title ?? ""}
        jdSummary={jd?.text ?? ""}
        jdUrl={jd?.url}
        signedIn={signedIn}
        saving={saving}
        onSavingChange={setSaving}
        generatedAt={generatedAt}
        baselineScore={baselineForPosting}
        appliedSupplement={appliedSupplement}
        supplement={{
          text: supplementDraft,
          onChange: setSupplementDraft,
          onSubmit: () => void generate(supplementDraft),
          busy,
          canRun,
        }}
      />

      {/* The single place a signed-out user hits a dead end today: the free
          trial (3 runs / 30 days) is exhausted and there was no way forward
          in the panel. A signed-in user's OWN daily quota running out gets
          no such offer here — 5/day is already the raised allowance, and
          there is nothing further to sign into. */}
      {state.phase === "error" && state.error?.kind === "quota" && !signedIn && (
        <section className="card">
          <p className="muted tiny">
            Sign in to raise your limit from 3 runs every 30 days to 5 runs a day.
          </p>
          <a className="btn primary" href={signInPageUrl()} target="_blank" rel="noreferrer">
            Sign in for more runs
          </a>
        </section>
      )}

      {/* Task 2's api.ts forks a Clerk 401 into this distinct error kind
          specifically so the user could be TOLD their session is gone
          rather than silently continuing as a signed-out device on the
          smaller tier while the header still showed their email — see
          api.ts's `send()` doc comment. This is the visible half of that
          guarantee: a route back to sign-in, not just the generic message
          Results.tsx already renders for every error kind including this
          one. */}
      {state.phase === "error" && state.error?.kind === "session_expired" && (
        <section className="card">
          <p className="muted tiny">Sign in to pick up where you left off.</p>
          <a className="btn primary" href={signInPageUrl()} target="_blank" rel="noreferrer">
            Sign in again
          </a>
        </section>
      )}

      {/* A plain anchor, not chrome.tabs.create: opening a tab this way needs
          no `tabs` permission. The page is Clerk-gated, so a signed-out user
          lands on the sign-in prompt — the honest outcome, since the panel
          has no session to hand over. */}
      <a
        className="outlink"
        href={`${API_BASE}/app/saved`}
        target="_blank"
        rel="noreferrer"
      >
        Your saved resumes ↗
      </a>
    </main>
  );
}
