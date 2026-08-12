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
        <h1>{jd?.title || (failure ? "No posting found" : " ")}</h1>
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
