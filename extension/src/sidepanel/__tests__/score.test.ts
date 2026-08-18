import { describe, it, expect } from "vitest";
import { roundToFive } from "../score";

describe("roundToFive", () => {
  it("leaves multiples of five alone", () => {
    expect(roundToFive(70)).toBe(70);
    expect(roundToFive(0)).toBe(0);
    expect(roundToFive(100)).toBe(100);
  });

  it("rounds to the nearer multiple", () => {
    expect(roundToFive(72)).toBe(70);
    expect(roundToFive(73)).toBe(75);
    expect(roundToFive(78)).toBe(80);
  });

  it("rounds a midpoint up", () => {
    expect(roundToFive(72.5)).toBe(75);
  });

  it("does not push a score past 100", () => {
    expect(roundToFive(99)).toBe(100);
    expect(roundToFive(100)).toBe(100);
  });

  // The whole point of rounding is to stop a meaningless wobble reading as a
  // real change. 71 and 72 sit inside one bucket — a one-point difference
  // between two runs must not show up on screen at all.
  it("collapses a wobble inside one bucket", () => {
    expect(roundToFive(71)).toBe(70);
    expect(roundToFive(72)).toBe(70);
  });
});
