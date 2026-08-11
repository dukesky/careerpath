import { describe, it, expect } from "vitest";
import { readRunId } from "@/lib/api-auth";

describe("readRunId", () => {
  it("accepts a plausible run id", () => {
    expect(readRunId({ runId: "3f1a-9c2b" })).toBe("3f1a-9c2b");
  });

  it("returns empty string when absent", () => {
    expect(readRunId({})).toBe("");
    expect(readRunId(null)).toBe("");
    expect(readRunId(undefined)).toBe("");
    expect(readRunId("not an object")).toBe("");
  });

  it("rejects non-string values", () => {
    expect(readRunId({ runId: 42 })).toBe("");
    expect(readRunId({ runId: { a: 1 } })).toBe("");
  });

  it("trims and caps the length", () => {
    expect(readRunId({ runId: "  abc  " })).toBe("abc");
    expect(readRunId({ runId: "z".repeat(200) })).toBe("z".repeat(64));
  });

  it("strips characters outside the safe key charset", () => {
    expect(readRunId({ runId: "abc:def*ghi" })).toBe("abcdefghi");
  });
});
