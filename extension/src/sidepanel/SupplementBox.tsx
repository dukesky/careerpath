export interface SupplementProps {
  text: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  /**
   * Whether a run can actually be started right now (a posting is detected
   * AND a resume is stored). A cache restore can paint an analysis — and this
   * box along with it — with no resume in storage, e.g. after the user clears
   * it. Without this, the button stays enabled and the click is a silent
   * no-op against generate()'s own `!jd || !stored` guard.
   */
  canRun: boolean;
}

/**
 * Where a user answers a gap the analysis found.
 *
 * Free text on purpose. A per-gap "I have this" button would be one click to
 * assert an experience, and "we never fabricate" is the one claim this
 * product can make that its competitors cannot — making the user write what
 * they actually did is the guard, not a friction bug to file down later.
 */
export function SupplementBox({
  text,
  onChange,
  onSubmit,
  busy,
  canRun,
  placeholder,
}: SupplementProps & { placeholder: string }) {
  return (
    <>
      <div className="label">Something missing?</div>
      <textarea
        className="paste"
        rows={4}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={busy}
      />
      <button onClick={onSubmit} disabled={busy || !canRun || text.trim().length === 0}>
        {busy ? "Regenerating…" : "Add experience and regenerate"}
      </button>
    </>
  );
}
