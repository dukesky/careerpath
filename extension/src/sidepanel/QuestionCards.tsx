import { useState } from "react";
import type { GapAnalysis } from "@shared/contract";

/** More than this and the panel scrolls forever; the top gaps matter most. */
const MAX_CARDS = 5;

/**
 * The elicitation half of the uplift pipeline: each missing / partially_met
 * matrix row becomes a question card. Answers are REAL facts the user supplies
 * — they feed the existing supplement -> free-refine path, they are never
 * invented — and the composed text goes through generate() so all the refine
 * plumbing (runId reuse, disclosure line, cache) applies unchanged.
 */
export function QuestionCards({
  analysis,
  disabled,
  onImprove,
}: {
  analysis: GapAnalysis;
  disabled: boolean;
  onImprove: (answersText: string) => void;
}) {
  const rows = analysis.requirements_matrix
    .filter((r) => r.status !== "met" && r.requirement.trim())
    .slice(0, MAX_CARDS);
  const [answers, setAnswers] = useState<Record<number, string>>({});

  if (rows.length === 0) return null;

  const answered = rows
    .map((r, i) => ({ r, text: (answers[i] ?? "").trim() }))
    .filter((x) => x.text.length > 0);

  return (
    <section className="card">
      <div className="label">Raise your score with real experience</div>
      <p className="muted tiny">
        These requirements scored low. If you actually have the experience, say
        what you did — it gets woven in and the match is re-measured. Leave
        blank anything you don&rsquo;t have; nothing is ever invented.
      </p>
      <ul className="reqs">
        {rows.map((r, i) => (
          <li key={i}>
            <strong>{r.requirement}</strong>
            {r.suggestion && <div className="muted tiny">{r.suggestion}</div>}
            <textarea
              rows={2}
              value={answers[i] ?? ""}
              placeholder="What did you actually do? Tools, scale, numbers."
              onChange={(e) => setAnswers({ ...answers, [i]: e.target.value })}
              disabled={disabled}
            />
          </li>
        ))}
      </ul>
      <button
        className="primary"
        disabled={disabled || answered.length === 0}
        onClick={() => onImprove(answered.map((x) => `${x.r.requirement}: ${x.text}`).join("\n"))}
      >
        Improve my score
      </button>
    </section>
  );
}
