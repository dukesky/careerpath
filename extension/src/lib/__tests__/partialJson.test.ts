import { describe, it, expect } from "vitest";
import { extractNumber, extractString, extractObjects } from "@/lib/partialJson";

/**
 * A realistic half-streamed analyze buffer: the score has landed, the rationale
 * is still arriving, the matrix has one closed row and one half-written row.
 */
const ANALYZE_PARTIAL = `{
  "overall_match_score": 87,
  "rationale": "Strong backend overlap, thin on the data-platform side",
  "requirements_matrix": [
    { "requirement": "5+ years backend", "status": "met", "evidence": "6 years at Acme" },
    { "requirement": "Kubernetes", "status": "par`;

/** A half-streamed tailor buffer: the key we want is nested two levels deep. */
const TAILOR_PARTIAL = `{
  "resume": {
    "contact": { "name": "Ada Lovelace", "email": "ada@example.com" },
    "summary": "Senior engineer with a decade of distributed systems work",
    "experience": [
      { "company": "Acme", "bullets": ["Cut p99 latency by 40%"] },
      { "company": "Init`;

describe("extractNumber", () => {
  it("reads a number out of a buffer that is still streaming", () => {
    expect(extractNumber(ANALYZE_PARTIAL, "overall_match_score")).toBe(87);
  });

  it("returns null when the key is absent", () => {
    expect(extractNumber(ANALYZE_PARTIAL, "not_a_field")).toBeNull();
    expect(extractNumber("", "overall_match_score")).toBeNull();
  });

  it("returns null while the digits could still be streaming", () => {
    // The classic trap: 87 arrives as "8" then "87". Painting 8 here would
    // show the user a wrong score for a frame.
    expect(extractNumber(`{"overall_match_score": 8`, "overall_match_score")).toBeNull();
    expect(extractNumber(`{"overall_match_score": `, "overall_match_score")).toBeNull();
    expect(extractNumber(`{"overall_match_score":`, "overall_match_score")).toBeNull();
    expect(extractNumber(`{"overall_match_score"`, "overall_match_score")).toBeNull();
  });

  it("returns the value once a terminator proves the number is complete", () => {
    expect(extractNumber(`{"score": 8}`, "score")).toBe(8);
    expect(extractNumber(`{"score": 8,`, "score")).toBe(8);
    expect(extractNumber(`{"score": 8 `, "score")).toBe(8);
    expect(extractNumber(`{"score": 8\n`, "score")).toBe(8);
    expect(extractNumber(`[{"score": 8]`, "score")).toBe(8);
  });

  it("handles zero, negatives, floats and exponents", () => {
    expect(extractNumber(`{"score": 0}`, "score")).toBe(0);
    expect(extractNumber(`{"delta": -12}`, "delta")).toBe(-12);
    expect(extractNumber(`{"ratio": 0.5}`, "ratio")).toBe(0.5);
    expect(extractNumber(`{"big": 1e3}`, "big")).toBe(1000);
    // Mid-fraction and mid-exponent are also incomplete.
    expect(extractNumber(`{"ratio": 0.`, "ratio")).toBeNull();
    expect(extractNumber(`{"big": 1e`, "big")).toBeNull();
    expect(extractNumber(`{"delta": -`, "delta")).toBeNull();
  });

  it("tolerates whitespace around the colon", () => {
    expect(extractNumber(`{"score"  :\n  91 }`, "score")).toBe(91);
  });

  it("returns null when the value is not a number", () => {
    expect(extractNumber(`{"score": "87"}`, "score")).toBeNull();
    expect(extractNumber(`{"score": null}`, "score")).toBeNull();
    expect(extractNumber(`{"score": true}`, "score")).toBeNull();
    expect(extractNumber(`{"score": [87]}`, "score")).toBeNull();
  });

  it("ignores the key when it only appears inside a string value", () => {
    const rationale = 'the model wrote "overall_match_score": 99 in prose';
    const buffer = `{"rationale": ${JSON.stringify(rationale)}, "overall_match_score": 87}`;
    expect(extractNumber(buffer, "overall_match_score")).toBe(87);
  });

  it("ignores a string that merely equals the key but is a value", () => {
    expect(extractNumber(`{"field": "score", "other": 1}`, "score")).toBeNull();
  });

  it("takes the first occurrence", () => {
    expect(extractNumber(`{"score": 10, "score": 20}`, "score")).toBe(10);
  });
});

describe("extractString", () => {
  it("reads a complete string out of a streaming buffer", () => {
    expect(extractString(ANALYZE_PARTIAL, "rationale")).toBe(
      "Strong backend overlap, thin on the data-platform side",
    );
  });

  it("finds a key nested at any depth", () => {
    expect(extractString(TAILOR_PARTIAL, "summary")).toBe(
      "Senior engineer with a decade of distributed systems work",
    );
    expect(extractString(TAILOR_PARTIAL, "name")).toBe("Ada Lovelace");
    // A closed value is readable even though a later value of the same key is
    // still open ("status": "par...).
    expect(extractString(ANALYZE_PARTIAL, "status")).toBe("met");
  });

  it("round-trips escaped quotes and backslashes", () => {
    const bullet = 'Cut costs by "50%" via \\"caching\\"';
    const buffer = `{"bullet": ${JSON.stringify(bullet)}, "next": 1}`;
    expect(extractString(buffer, "bullet")).toBe(bullet);
  });

  it("round-trips a string ending in an escaped backslash", () => {
    const value = "C:\\";
    const buffer = `{"path": ${JSON.stringify(value)}}`;
    expect(extractString(buffer, "path")).toBe(value);
  });

  it("decodes the other JSON escapes", () => {
    expect(extractString(`{"s": "a\\nb\\tc"}`, "s")).toBe("a\nb\tc");
    expect(extractString(`{"s": "caf\\u00e9"}`, "s")).toBe("café");
    expect(extractString(`{"s": "a\\/b"}`, "s")).toBe("a/b");
  });

  it("returns null while the string is still open", () => {
    expect(extractString(`{"rationale": "half writ`, "rationale")).toBeNull();
    expect(extractString(`{"rationale": "ends on an escape\\`, "rationale")).toBeNull();
    expect(extractString(`{"rationale": `, "rationale")).toBeNull();
  });

  it("returns null when the key is absent or the value is not a string", () => {
    expect(extractString(ANALYZE_PARTIAL, "not_a_field")).toBeNull();
    expect(extractString(`{"score": 87}`, "score")).toBeNull();
    expect(extractString(`{"rows": [{"a": 1}]}`, "rows")).toBeNull();
    expect(extractString("", "rationale")).toBeNull();
  });

  it("ignores a string that merely equals the key but is a value", () => {
    expect(extractString(`{"field": "summary", "other": "x"}`, "summary")).toBeNull();
  });

  it("is not fooled by the key appearing inside another string value", () => {
    const noise = 'a decoy "summary": "wrong" inside prose';
    const buffer = `{"rationale": ${JSON.stringify(noise)}, "summary": "right"}`;
    expect(extractString(buffer, "summary")).toBe("right");
  });

  it("returns an empty string for an empty value rather than null", () => {
    expect(extractString(`{"s": ""}`, "s")).toBe("");
  });

  it("takes the first occurrence", () => {
    expect(extractString(`{"s": "one", "s": "two"}`, "s")).toBe("one");
  });
});

describe("extractObjects", () => {
  it("returns only the objects that have closed", () => {
    const rows = extractObjects(ANALYZE_PARTIAL, "requirements_matrix");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      requirement: "5+ years backend",
      status: "met",
      evidence: "6 years at Acme",
    });
  });

  it("finds an array key nested at any depth", () => {
    const jobs = extractObjects(TAILOR_PARTIAL, "experience");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual({ company: "Acme", bullets: ["Cut p99 latency by 40%"] });
  });

  it("returns every object once the array is complete", () => {
    const buffer = `{"rows": [{"a": 1}, {"b": 2}, {"c": 3}]}`;
    expect(extractObjects(buffer, "rows")).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("balances nested objects and arrays", () => {
    const buffer = `{"rows": [{"a": {"b": [{"c": 1}]}, "d": [1, 2]}, {"e": 2`;
    expect(extractObjects(buffer, "rows")).toEqual([{ a: { b: [{ c: 1 }] }, d: [1, 2] }]);
  });

  it("does not count braces or brackets that live inside strings", () => {
    const note = "} { ] [ \" not a brace";
    const buffer = `{"rows": [{"note": ${JSON.stringify(note)}}, {"note": "second"}]}`;
    expect(extractObjects(buffer, "rows")).toEqual([{ note }, { note: "second" }]);
  });

  it("does not lose track across escaped quotes inside an element", () => {
    const bullet = 'said \\"done\\" and }{';
    const buffer = `{"rows": [{"b": ${JSON.stringify(bullet)}}, {"b": "x"}]}`;
    expect(extractObjects(buffer, "rows")).toEqual([{ b: bullet }, { b: "x" }]);
  });

  it("returns [] until the array opens, and for a missing or non-array key", () => {
    expect(extractObjects(`{"rows": `, "rows")).toEqual([]);
    expect(extractObjects(`{"rows":`, "rows")).toEqual([]);
    expect(extractObjects(`{"rows": [`, "rows")).toEqual([]);
    expect(extractObjects(`{"rows": [{"a": 1`, "rows")).toEqual([]);
    expect(extractObjects(`{"rows": {"a": 1}}`, "rows")).toEqual([]);
    expect(extractObjects(`{"other": [{"a": 1}]}`, "rows")).toEqual([]);
    expect(extractObjects("", "rows")).toEqual([]);
  });

  it("skips elements that are not objects", () => {
    expect(extractObjects(`{"rows": [1, "two", null, {"a": 1}]}`, "rows")).toEqual([{ a: 1 }]);
  });

  it("skips an element that does not parse instead of throwing", () => {
    // Brace-balanced but not valid JSON: the trailing comma kills it.
    expect(extractObjects(`{"rows": [{"a": 1,}, {"b": 2}]}`, "rows")).toEqual([{ b: 2 }]);
  });

  it("stops at the end of its own array", () => {
    const buffer = `{"experience": [{"a": 1}], "education": [{"b": 2}]}`;
    expect(extractObjects(buffer, "experience")).toEqual([{ a: 1 }]);
  });

  it("takes the first occurrence of the key", () => {
    expect(extractObjects(`{"rows": [{"a": 1}], "rows": [{"b": 2}]}`, "rows")).toEqual([{ a: 1 }]);
  });
});

describe("hostile and degenerate input", () => {
  const HOSTILE = [
    "",
    "{",
    "}",
    "[",
    '"',
    '\\"',
    "{{{{{{",
    "]]]]]",
    `{"a": "unterminated`,
    `{"a": "trailing escape \\`,
    `{"a"`,
    `{"a":`,
    `{"a"::}`,
    `{"a": ,}`,
    "\u0000\u001f\ud800",
    `{"a": [{"b": [{"c": [`,
    "null",
    "not json at all",
  ];

  it("never throws on malformed buffers", () => {
    for (const buffer of HOSTILE) {
      for (const key of ["a", "", "score", '"', "\\", "a.b*c"]) {
        expect(() => extractNumber(buffer, key)).not.toThrow();
        expect(() => extractString(buffer, key)).not.toThrow();
        expect(() => extractObjects(buffer, key)).not.toThrow();
      }
    }
  });

  it("never throws on a huge unterminated buffer", () => {
    const huge = `{"rows": [` + "{".repeat(200_000);
    expect(extractObjects(huge, "rows")).toEqual([]);
    expect(extractNumber(huge, "rows")).toBeNull();
    expect(extractString(huge, "rows")).toBeNull();
  });

  it("never throws on a huge unterminated string", () => {
    const huge = `{"rationale": "` + "x".repeat(200_000);
    expect(extractString(huge, "rationale")).toBeNull();
    expect(extractNumber(huge, "score")).toBeNull();
    expect(extractObjects(huge, "rows")).toEqual([]);
  });

  it("handles a key containing characters that would be regex-special", () => {
    expect(extractNumber(`{"a.b*c": 5}`, "a.b*c")).toBe(5);
    expect(extractString(`{"a[0]": "v"}`, "a[0]")).toBe("v");
  });

  it("handles a key that itself contains an escape", () => {
    const key = 'we"ird';
    const buffer = `{${JSON.stringify(key)}: 7}`;
    expect(extractNumber(buffer, key)).toBe(7);
  });
});
