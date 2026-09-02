import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getResume,
  HAS_SIGNED_IN_KEY,
  SIGNIN_SIGNAL_KEY,
  type StoredResume,
} from "@/lib/storage";
import { INITIAL_RUN_STATE, type RunState } from "@/lib/run";
import { hasBroadHostAccess, requestBroadHostAccess } from "@/lib/permissions";
import { resumeFingerprint } from "@/lib/fingerprint";
import { cacheKey, clearCachedRuns, countCachedRuns, getCachedRun } from "@/lib/cache";
import { clearAllLiveRuns, getAllLiveRuns, isRunning, LIVE_RUNS_KEY } from "@/lib/liveRuns";
// Types only — this must never pull the background's module graph into the
// panel bundle.
import type { StartRunMessage, StartRunResult } from "@/background/runs";
import { API_BASE } from "@/lib/config";
import {
  currentUserEmail,
  installClerkTokenSource,
  isSignedIn,
  signInPageUrl,
} from "@/lib/clerk";
import { fetchQuota, type QuotaInfo } from "@/lib/quota";
import { fetchRunToken } from "@/lib/runToken";
import { useActiveJd } from "./useActiveJd";
import { ResumeBlock } from "./ResumeBlock";
import { Results } from "./Results";
import { AccountBar } from "./AccountBar";
import { BetaCodeBox } from "./BetaCodeBox";

/**
 * Refusals the background can hand back, in the panel's words.
 *
 * `already-running` has no entry on purpose: the panel is about to render
 * that run's own progress, which says everything a message could.
 */
const AT_CAPACITY_NOTICE = "Five postings are already generating. Wait for one to finish.";
const COULD_NOT_START_NOTICE = "Couldn't start that run. Try again.";

export default function App() {
  const [stored, setStored] = useState<StoredResume | null>(null);
  // What is on screen for the posting the user is looking at. Owned by
  // `refreshDisplay` below and by NOTHING else — the panel no longer runs a
  // generation, so there are no patches to fold in here, only reads of what
  // the background has published for THIS posting.
  const [state, setState] = useState<RunState>(INITIAL_RUN_STATE);
  // When the currently-displayed result was generated, ISO 8601. Non-null for
  // both a fresh run and a restored one — a result is a result.
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  // What the DISPLAYED result was generated with. Distinct from the draft
  // below: the draft is what is typed but not yet sent.
  const [appliedSupplement, setAppliedSupplement] = useState("");
  const [supplementDraft, setSupplementDraft] = useState("");
  // Drives the clear control, which stays hidden while there is nothing to
  // clear. Refreshed by `refreshDisplay` and after clearing.
  const [cachedCount, setCachedCount] = useState(0);
  // Whether a start-run message is on the wire and unanswered. NOT "is a run
  // in flight" — that is read from storage (see `busy` below). This covers
  // only the round trip between the click and the background having published
  // the run, during which storage says nothing is happening and the button
  // would otherwise still look clickable. It is also the panel's half of the
  // guard against a double start: the background's own admission check reads
  // storage and then awaits before writing, so two clicks a few milliseconds
  // apart can both pass it and mint two charged runs for one posting.
  const [starting, setStarting] = useState(false);
  // A refusal the user has to be told about, or null. Cleared on the next
  // attempt and on moving to another posting — it describes one click.
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Whether ANY posting has a run in flight — not just the one on screen.
   *
   * A separate question from `busy` below, and the distinction is the whole
   * point. `busy` answers "can this posting be tailored right now", which is
   * per-posting by definition. This answers "is it safe to pull storage out
   * from under a run", which is not: sign-out with the box checked empties
   * cp_resume/cp_results/cp_live_runs, and a run still going for ANOTHER
   * posting will reach putCachedRun afterwards and write the previous
   * session's tailored resume straight back into cp_results. The old
   * panel-global `busy` covered this by accident, because there could only
   * ever be one run and it was the panel's own; five concurrent runs is the
   * whole point of this plan, so it now has to be asked explicitly.
   */
  const [anyRunning, setAnyRunning] = useState(false);
  const { jd, failure, loading, reread } = useActiveJd();
  const [hasBroadAccess, setHasBroadAccess] = useState(true);
  const [granting, setGranting] = useState(false);
  // Identity, for AccountBar. Both are one-shot Clerk reads (see lib/clerk.ts)
  // — there is no push notification when a sign-in completes in the separate
  // tab it opens in, so this starts signed-out and is re-checked below on
  // mount and whenever the panel's document becomes visible again, which is
  // the moment a user returns from that tab.
  const [signedIn, setSignedIn] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  // The allowance as of the last identity change, from GET /api/quota.
  // `state.remaining` (what a completed run reported) takes precedence when
  // present — it is strictly fresher. Null here means UNKNOWN, not zero.
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
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
   *
   * Ordering is guarded by a sequence number because there are now five call
   * sites — mount, sign-out, visibilitychange, the storage listener, and a
   * beta code being applied — and several of them overlap in practice: a
   * sign-out fires this twice, and the storage listener can fire while the
   * visibility refresh is still in flight. Without the guard the SLOWER of
   * two overlapping requests wins the display, which puts the older
   * identity's number on screen after the newer one had already arrived —
   * the same class of lie the clear-before-await above exists to prevent.
   */
  const quotaSeqRef = useRef(0);
  const refreshQuota = useCallback(async () => {
    const seq = ++quotaSeqRef.current;
    setQuota(null);
    const fetched = await fetchQuota();
    // A newer refresh started while this one was in flight. Its answer is for
    // the identity that applies now and this one's is not, so drop this
    // result entirely — leaving `quota` null ("unknown") until the newer call
    // lands, which is exactly the honest intermediate state the clear above
    // establishes.
    if (seq !== quotaSeqRef.current) return;
    setQuota(fetched);
  }, []);

  /**
   * Everything the user typed but has not sent, per posting.
   *
   * The draft is the one piece of displayed state storage cannot supply: a
   * live run does not carry the supplement it was started with, and the
   * cached entry only knows what the LAST finished run used. Without this,
   * typing a paragraph under posting A, starting a run, glancing at B and
   * coming back leaves A's box showing A's previous text — the user's typing
   * silently gone. Keyed on the normalized URL, so the box under a posting
   * can only ever contain that posting's own text; another posting's claimed
   * experience cannot be sitting there when the user hits regenerate.
   *
   * Panel-lifetime memory on purpose: it is a draft, not a result, and
   * nothing here is worth persisting to the user's disk.
   */
  const draftsRef = useRef(new Map<string, string>());
  const displaySeqRef = useRef(0);
  // Which posting the panel is showing RIGHT NOW, readable synchronously.
  // `jd` is re-read on every tab switch and navigation (see useActiveJd), and
  // a caller can be holding a closure over a posting the user has already
  // left — generate() awaits the background before it refreshes.
  const activeJdUrlRef = useRef<string | undefined>(undefined);
  // Postings this panel has READ as having a run in flight. Only
  // `refreshDisplay` writes it; see the quota refresh below for its one job.
  // A set rather than a single value because leaving a posting mid-run and
  // coming back after it finished has to still count as "that run finished".
  const runningPostingsRef = useRef(new Set<string>());

  /**
   * Reads what is true for the posting on screen and renders that. The whole
   * panel/background contract lives in this function.
   *
   * Precedence, in order: a live run for this URL (in flight, or failed and
   * left in place so returning to the posting shows the error rather than a
   * blank panel), else the cached result, else nothing. There is no third
   * source and no patching — a run's progress for ANOTHER posting cannot
   * reach this display at all, because the only thing read here is this
   * URL's own key.
   *
   * `restoreDraft` is false for storage-driven refreshes: those fire while
   * the user is typing (any posting's run publishing progress wakes this
   * listener), and rewriting the textarea underneath them would eat the
   * keystroke. Only a change of posting restores the draft.
   */
  const refreshDisplay = useCallback(
    async (restoreDraft: boolean) => {
      // Normalized, not raw: lib/cache.ts and lib/liveRuns.ts both key on
      // cacheKey(url), so a navigation that only drops `?utm_source=…` has to
      // resolve to the same posting here too, or the panel would look up a
      // run under a key nothing ever wrote.
      const url = jd?.url ? cacheKey(jd.url) : undefined;
      // This call is for a posting the user has already left. generate()
      // awaits the background before refreshing, so its closure can outlive
      // the tab it was clicked on — and painting that posting's run under
      // this one's header is the exact confusion this panel keeps having to
      // be fixed for. Returning BEFORE taking a sequence number matters as
      // much as not painting: taking one would invalidate the read that is
      // for the posting actually on screen, leaving it blank until the next
      // storage event.
      if (url !== activeJdUrlRef.current) return;
      const seq = ++displaySeqRef.current;

      // Every run, in one read: this posting's (for the display) and the rest
      // (for `anyRunning`). `getAllLiveRuns` keys on cacheKey(url) and applies
      // the same stale rule getLiveRun does, so `all[url]` IS getLiveRun(url)
      // — with the other four postings' runs already in hand rather than
      // needing a second pass over the same blob.
      const all = await getAllLiveRuns();
      setAnyRunning(Object.values(all).some((run) => isRunning(run.state)));

      const found = url ? (all[url] ?? null) : null;
      // Provenance, and the same rule getCachedRun applies to its own
      // entries: a record that cannot be shown to belong to the resume loaded
      // NOW is treated as absent — nothing displayed, no count folded in.
      // Without this, replacing a resume mid-run leaves the panel scoring the
      // user against a resume they no longer have, and a failed run makes
      // that permanent rather than momentary.
      const live = found && found.resumeFingerprint === fingerprint ? found : null;

      // Read BEFORE the staleness guard below, and deliberately so. A
      // completed run's `remaining` exists only in the last state the
      // background publishes before it clears the entry — a window a couple of
      // storage round trips wide. The read that catches it is very often the
      // one a newer read is about to supersede, and dropping the number with
      // it would put the figure fetched when the panel opened back on screen,
      // stating an allowance the user has already spent.
      const reported = live?.state.remaining ?? null;
      if (reported !== null) {
        setQuota((q) => (q ? { ...q, remaining: reported } : q));
      }

      // ...and when that window IS missed, ask the server rather than leave a
      // number up that a run has already invalidated.
      const runningNow = live !== null && isRunning(live.state);
      const justFinished =
        url !== undefined && runningPostingsRef.current.has(url) && !runningNow;
      if (url !== undefined) {
        if (runningNow) runningPostingsRef.current.add(url);
        else runningPostingsRef.current.delete(url);
      }
      if (justFinished && reported === null) void refreshQuota();

      const [hit, count] = await Promise.all([
        url && fingerprint ? getCachedRun(url, fingerprint) : null,
        countCachedRuns(),
      ]);
      // chrome.storage reads are async and tab switches are fast, so this can
      // resolve after the user has already moved on — painting it then would
      // show one posting's result underneath another posting's header. A
      // newer refresh has, by definition, read newer truth for the posting
      // that is actually on screen.
      if (seq !== displaySeqRef.current) return;

      setCachedCount(count);
      // From the cache in every case, including mid-run: it is this posting's
      // frozen baseline, and the run in flight does not get to move it. The
      // background reads the same entry when it writes the run's result, so
      // the number on screen and the number stored cannot disagree.
      setBaselineForPosting(hit?.baselineScore ?? null);

      // A failed run does not take the user's last result away with it.
      // Failures are kept (the background clears a run only on success), so
      // without this the error would sit on top of this posting forever and
      // the result already paid for — still on disk, still theirs — would be
      // unreachable until they spent another run. That is the exact loss the
      // cache exists to prevent. A run still IN FLIGHT does replace the
      // result: that is the progress display, and it resolves in a minute.
      const failedOverAResult = live !== null && live.state.phase === "error" ? hit : null;

      if (live && failedOverAResult) {
        setState({
          ...live.state,
          analysis: failedOverAResult.analysis,
          tailored: failedOverAResult.tailored,
        });
        setGeneratedAt(failedOverAResult.generatedAt);
        setAppliedSupplement(failedOverAResult.extraInfo);
      } else if (live) {
        setState(live.state);
        // A run in flight has no finished result: no timestamp, and no
        // applied supplement to disclose — the panel does not know what the
        // background was handed.
        setGeneratedAt(null);
        setAppliedSupplement("");
      } else if (hit) {
        setState({
          phase: "done",
          analysis: hit.analysis,
          tailored: hit.tailored,
          // Not cached: it is a live server-side count, and a stale one must
          // never be presented as the current allowance. Null here means
          // "this read knows nothing about the count" — the display falls
          // back to `quota`, which holds the freshest number the panel has
          // actually been told, including a completed run's own.
          remaining: null,
          error: null,
        });
        setGeneratedAt(hit.generatedAt);
        setAppliedSupplement(hit.extraInfo);
      } else {
        setState(INITIAL_RUN_STATE);
        setGeneratedAt(null);
        setAppliedSupplement("");
      }

      if (restoreDraft) {
        setSupplementDraft(
          (url ? draftsRef.current.get(url) : undefined) ?? hit?.extraInfo ?? "",
        );
      }
    },
    // `fingerprint` is a dependency deliberately, not incidentally: it is the
    // mechanism by which replacing a resume clears a displayed result. The
    // fingerprint changes, the effect below re-runs, and the now-invalid entry
    // fails getCachedRun's provenance rule so nothing is restored.
    [jd?.url, fingerprint, refreshQuota],
  );

  // Every keystroke, so the map above is current the moment the user switches
  // away — there is no later point at which this could be captured.
  const onSupplementChange = useCallback(
    (value: string) => {
      setSupplementDraft(value);
      const url = jd?.url ? cacheKey(jd.url) : undefined;
      if (url) draftsRef.current.set(url, value);
    },
    [jd?.url],
  );

  // installClerkTokenSource() wires lib/clerk.ts's Clerk client into
  // session.ts as the source api.ts consults for every request (see
  // clerk.ts's own doc comment). It MUST run exactly once, and here, at the
  // panel's bootstrap — without it every request carries the device
  // identity and this whole feature is inert, silently: nothing throws,
  // requests just never look signed in.
  useEffect(() => {
    installClerkTokenSource();
    void refreshAccount();
    void refreshQuota();
  }, [refreshAccount, refreshQuota]);

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
      if (document.visibilityState === "visible") {
        void refreshAccount();
        // Identity may have changed while the user was away in the sign-in
        // tab, and a different identity means a different quota bucket —
        // refreshing who they are without refreshing what they are allowed
        // leaves the previous tier's number on screen under the new tier's
        // wording.
        void refreshQuota();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refreshAccount, refreshQuota]);

  // The signal that actually arrives when sign-in completes in its own tab.
  //
  // The visibility effect above is a guess: a side panel stays visible the
  // whole time the user is over in that tab, so `visibilityState` may never
  // change and that listener may never fire. chrome.storage.onChanged
  // broadcasts to every extension context regardless of what is visible, and
  // the sign-in page writes SIGNIN_SIGNAL_KEY as its last act before closing
  // itself. Both listeners stay: this one covers the sign-in path, and the
  // visibility one still covers changes made somewhere this never hears
  // about, such as signing out in Clerk's own account portal.
  //
  // EITHER key counts. SIGNIN_SIGNAL_KEY is the one that always changes (it
  // carries a timestamp — see storage.ts for why a constant would be inert
  // for returning users), but a first-ever sign-in genuinely does change
  // HAS_SIGNED_IN_KEY too, and so does an in-panel sign-out clearing it, so
  // dropping that key from the filter would narrow existing behaviour for no
  // gain.
  useEffect(() => {
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== "local") return;
      // The other half of this listener's job, and the channel the whole
      // plan turns on: the background publishes a run's every step under
      // LIVE_RUNS_KEY, and this is how the panel hears about it. One
      // listener, not two — chrome.storage.onChanged is a single stream and
      // splitting it across effects only doubles the registration.
      if (LIVE_RUNS_KEY in changes) void refreshDisplay(false);
      if (!(HAS_SIGNED_IN_KEY in changes) && !(SIGNIN_SIGNAL_KEY in changes)) return;
      void refreshAccount();
      void refreshQuota();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [refreshAccount, refreshQuota, refreshDisplay]);

  // `hasBroadAccess` starts `true` so the button never flashes on mount
  // before this async check resolves.
  useEffect(() => {
    if (failure?.kind !== "permission") return;
    void hasBroadHostAccess().then(setHasBroadAccess);
  }, [failure?.kind]);

  // `jd` is re-read on tab switch/navigation (see useActiveJd), so its `url`
  // is the panel's source of truth for "which posting am I looking at now."
  // Keyed on `url` specifically — not the `jd` object, which is a fresh
  // reference on every read even when the posting hasn't changed.
  //
  // The wipe is synchronous and the restore is not, deliberately: a tab
  // switch must clear the previous posting's result THIS render, not one
  // storage round trip later, or the panel shows one posting's result under
  // another posting's header for as long as the read takes.
  //
  // Everything this effect used to guard against — a run's patch landing
  // after a tab switch, a cache restore painting over a live run — is gone
  // rather than fixed: `refreshDisplay` reads the state belonging to the URL
  // it is asked about, so there is no cross-posting write left to arrive.
  //
  // `refreshDisplay`'s identity IS (posting, resume), which is what makes it
  // a dependency here. KEEP IT THAT WAY: anything else added to its own deps
  // turns this into a wipe that fires whenever that thing changes, and the
  // first casualty would be the paragraph the user is in the middle of
  // typing. `jd?.url` is listed alongside it because this effect ALSO
  // publishes that url, and a reader should not have to derive that from
  // another hook's dependency list.
  useEffect(() => {
    activeJdUrlRef.current = jd?.url ? cacheKey(jd.url) : undefined;
    setState(INITIAL_RUN_STATE);
    setGeneratedAt(null);
    setAppliedSupplement("");
    setSupplementDraft("");
    setBaselineForPosting(null);
    // A refusal, and an unanswered start, both describe one click on one
    // posting; carrying either across a tab switch would attach it to a
    // posting the user never clicked — a button reading "Working…" under a
    // posting with nothing running.
    setNotice(null);
    setStarting(false);
    void refreshDisplay(true);
  }, [jd?.url, refreshDisplay]);

  // Derived, not tracked. There is no panel-side promise to be "in" any
  // more: a run in flight is a fact about storage, and the button reads it
  // the same way a newly opened panel does. `starting` covers only the gap
  // before the background has published anything.
  const busy = starting || isRunning(state);
  const canRun = Boolean(jd && stored) && !busy && !saving;

  // Below the other effects only because it reads `busy`, which is derived
  // just above.
  //
  // liveRuns.ts's stale rule fires on a READ, and every other read here is
  // event-driven — a storage change, a posting change, a click. An evicted
  // worker produces none of those, so without this the panel that is
  // watching a stranded run is the one place the stale rule can never reach:
  // the button reads "Working…" forever and Sign out stays disabled. Polling
  // only while something is running keeps this off the idle path entirely.
  //
  // `false` is `restoreDraft`: a poll must never rewrite the textarea the
  // user may be typing in, the same reason the storage listener passes false.
  useEffect(() => {
    if (!busy && !anyRunning) return;
    const id = setInterval(() => void refreshDisplay(false), 30_000);
    return () => clearInterval(id);
  }, [busy, anyRunning, refreshDisplay]);

  async function generate(supplement: string) {
    // `saving` as well as `busy`, and checked HERE rather than only on the
    // buttons: `canRun` already disables both regenerate triggers during a
    // save, but that is the callers' guard, not this function's. Defence in
    // depth for a race whose symptom is silent (a save's outcome lost to an
    // unmounted SaveButton — see SaveButton.tsx's doc comment) is worth one
    // line. It is also what makes `starting` a real guard against two rapid
    // clicks starting two charged runs for one posting.
    if (!jd || !stored || busy || saving) return;
    setNotice(null);
    setStarting(true);
    try {
      // Identity is settled HERE, not in the worker. The panel is the only
      // context with a working Clerk session — the worker's realm cannot be
      // given one — so it mints the token the run will travel under and hands
      // it over with the request.
      const runToken = await fetchRunToken();
      if (runToken && !runToken.ok) {
        // Signed in, but no token. Refuse rather than fall back to the device
        // identity: that would quietly bill the run to the 3-per-30-days
        // trial while the header still showed this user their daily
        // allowance. `null` is different and does NOT land here — that is an
        // anonymous caller, who proceeds normally.
        setNotice(runToken.message);
        return;
      }

      // Everything the run needs, in one message. The background mints or
      // reuses the run id, freezes the baseline, and writes the result to the
      // cache — none of that is the panel's business any more, and doing any
      // of it here as well would drift.
      const result = (await chrome.runtime.sendMessage({
        type: "start-run",
        jd,
        resume: stored.resume,
        supplement,
        fingerprint,
        runToken: runToken?.ok ? runToken.token : undefined,
      } satisfies StartRunMessage)) as StartRunResult | undefined;

      if (
        result?.started !== true &&
        result?.reason !== "already-running" &&
        result?.reason !== "session-expired"
      ) {
        // `already-running` and `session-expired` say nothing, on purpose:
        // the refresh below is about to put a published run state on screen,
        // and in both cases that state tells the user more than a notice
        // could — the run's own progress for the first, and an error carrying
        // a "Sign in again" button for the second. Everything else — the cap,
        // a worker that fell over, an undefined answer from a message channel
        // that closed — has to be said out loud, or the click looks ignored.
        setNotice(
          result?.reason === "at-capacity" ? AT_CAPACITY_NOTICE : COULD_NOT_START_NOTICE,
        );
      }
      // The background publishes the run BEFORE it answers, so this read
      // finds it. Without it the panel would sit idle until the storage
      // event arrived, leaving the button clickable for one more round trip.
      await refreshDisplay(false);
    } catch {
      // sendMessage itself rejected — no receiving end, or the extension was
      // reloaded out from under this panel. Same user-visible fact as a
      // worker that fell over.
      setNotice(COULD_NOT_START_NOTICE);
    } finally {
      setStarting(false);
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
    // The live-run store too, and for the same argument this function already
    // makes about drafts: this is the panel's forget-everything control. A
    // FAILED run is never cleared by the background — deliberately, so the
    // error survives leaving the posting — and it carries that run's own
    // analysis and tailored resume, so one left behind here would repaint on
    // the next return to that posting, from a panel that had just said it
    // kept nothing. It is also the only store the extension writes with no
    // cap and no eviction; `cp_results` is capped at MAX_CACHED_RUNS.
    //
    // Safe to call without stopping anything, because the control is disabled
    // while ANY run is in flight — see `busy || anyRunning` in the JSX.
    await clearAllLiveRuns();
    setCachedCount(0);
    setState(INITIAL_RUN_STATE);
    setGeneratedAt(null);
    setAppliedSupplement("");
    setSupplementDraft("");
    // Including the unsent ones. "Clear N cached results" is the panel's
    // forget-everything control; a draft that survived it would come back
    // the next time the user returned to that posting, from a panel that had
    // just said it kept nothing.
    draftsRef.current.clear();
    setBaselineForPosting(null);
    // The same two lines handleLocalDataCleared ends with, for the same
    // reason: these are the panel's own reading OF cp_live_runs, and the
    // display must never outlive the storage it describes.
    setAnyRunning(false);
    runningPostingsRef.current.clear();
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
    draftsRef.current.clear();
    setBaselineForPosting(null);
    // SignOutDialog cleared cp_live_runs too, so the panel's own reading of
    // it has to go with the rest. Immediately, not on the next refresh: this
    // handler exists precisely so the display never outlives the storage it
    // describes. `runningPostingsRef` is bookkeeping ABOUT those records —
    // left behind, it would report a run "finishing" that was deleted rather
    // than completed, and spend a quota request saying so.
    setAnyRunning(false);
    runningPostingsRef.current.clear();
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
    // The identity just changed — the signed-out tier has a different
    // allowance than the account that was signed in a moment ago.
    void refreshQuota();
  }

  // A completed run's count is fresher than the one fetched when the panel
  // opened, so it wins when present.
  const displayRemaining = state.remaining ?? quota?.remaining ?? null;
  const displayUnlimited = quota?.unlimited === true;

  return (
    <main>
      <header>
        <div className="label">{jd?.company || (loading ? "Reading page…" : "career-path")}</div>
        <h1>{jd?.title || (failure ? "No posting found" : " ")}</h1>
      </header>

      {/* `busy || anyRunning`, and this is the only consumer that needs the
          difference. Sign-out with the box checked empties storage, so what
          matters here is whether ANY run could still write to it afterwards —
          including one going for a posting the user is not looking at. The
          Tailor button further down deliberately keeps the narrower `busy`:
          that question really is about the posting on screen. */}
      <AccountBar
        signedIn={signedIn}
        email={email}
        remaining={displayRemaining}
        unlimited={displayUnlimited}
        busy={busy || anyRunning}
        saving={saving}
        onLocalDataCleared={handleLocalDataCleared}
        onSignedOut={handleSignedOut}
      />

      <ResumeBlock stored={stored} onChange={setStored} />

      {/* `busy || anyRunning`, the same distinction AccountBar's own prop doc
          draws and for the same reason: this control removes the WHOLE
          `cp_results` key, so what matters is whether any run could still
          write to it afterwards — including one going for a posting the user
          is not looking at, which would reach putCachedRun and put a result
          back into a store the user had just emptied. */}
      {cachedCount > 0 && (
        <button
          className="textbtn"
          onClick={() => void clearCache()}
          disabled={busy || anyRunning || saving}
        >
          Clear {cachedCount} cached result{cachedCount === 1 ? "" : "s"}
        </button>
      )}

      <button className="primary" onClick={() => void generate(supplementDraft)} disabled={!canRun}>
        {busy ? "Working…" : state.tailored ? "Tailor again" : "Tailor my resume"}
      </button>
      {/* Directly under the button that produced it, because it is the
          answer to that click and nothing else on screen changed. */}
      {notice && <p className="muted tiny center">{notice}</p>}
      {!stored && <p className="muted tiny center">Add your resume to get started.</p>}
      {failure && <p className="muted tiny center">{failure.message}</p>}
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
            We can only ask for one thing here — access to every site.
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
          onChange: onSupplementChange,
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

      <BetaCodeBox unlimited={displayUnlimited} onChanged={() => void refreshQuota()} />

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
    </main>
  );
}
