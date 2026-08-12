import { useEffect, useRef, useState } from "react";
import { getResume, type StoredResume } from "@/lib/storage";
import { runTailor, INITIAL_RUN_STATE, type RunState } from "@/lib/run";
import { useActiveJd } from "./useActiveJd";
import { ResumeBlock } from "./ResumeBlock";
import { Results } from "./Results";

export default function App() {
  const [stored, setStored] = useState<StoredResume | null>(null);
  const [state, setState] = useState<RunState>(INITIAL_RUN_STATE);
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
  const { jd, failure, loading } = useActiveJd();

  useEffect(() => {
    void getResume().then(setStored);
  }, []);

  // `jd` is re-read on tab switch/navigation (see useActiveJd), so its `url`
  // is the panel's source of truth for "which posting am I looking at now."
  // Track it in a ref (readable synchronously from the runTailor callback
  // below) and reset any prior run's DISPLAYED results whenever it changes,
  // keyed on `url` specifically — not the `jd` object, which is a fresh
  // reference on every read even when the underlying posting hasn't changed
  // — so this does not fire on every render. This intentionally leaves
  // `busy` alone: switching tabs must clear what's on screen, but must not
  // make the button clickable again while generate() is still running.
  const activeJdUrlRef = useRef<string | undefined>(jd?.url);
  useEffect(() => {
    activeJdUrlRef.current = jd?.url;
    setState(INITIAL_RUN_STATE);
  }, [jd?.url]);

  const canRun = Boolean(jd && stored) && !busy;

  async function generate() {
    if (!jd || !stored || busy) return;
    // Pin which posting this run is for. If the user switches tabs while a
    // run is in flight, activeJdUrlRef.current moves on; a patch that lands
    // after that point is for a posting the user is no longer looking at,
    // so drop it instead of painting stale results over the new page.
    const forUrl = jd.url;
    setState(INITIAL_RUN_STATE);
    setBusy(true);
    try {
      await runTailor(jd, stored.resume, (patch) => {
        if (activeJdUrlRef.current !== forUrl) return;
        setState((prev) => ({ ...prev, ...patch }));
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <header>
        <div className="label">{jd?.company || (loading ? "Reading page…" : "career-path")}</div>
        <h1>{jd?.title || (failure ? "No posting found" : " ")}</h1>
      </header>

      <ResumeBlock stored={stored} onChange={setStored} />

      <button className="primary" onClick={generate} disabled={!canRun}>
        {busy ? "Working…" : "Tailor my resume"}
      </button>
      {state.remaining !== null && (
        <p className="muted tiny center">{state.remaining} free runs left</p>
      )}
      {!stored && <p className="muted tiny center">Add your resume to get started.</p>}
      {failure && <p className="muted tiny center">{failure}</p>}

      <Results state={state} />
    </main>
  );
}
