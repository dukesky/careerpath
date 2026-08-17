export interface SupplementProps {
  text: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
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
      <button onClick={onSubmit} disabled={busy || text.trim().length === 0}>
        {busy ? "Regenerating…" : "Add experience and regenerate"}
      </button>
    </>
  );
}
