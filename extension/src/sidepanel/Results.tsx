import type { RunState } from "@/lib/run";
import type { ReqStatus } from "@shared/contract";
import { relativeTime } from "@/lib/relativeTime";
import { DownloadPdf } from "./DownloadPdf";
import { SupplementBox, type SupplementProps } from "./SupplementBox";
import { supplementPlaceholder } from "./gapHint";

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

/**
 * Order is the point of this component: score, then the artifact, then the
 * explanation. The user's job is decide → download → apply; the requirement
 * matrix and change log answer "why", which is a question they ask second if
 * at all, so nothing explanatory sits between the score and the download.
 */
export function Results({
  state,
  company,
  generatedAt,
  appliedSupplement,
  supplement,
}: {
  state: RunState;
  company: string;
  generatedAt: string | null;
  /** What the DISPLAYED result was generated with, not what is typed below. */
  appliedSupplement: string;
  supplement: SupplementProps;
}) {
  const progress = PHASE_COPY[state.phase];
  const { analysis, tailored } = state;

  return (
    <div>
      {state.phase === "error" && state.error && (
        <p className="error">{state.error.message}</p>
      )}

      {progress && !analysis && <p className="muted">{progress}</p>}

      {analysis && (
        <section className="card">
          <div className="score">
            {analysis.overall_match_score}
            {tailored && <span className="after"> → {tailored.projected_match_score}</span>}
            <span className="muted tiny"> match</span>
          </div>
          {analysis.rationale && <p className="muted">{analysis.rationale}</p>}

          {/* The download cannot appear any earlier than this. It downloads the
              REWRITTEN resume, which only exists once the tailor leg returns —
              the slower of the two parallel calls. Until then the score card
              renders alone. That gap is expected; it is not a missing loading
              state, and moving this block will not make it shorter. */}
          {tailored && (
            <>
              <DownloadPdf resume={tailored.resume} company={company} />
              {generatedAt && (
                <p className="muted tiny center">generated {relativeTime(generatedAt)}</p>
              )}
              {appliedSupplement.trim().length > 0 && (
                <p className="muted tiny center">
                  Includes experience you added that isn&rsquo;t on your resume.
                </p>
              )}
            </>
          )}
        </section>
      )}

      {progress && analysis && !tailored && <p className="muted">{progress}</p>}

      {analysis && (
        <section className="card">
          <div className="label">Details</div>

          {tailored && (
            <>
              <div className="label">What changed</div>
              <ul className="reqs">
                {tailored.change_log.map((c, i) => (
                  <li key={i}>
                    <strong>{c.section}</strong>
                    <div className="muted tiny">{c.reason}</div>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="label">Requirements</div>
          <ul className="reqs">
            {analysis.requirements_matrix.map((row, i) => (
              <li key={i}>
                <span>{STATUS_MARK[row.status]}</span> <strong>{row.requirement}</strong>
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

          {/* Was "Copy tailored resume". It copies raw JSON, which the old
              label did not admit and which the PDF button above now actually
              delivers. Kept as a developer affordance, demoted out of the
              primary path. */}
          {tailored && (
            <button
              onClick={() =>
                void navigator.clipboard.writeText(JSON.stringify(tailored.resume, null, 2))
              }
            >
              Copy as JSON
            </button>
          )}
        </section>
      )}

      {/* Outside the Details card on purpose. That card is gated on
          `analysis`, which generate() nulls at the start of every run — so a
          box inside it unmounts for the whole regeneration and stays gone
          after a failure, hiding the paragraph the user just typed and hiding
          the "Regenerating…" label on the button that triggered it. Rendering
          while the draft is non-empty keeps the text visible and editable
          through a failed run. */}
      {(analysis || supplement.text.trim().length > 0) && (
        <section className="card">
          <SupplementBox {...supplement} placeholder={supplementPlaceholder(analysis)} />
        </section>
      )}
    </div>
  );
}
