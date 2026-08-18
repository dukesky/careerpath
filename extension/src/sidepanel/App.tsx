import { useEffect, useRef, useState } from "react";
import { getResume, type StoredResume } from "@/lib/storage";
import { runTailor, newRunId, INITIAL_RUN_STATE, type RunState } from "@/lib/run";
import { hasBroadHostAccess, requestBroadHostAccess } from "@/lib/permissions";
import {
  cacheKey,
  clearCachedRuns,
  countCachedRuns,
  getCachedRun,
  putCachedRun,
} from "@/lib/cache";
import { API_BASE } from "@/lib/config";
import { useActiveJd } from "./useActiveJd";
import { ResumeBlock } from "./ResumeBlock";
import { Results } from "./Results";

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

  useEffect(() => {
    void getResume().then(setStored);
    void countCachedRuns().then(setCachedCount);
  }, []);

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
    if (!url) return;
    void getCachedRun(url, "").then((hit) => { // Task 3 passes the real fingerprint
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
    });
  }, [jd?.url]);

  const canRun = Boolean(jd && stored) && !busy;

  async function generate(supplement: string) {
    if (!jd || !stored || busy) return;
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
        await putCachedRun(forUrl, {
          analysis: latest.analysis,
          tailored: latest.tailored,
          generatedAt: finishedAt,
          extraInfo: supplement,
          runId,
          baselineScore: latest.analysis.overall_match_score,
          resumeFingerprint: "", // Task 3 passes the real fingerprint
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
  // like it did nothing. Disabled while a run is in flight (see the JSX) so
  // it cannot yank a run's output out from under it mid-flight.
  async function clearCache() {
    await clearCachedRuns();
    setCachedCount(0);
    setState(INITIAL_RUN_STATE);
    setGeneratedAt(null);
    setAppliedSupplement("");
    setSupplementDraft("");
    setRunIdForPosting("");
  }

  return (
    <main>
      <header>
        <div className="label">{jd?.company || (loading ? "Reading page…" : "career-path")}</div>
        <h1>{jd?.title || (failure ? "No posting found" : " ")}</h1>
      </header>

      <ResumeBlock stored={stored} onChange={setStored} />

      {cachedCount > 0 && (
        <button className="textbtn" onClick={() => void clearCache()} disabled={busy}>
          Clear {cachedCount} cached result{cachedCount === 1 ? "" : "s"}
        </button>
      )}

      <button className="primary" onClick={() => void generate(supplementDraft)} disabled={!canRun}>
        {busy ? "Working…" : state.tailored ? "Tailor again" : "Tailor my resume"}
      </button>
      {state.remaining !== null && (
        <p className="muted tiny center">{state.remaining} free runs left</p>
      )}
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
        generatedAt={generatedAt}
        appliedSupplement={appliedSupplement}
        supplement={{
          text: supplementDraft,
          onChange: setSupplementDraft,
          onSubmit: () => void generate(supplementDraft),
          busy,
          canRun,
        }}
      />

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
