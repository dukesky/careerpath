import { describe, it, expect } from "vitest";
import { extractFromDocument, MIN_JD_CHARS } from "@/content/extract";

function docFrom(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

const LONG_JD = `
  We are looking for a Senior Backend Engineer to join our platform team.
  You will design and operate distributed services that process millions of
  events per day, mentor other engineers, and own systems end to end.
  Requirements: 5+ years of backend experience, strong Go or Rust, deep
  knowledge of PostgreSQL, and experience running services in production.
  Nice to have: Kubernetes, Terraform, and an interest in developer tooling.
  We offer competitive compensation, equity, and a remote-first culture.
`.repeat(2);

describe("extractFromDocument", () => {
  it("pulls the main article text out of a normal posting", () => {
    const doc = docFrom(`
      <html><head><title>Senior Backend Engineer at Acme</title></head>
      <body>
        <nav>Home Jobs About</nav>
        <article><h1>Senior Backend Engineer</h1><p>${LONG_JD}</p></article>
        <footer>© Acme</footer>
      </body></html>
    `);
    const r = extractFromDocument(doc, "https://acme.com/jobs/1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.jd.text).toContain("Senior Backend Engineer");
    expect(r.jd.text.length).toBeGreaterThanOrEqual(MIN_JD_CHARS);
    expect(r.jd.url).toBe("https://acme.com/jobs/1");
  });

  it("prefers a JobPosting JSON-LD block when present", () => {
    const doc = docFrom(`
      <html><head>
        <script type="application/ld+json">
          {"@type":"JobPosting","title":"Staff Data Engineer",
           "hiringOrganization":{"name":"Globex"},
           "description":"${LONG_JD.replace(/\s+/g, " ").trim()}"}
        </script>
      </head><body><p>irrelevant page chrome</p></body></html>
    `);
    const r = extractFromDocument(doc, "https://globex.com/careers/9");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.jd.title).toBe("Staff Data Engineer");
    expect(r.jd.company).toBe("Globex");
  });

  it("strips HTML tags out of a JSON-LD description", () => {
    const doc = docFrom(`
      <html><head>
        <script type="application/ld+json">
          {"@type":"JobPosting","title":"X","description":"<p>${LONG_JD.replace(/\s+/g, " ").trim()}</p>"}
        </script>
      </head><body></body></html>
    `);
    const r = extractFromDocument(doc, "https://x.com/j/1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.jd.text).not.toContain("<p>");
  });

  it("fails when the page has almost no text", () => {
    const doc = docFrom(`<html><body><p>Loading…</p></body></html>`);
    const r = extractFromDocument(doc, "https://x.com/j/1");
    expect(r).toEqual({ ok: false, reason: "too-short" });
  });

  it("fails when the extracted text is just under the gate", () => {
    const doc = docFrom(`<html><body><article><p>${"a".repeat(MIN_JD_CHARS - 1)}</p></article></body></html>`);
    expect(extractFromDocument(doc, "https://x.com/j/1").ok).toBe(false);
  });

  it("ignores a malformed JSON-LD block and falls back to the article", () => {
    const doc = docFrom(`
      <html><head><script type="application/ld+json">{ not json </script></head>
      <body><article><p>${LONG_JD}</p></article></body></html>
    `);
    expect(extractFromDocument(doc, "https://x.com/j/1").ok).toBe(true);
  });

  it("finds JobPosting inside an @graph array", () => {
    const doc = docFrom(`
      <html><head>
        <script type="application/ld+json">
          {"@graph":[{"@type":"WebSite"},{"@type":"JobPosting","title":"Graph Role",
           "description":"${LONG_JD.replace(/\s+/g, " ").trim()}"}]}
        </script>
      </head><body></body></html>
    `);
    const r = extractFromDocument(doc, "https://x.com/j/1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.jd.title).toBe("Graph Role");
  });

  // A valid-but-pathological block must not kill extraction. JSON.parse
  // handles this depth fine; the recursive traversal is what blows the stack.
  it("survives a deeply nested JSON-LD block and falls back to the article", () => {
    const deep = "[".repeat(5000) + "]".repeat(5000);
    const doc = docFrom(`
      <html><head><script type="application/ld+json">${deep}</script></head>
      <body><article><p>${LONG_JD}</p></article></body></html>
    `);
    expect(() => extractFromDocument(doc, "https://x.com/j/1")).not.toThrow();
    expect(extractFromDocument(doc, "https://x.com/j/1").ok).toBe(true);
  });
});
