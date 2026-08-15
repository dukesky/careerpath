import { useState } from "react";
import type { ParsedResume } from "@shared/contract";

/**
 * The one call site for the PDF library.
 *
 * The import is dynamic and must stay that way: @react-pdf/renderer is large,
 * and a top-level import would load it every time the panel opens — for every
 * user, including the ones who never click download. Here it loads on the
 * first click and the browser caches it for later ones.
 *
 * The layout itself lives in shared/resume-pdf.tsx and is the SAME module the
 * web app renders from, so a resume downloaded here and one downloaded from
 * the site are byte-for-byte the same document.
 */
export function DownloadPdf({
  resume,
  company,
}: {
  resume: ParsedResume;
  company: string;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function download() {
    setBusy(true);
    setFailed(false);
    try {
      const { generateResumePdf, resumePdfFilename } = await import(
        "@shared/resume-pdf"
      );
      const blob = await generateResumePdf(resume);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = resumePdfFilename(resume.contact.name, company);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("PDF generation failed", err);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="primary" onClick={() => void download()} disabled={busy}>
        {busy ? "Building PDF…" : "Download PDF resume"}
      </button>
      {failed && <p className="error">Couldn&rsquo;t build the PDF. Try again.</p>}
    </>
  );
}
