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
