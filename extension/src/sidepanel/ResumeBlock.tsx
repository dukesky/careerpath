import { useRef, useState } from "react";
import { apiPostForm } from "@/lib/api";
import { setResume, type StoredResume } from "@/lib/storage";
import type { ParsedResume } from "@shared/contract";

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
    const record: StoredResume = {
      resume: res.data.resume,
      parsedAt: new Date().toISOString(),
      name: res.data.resume.contact.name || "Your resume",
    };
    await setResume(record);
    onChange(record);
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
      <p className="muted tiny">
        Stored in this browser only — never uploaded for storage.
      </p>
    </section>
  );
}
