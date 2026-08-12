import type { ParsedResume } from "@shared/contract";
import { toBreakdown } from "./breakdown";

export function ResumeBreakdown({ resume }: { resume: ParsedResume }) {
  return (
    <div className="breakdown">
      {toBreakdown(resume).map((section) => (
        <div key={section.label}>
          <div className="label">{section.label}</div>
          {section.entries.length === 0 ? (
            <p className="muted tiny">Not detected</p>
          ) : (
            section.entries.map((e, i) => (
              <div key={i} className="bd-entry">
                {e.title && <div className="bd-title">{e.title}</div>}
                {e.detail && <div className="muted tiny">{e.detail}</div>}
                {e.bullets.length > 0 && (
                  <ul className="bd-bullets">
                    {e.bullets.map((b, j) => (
                      <li key={j}>{b}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))
          )}
        </div>
      ))}
    </div>
  );
}
