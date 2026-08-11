import { describe, it, expect } from "vitest";
import { capText, MAX_JD_CHARS } from "@/lib/limits";

describe("capText", () => {
  it("returns short text unchanged", () => {
    expect(capText("hello", 10)).toBe("hello");
  });

  it("truncates text longer than the cap", () => {
    expect(capText("abcdef", 3)).toBe("abc");
  });

  it("caps JD text at MAX_JD_CHARS", () => {
    const long = "x".repeat(MAX_JD_CHARS + 500);
    expect(capText(long, MAX_JD_CHARS)).toHaveLength(MAX_JD_CHARS);
  });
});
