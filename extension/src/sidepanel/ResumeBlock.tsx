import { useRef, useState } from "react";
import { apiPostForm } from "@/lib/api";
import { setResume, type StoredResume } from "@/lib/storage";
import type { ParsedResume } from "@shared/contract";
import { ResumeBreakdown } from "./ResumeBreakdown";

export function ResumeBlock({
  stored,
  onChange,
}: {
  stored: StoredResume | null;
  onChange: (r: StoredResume) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState("");

  // One place that turns a parsed resume into what we store. Both entry
  // paths — file upload and pasted text — go through it, so a change to how
  // the record is derived cannot apply to only one of them.
  async function storeParsed(resume: ParsedResume) {
    const record: StoredResume = {
      resume,
      parsedAt: new Date().toISOString(),
      name: resume.contact.name || "Your resume",
    };
    await setResume(record);
    onChange(record);
  }

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append("file", file);
    const res = await apiPostForm<{ resume: ParsedResume }>("/api/parse-resume", form);
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    await storeParsed(res.data.resume);
  }

  async function submitText() {
    if (text.trim().length < 30) {
      setError("That looks too short to be a resume.");
      return;
    }
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append("text", text);
    const res = await apiPostForm<{ resume: ParsedResume }>("/api/parse-resume", form);
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    await storeParsed(res.data.resume);
    setPasting(false);
    setText("");
  }

  return (
    <section className="card">
      <div className="row">
        <div>
          <div className="label">My resume</div>
          <div className="muted">
            {stored
              ? `${stored.name} · added ${new Date(stored.parsedAt).toLocaleDateString()}`
              : "No resume yet"}
          </div>
        </div>
        <button onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? "Reading…" : stored ? "Replace" : "Add resume"}
        </button>
        {stored && (
          <button onClick={() => setOpen((v) => !v)} aria-expanded={open} disabled={busy}>
            {open ? "Hide" : "Review"}
          </button>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.docx"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = "";
        }}
      />
      {error && <p className="error">{error}</p>}
      {open && stored && (
        <>
          <ResumeBreakdown resume={stored.resume} />
          {!pasting ? (
            <button onClick={() => setPasting(true)}>
              Parsed wrong? Paste your resume text instead
            </button>
          ) : (
            <>
              <textarea
                className="paste"
                rows={8}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Paste the full text of your resume here."
              />
              <div className="row">
                <button onClick={() => setPasting(false)}>Cancel</button>
                <button onClick={() => void submitText()} disabled={busy}>
                  {busy ? "Reading…" : "Use this text"}
                </button>
              </div>
            </>
          )}
        </>
      )}
      <p className="muted tiny">
        Stored in this browser only — never uploaded for storage.
      </p>
    </section>
  );
}
