import type { RunState } from "@/lib/run";
import type { ReqStatus } from "@shared/contract";
import { relativeTime } from "@/lib/relativeTime";
import { DownloadPdf } from "./DownloadPdf";
import { SaveButton } from "./SaveButton";
import { SupplementBox, type SupplementProps } from "./SupplementBox";
import { QuestionCards } from "./QuestionCards";
import { WaitingTips } from "./WaitingTips";
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
  roleTitle,
  jdSummary,
  jdUrl,
  signedIn,
  saving,
  onSavingChange,
  generatedAt,
  baselineScore,
  appliedSupplement,
  supplement,
  onImprove,
  canRun,
}: {
  state: RunState;
  company: string;
  /** The posting's title, for Save's `roleTitle` field. */
  roleTitle: string;
  /** The extracted JD's raw text, for Save's `jdSummary` field — see SaveButton's doc comment for why this stands in for the structured summary the extension never computes. */
  jdSummary: string;
  /** The posting's URL, for Save's `jdUrl` field. Undefined when there is no active posting. */
  jdUrl: string | undefined;
  /** Gates the Save control: it must be ABSENT, not present-and-failing, for a signed-out user. */
  signedIn: boolean;
  /**
   * App.tsx's `saving`, the VALUE (`onSavingChange` below is the setter).
   * It widens the Save gate rather than narrowing it — see the `signedIn ||
   * saving` condition below for why a save in flight has to outlive
   * `signedIn` going false.
   */
  saving: boolean;
  /** Threaded straight through to SaveButton — see its doc comment for why App.tsx needs this. */
  onSavingChange: (saving: boolean) => void;
  generatedAt: string | null;
  /** This posting's frozen baseline, or null before it has been measured. */
  baselineScore: number | null;
  /** What the DISPLAYED result was generated with, not what is typed below. */
  appliedSupplement: string;
  supplement: SupplementProps;
  /** Starts a refine from the question cards' answers — App composes them onto the applied supplement. */
  onImprove: (answersText: string) => void;
  /** App's own run gate; the question cards' button follows it. */
  canRun: boolean;
}) {
  const progress = PHASE_COPY[state.phase];
  const {
    analysis,
    tailored,
    rescoredScore,
    scoreNote,
    downgradedRequirements,
    streamingScore,
    streamingRows,
    streamingResume,
  } = state;

  /**
   * THE rule for everything the streamed preview touches: a real result always
   * wins.
   *
   * Not a preference — a correctness requirement. The `writing` patch that
   * delivers the analysis does NOT clear the streaming fields (only terminal
   * patches do), so during the whole tailor leg this component holds a
   * finished analysis and a half-arrived matrix at the same time. Reading the
   * streamed value first would paint the approximation over the real thing for
   * 20-30 seconds, and the pinned `.score` strings in App.test.tsx would move.
   *
   * So every pair below is written the same way: `analysis ? real : streamed`.
   * Resist the urge to compress them into `streamed ?? real`.
   */
  const shownScore = analysis ? (baselineScore ?? analysis.overall_match_score) : streamingScore;
  const shownRows = analysis ? analysis.requirements_matrix : streamingRows;
  /** True while the rows on screen are a stream's prefix rather than a matrix. */
  const rowsStreaming = !analysis && streamingRows.length > 0;

  /**
   * Whether the run is between its start and its first real content.
   *
   * This is the only window the tips card is allowed to occupy. "Substantive"
   * deliberately includes the STREAMED fields: once a score or a single
   * requirement row is on screen the user has something of their own to read,
   * and career advice underneath it becomes noise competing with their result.
   */
  const working =
    state.phase === "reading" || state.phase === "comparing" || state.phase === "writing";
  const hasContent =
    analysis !== null ||
    streamingScore !== null ||
    streamingRows.length > 0 ||
    streamingResume !== null;

  /**
   * How many must-haves this role has, and whether every one is already met.
   *
   * When they all are, the right-hand number genuinely has nowhere left to go:
   * no truthful rewrite can add evidence the resume already carries, and the
   * bench runs confirmed such candidates sit at a real ceiling. An unmoving
   * number with no explanation reads as a broken feature, so the card says
   * which state it is in rather than leaving the user to guess.
   */
  const mustHaves = analysis?.requirements_matrix.filter((r) => r.kind === "must_have") ?? [];
  const atCeiling = mustHaves.length > 0 && mustHaves.every((r) => r.status === "met");

  /**
   * The repair leg's window: a free rewrite is in flight and NO number has
   * been decided yet.
   *
   * run.ts withholds the dipped measurement on this path deliberately (see the
   * repair block there) — publishing it would make the number visibly fall and
   * jump back. So this is the one refining state with an empty right-hand
   * slot, and it is a different sentence from the auto-refine tail's: that leg
   * runs with a measured number already on screen and is trying to improve it,
   * this one is the wait for the number itself.
   *
   * `scoreNote === null` is redundant today — run.ts never sets a note without
   * a score — but it is the field that actually means "nothing decided", and
   * stating both keeps this reading true if a note ever arrives first.
   */
  const repairWaiting = state.refining && rescoredScore === null && scoreNote === null;

  /**
   * The rows a note names, split into "the one to say" and "how many more".
   *
   * Naming the first is what stops a held number from being a lie by
   * omission; counting the rest is what stops a list of names from burying it.
   * Must-haves lead the array (run.ts orders it), so the named row is always
   * the one the reader has to act on.
   */
  const [namedRow, ...otherRows] = downgradedRequirements;
  const andMore = otherRows.length > 0 ? ` and ${otherRows.length} more` : "";

  return (
    <div>
      {state.phase === "error" && state.error && (
        <p className="error">{state.error.message}</p>
      )}

      {progress && !analysis && <p className="muted">{progress}</p>}

      {/* Under the phase line, not instead of it: the phase line says what the
          product is doing, the tips say something useful while it does it.
          Both are gone by the time there is anything of the user's own to
          read.

          The repair wait earns them for the same reason the first paint does,
          not as a second exception: the slot the user is watching is empty on
          purpose, and the wait is a whole model round-trip. `hasContent` is
          deliberately not consulted there — a finished rewrite IS on screen by
          then, and gating on it would retire the tips in the one state that
          most needs something to read. */}
      <WaitingTips active={(working && !hasContent) || repairWaiting} />

      {(analysis || streamingScore !== null) && (
        <section className="card">
          {/* Raw integers, both sides. `roundToFive` used to sit on both of
              these numbers because they came from two uncalibrated rulers —
              analyze's score on the left, the tailor model's self-assessment
              on the right — and a three-point difference between two such
              numbers means nothing. The right-hand number is now the tailored
              resume measured by analyze itself, at temperature 0, so the noise
              source the rounding existed to hide is gone; what rounding does
              instead is eat the real, small improvements this instrument
              produces (an honest 87 → 88 both render as 85 → 90, which is
              wrong twice over). If the right-hand number ever goes back to
              being a different model's guess, bring the rounding back with
              it. */}
          <div className="score">
            {/* The fallback matters only during the FIRST run: analyze lands
                before tailor, so there is briefly no stored baseline, and the
                value shown here is the one that is about to BECOME it — so
                nothing jumps when the run completes and the real baseline is
                set. */}
            {/* When there is no analysis yet this is the streamed number, and
                the `tailored &&` arrow below cannot be reached — so a
                streaming-only card renders exactly "62 match". That absence of
                an arrow is the honest reading: nothing has been rewritten yet,
                so there is no second number to point at. */}
            {shownScore}
            {tailored &&
              (repairWaiting ? (
                // The one place this card animates. The repair leg is holding
                // a number back on purpose, so the slot cannot show the
                // projection (it would be replaced by a different number
                // moments later — the flicker the hold exists to prevent) and
                // cannot show nothing (the card would read as one that lost
                // its second number). A placeholder that is visibly waiting is
                // the only honest third option.
                <span className="after-neutral">
                  {" "}
                  → <span className="pending-dots">…</span>
                </span>
              ) : (
                // `rescoredScore ?? projected` — the rescore arrives 20-30s
                // after this card first paints, so the projection holds the
                // slot until then and is simply replaced in place. No spinner
                // and no transition: a number quietly becoming more accurate is
                // not an event worth animating, and flagging it would invite
                // the user to distrust the first value.
                //
                // The colour is the note's, not the number's. A held number
                // ("maintained", "nice_dip") was never measured higher — run.ts
                // pinned it to the left score — so green would claim an
                // improvement nothing observed. Green stays for the two cases
                // that earned it: a real measured number (note null) and the
                // honest drop ("downgraded"), which is not an improvement but
                // IS the measurement, and dressing it in grey would hide that
                // it moved at all.
                <span
                  className={
                    scoreNote === "maintained" || scoreNote === "nice_dip"
                      ? "after-neutral"
                      : "after"
                  }
                >
                  {" "}
                  → {rescoredScore ?? tailored.projected_match_score}
                </span>
              ))}
            <span className="muted tiny"> match</span>
          </div>
          {/* Outside the `.score` div on purpose: that element's text is the
              two numbers and nothing else, and the background auto-refine leg
              is a fact ABOUT the right-hand number, not part of it. */}
          {state.refining && (
            <p className="muted tiny">
              {repairWaiting
                ? // No count in the copy, deliberately: this hint also covers
                  // the auto-refine tail's own unmeasured case, where there is
                  // no downgraded row to count, and a sentence that promises a
                  // number it sometimes cannot produce is worse than a general
                  // one. The time estimate is the part the waiting user
                  // actually wants.
                  "Taking a second pass at your resume — this usually takes under a minute."
                : "Improving the rewrite against the gaps…"}
            </p>
          )}
          {/* The note under the number, and the reason the number is allowed to
              be what it is. Gated on a decided note, so the untouched path
              (note null) renders exactly what it always did.

              Suppressed while the repair leg is in flight: the hint above owns
              that state, and a note from the FIRST measurement standing under a
              placeholder would describe a number that is no longer on screen. */}
          {scoreNote === "maintained" && !state.refining && (
            <p className="muted tiny">
              {/* A JS string rather than JSX text, like the two notes below it:
                  the three sentences are one voice and are pinned verbatim by
                  the tests, and JSX text would silently collapse the line break
                  this one needs to fit the column. */}
              {"Re-measured within the ruler's precision — every requirement holds; presentation improved."}
            </p>
          )}
          {scoreNote === "nice_dip" && !state.refining && namedRow && (
            <p className="muted tiny">
              {`One nice-to-have reads softer on the second pass: "${namedRow}"${andMore} — core requirements all hold.`}
            </p>
          )}
          {/* The only note that asks for something. A lower number with no way
              forward is a dead end, and the cards below ARE the way forward —
              they are the one path the bench found that actually moves the
              measured score, so the sentence points straight at them. */}
          {scoreNote === "downgraded" && !state.refining && namedRow && (
            <p className="muted tiny">
              {`The rewrite reads weaker on: "${namedRow}"${andMore}. Try the question cards below — real detail there raises it back.`}
            </p>
          )}
          {/* Mutually exclusive with the hint above by the `!state.refining`
              gate: while the refine leg is still running the number may yet
              move, so claiming a ceiling then would be a guess. Gated on
              `tailored` too — there is no right-hand number to explain until
              the rewrite exists. */}
          {state.phase === "done" && tailored && !state.refining && atCeiling && (
            <p className="muted tiny">
              All {mustHaves.length} must-have requirement
              {mustHaves.length === 1 ? " is" : "s are"} already met — the score
              is near its honest ceiling for this role.
            </p>
          )}
          {/* Says out loud that the number above is a stream's, not a
              measurement's. Without it the card is indistinguishable from a
              finished one that lost its download button, and a number that
              later moves with no warning reads as the panel changing its
              mind. Outside `.score` for the same reason as the hints above. */}
          {!analysis && <p className="muted tiny">Still comparing — this number may still move.</p>}
          {analysis?.rationale && <p className="muted">{analysis.rationale}</p>}

          {/* The download cannot appear any earlier than this. It downloads the
              REWRITTEN resume, which only exists once the tailor leg returns —
              the slower of the two parallel calls. Until then the score card
              renders alone. That gap is expected; it is not a missing loading
              state, and moving this block will not make it shorter. */}
          {tailored && (
            <>
              <DownloadPdf resume={tailored.resume} company={company} />
              {(signedIn || saving) && (
                // `|| saving` keeps an in-flight save's own SaveButton
                // mounted through `signedIn` flipping to false underneath
                // it — which App.tsx's visibilitychange re-check can do at
                // any moment, on discovering the session ended in another
                // tab. Without it, that flip unmounts the component the
                // pending apiPost is about to update, and the user watches
                // the button they were waiting on simply vanish with no
                // word on whether their save landed. Once the request
                // settles, `saving` goes false and a genuinely signed-out
                // state unmounts it on the next render, as it should.
                //
                // Keyed on `generatedAt` so a fresh run (a new displayed
                // result) remounts this with a clean idle status — without
                // it, regenerating after a successful save would leave
                // "Saved ✓" showing for a version that was never actually
                // saved.
                <SaveButton
                  key={generatedAt ?? undefined}
                  resume={tailored.resume}
                  company={company}
                  roleTitle={roleTitle}
                  jdSummary={jdSummary}
                  jdUrl={jdUrl}
                  onSavingChange={onSavingChange}
                />
              )}
              {generatedAt && (
                <p className="muted tiny center">generated {relativeTime(generatedAt)}</p>
              )}
              {/* The supplement feeds the ANALYSIS leg as well as the rewrite, so
                  the match score above is no longer derived from the parsed
                  resume alone — it is derived from the resume plus whatever the
                  user typed in the box below. That is a material fact about the
                  number on screen, so the panel says so.

                  The downloaded PDF (DownloadPdf, above) deliberately carries no
                  equivalent mark. This is not an oversight to fix by threading
                  `appliedSupplement` into shared/resume-pdf.tsx — the PDF is the
                  user's own document, going to an employer of their choosing, and
                  stamping a disclosure onto what they send oversteps. The
                  disclosure belongs here, in the panel that computed the score,
                  not on the artifact the user controls. */}
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

      {/* The rewrite, as far as it has been written. Sits where the finished
          document's controls sit, because it IS the artifact — just not yet a
          usable one.

          Read-only and deliberately impoverished: no DownloadPdf, no
          SaveButton, no Copy-as-JSON. Those all take `tailored.resume`, and
          this object is not that — it is a prefix pulled out of a half-arrived
          JSON buffer with an empty contact block, no skills and no education,
          which would produce a PDF and a saved record that silently dropped
          most of the user's resume. It is rendered inline rather than through
          ResumeBreakdown for the same reason: that component prints "Not
          detected" under every section it does not find, which is a claim
          about the PARSE, and every one of them would be a lie here.

          `!tailored &&` is the yielding rule again — the done patch clears
          `streamingResume` anyway, but a restored cache entry need not have,
          and a draft under a finished download is worse than no draft. */}
      {!tailored && streamingResume && (
        <section className="card">
          <div className="label">Drafting your tailored resume…</div>
          {streamingResume.summary && <p className="muted">{streamingResume.summary}</p>}
          {streamingResume.experience.map((e, i) => (
            <div key={i} className="bd-entry">
              <div className="bd-title">
                {[e.title, e.company].filter((s) => s.trim() !== "").join(" · ")}
              </div>
              {e.bullets.length > 0 && (
                <ul className="bd-bullets">
                  {e.bullets.map((b, j) => (
                    <li key={j}>{b}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          <p className="muted tiny">
            A preview of what&rsquo;s being written. The finished version, with
            everything else on your resume, downloads when it lands.
          </p>
        </section>
      )}

      {(analysis || shownRows.length > 0) && (
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

          {/* Same markup for both sources, on purpose: a streamed row and a
              final row differ in how complete the LIST is, not in what a row
              means — runStream.ts mirrors the server's own status coercion so
              a row cannot change mark when the final frame replaces it. The
              suffix below is the only difference the user sees. */}
          <div className="label">Requirements</div>
          <ul className="reqs">
            {shownRows.map((row, i) => (
              <li key={i}>
                <span>{STATUS_MARK[row.status]}</span> <strong>{row.requirement}</strong>
                {row.evidence && <div className="muted tiny">{row.evidence}</div>}
              </li>
            ))}
          </ul>
          {/* A short list of met requirements looks like a verdict. This says
              it is a prefix, so the user does not conclude the role has three
              requirements and close the panel. */}
          {rowsStreaming && <p className="muted tiny">still assessing…</p>}

          {analysis && analysis.gaps.length > 0 && (
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

      {/* Gated on `tailored` as well as `analysis`: answering these starts a
          REFINE of an existing rewrite, so there has to be a rewrite to
          refine. Between the two legs the matrix is on screen without the
          cards, which is correct — the run is not finished yet. */}
      {analysis && tailored && (
        <QuestionCards analysis={analysis} disabled={!canRun} onImprove={onImprove} />
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
