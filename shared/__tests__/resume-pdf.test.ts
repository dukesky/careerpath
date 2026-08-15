import { describe, it, expect } from "vitest";
import { resumePdfFilename, generateResumePdf } from "@shared/resume-pdf";

describe("resumePdfFilename", () => {
  it("joins a slugged name, company and Resume", () => {
    expect(resumePdfFilename("Jane Doe", "Adobe")).toBe("Jane_Doe_Adobe_Resume.pdf");
  });

  it("collapses punctuation into single underscores", () => {
    expect(resumePdfFilename("Jean-Luc  O'Brien", "Acme, Inc.")).toBe(
      "Jean_Luc_O_Brien_Acme_Inc_Resume.pdf",
    );
  });

  it("drops empty parts instead of leaving a dangling separator", () => {
    expect(resumePdfFilename("", "Adobe")).toBe("Adobe_Resume.pdf");
    expect(resumePdfFilename("Jane Doe", "")).toBe("Jane_Doe_Resume.pdf");
  });
});

describe("module surface", () => {
  it("still exports the PDF generator from the shared path", () => {
    expect(typeof generateResumePdf).toBe("function");
  });
});
