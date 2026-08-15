import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

describe("@react-pdf/renderer version parity", () => {
  // This module is the single source shared by the web app and the extension
  // specifically so both render a resume through the same layout engine. If
  // the two package.json files ever declare different @react-pdf/renderer
  // ranges, that promise is broken silently: the source stays identical but
  // it is compiled by two different minor versions, and line-breaking and
  // metrics changes between react-pdf minors are exactly the drift this
  // module exists to prevent. Read the raw JSON with node:fs rather than
  // importing the package.json files — resolveJsonModule behaviour across
  // this package boundary (root vs. extension/) is not something to rely on.
  it("declares the same @react-pdf/renderer range in both package.json files", () => {
    const rootPkgPath = fileURLToPath(
      new URL("../../package.json", import.meta.url),
    );
    const extPkgPath = fileURLToPath(
      new URL("../../extension/package.json", import.meta.url),
    );
    const rootPkg: { dependencies?: Record<string, string> } = JSON.parse(
      readFileSync(rootPkgPath, "utf8"),
    );
    const extPkg: { dependencies?: Record<string, string> } = JSON.parse(
      readFileSync(extPkgPath, "utf8"),
    );
    const rootRange = rootPkg.dependencies?.["@react-pdf/renderer"];
    const extRange = extPkg.dependencies?.["@react-pdf/renderer"];
    expect(rootRange).toBeDefined();
    expect(extRange).toBe(rootRange);
  });
});
