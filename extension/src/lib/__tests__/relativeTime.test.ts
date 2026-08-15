import { describe, it, expect } from "vitest";
import { relativeTime } from "@/lib/relativeTime";

const NOW = Date.parse("2026-08-14T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  it("reads 'just now' under a minute", () => {
    expect(relativeTime(ago(0), NOW)).toBe("just now");
    expect(relativeTime(ago(59 * SEC), NOW)).toBe("just now");
  });

  it("reads 'just now' for a future timestamp rather than a negative count", () => {
    // Clock skew between the run and this render is normal; "-3 minutes ago"
    // is not something a user should ever see.
    expect(relativeTime(ago(-5 * MIN), NOW)).toBe("just now");
  });

  it("singularizes one minute and one hour and one day", () => {
    expect(relativeTime(ago(MIN), NOW)).toBe("1 minute ago");
    expect(relativeTime(ago(HOUR), NOW)).toBe("1 hour ago");
    expect(relativeTime(ago(DAY), NOW)).toBe("1 day ago");
  });

  it("pluralizes beyond one", () => {
    expect(relativeTime(ago(2 * MIN), NOW)).toBe("2 minutes ago");
    expect(relativeTime(ago(59 * MIN), NOW)).toBe("59 minutes ago");
    expect(relativeTime(ago(3 * HOUR), NOW)).toBe("3 hours ago");
    expect(relativeTime(ago(23 * HOUR), NOW)).toBe("23 hours ago");
    expect(relativeTime(ago(9 * DAY), NOW)).toBe("9 days ago");
  });

  it("falls back to 'recently' for an unparseable timestamp", () => {
    expect(relativeTime("banana", NOW)).toBe("recently");
  });
});
