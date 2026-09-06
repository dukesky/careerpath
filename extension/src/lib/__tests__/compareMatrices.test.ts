import { describe, it, expect } from "vitest";
import type { RequirementRow } from "@shared/contract";
import { compareMatrices, type RescoreRow } from "../compareMatrices";

/** A left-hand (analyze) row. evidence/suggestion are never read here. */
function left(
  requirement: string,
  status: RequirementRow["status"],
  kind: RequirementRow["kind"] = "must_have",
): RequirementRow {
  return { requirement, kind, status, evidence: "", suggestion: "" };
}

function right(
  requirement: string,
  status: RescoreRow["status"],
  kind: RescoreRow["kind"] = "must_have",
): RescoreRow {
  return { requirement, kind, status };
}

describe("compareMatrices", () => {
  it("reports a downgrade when the same requirement text loses ground", () => {
    const out = compareMatrices(
      [left("5 years of Go", "met")],
      [right("5 years of Go", "partially_met")],
    );

    expect(out).toEqual([
      { requirement: "5 years of Go", kind: "must_have", from: "met", to: "partially_met" },
    ]);
  });

  it("pairs rows the model reworded, rather than calling the pair a loss", () => {
    // Word sets overlap well past 0.5 — "experience" / "kubernetes" /
    // "production" carry the match; the model's rewording must not read as a
    // vanished requirement.
    const out = compareMatrices(
      [left("Production experience with Kubernetes clusters", "met")],
      [right("Kubernetes experience in production", "missing")],
    );

    expect(out).toEqual([
      {
        requirement: "Production experience with Kubernetes clusters",
        kind: "must_have",
        from: "met",
        to: "missing",
      },
    ]);
  });

  it("keeps the original requirement text and kind in the report", () => {
    const out = compareMatrices(
      [left("Kubernetes experience", "partially_met", "nice_to_have")],
      [right("experience with Kubernetes", "missing", "must_have")],
    );

    expect(out).toEqual([
      {
        requirement: "Kubernetes experience",
        kind: "nice_to_have",
        from: "partially_met",
        to: "missing",
      },
    ]);
  });

  it("does not report an upgrade", () => {
    expect(
      compareMatrices([left("Terraform", "missing")], [right("Terraform", "met")]),
    ).toEqual([]);
    expect(
      compareMatrices([left("Terraform", "partially_met")], [right("Terraform", "met")]),
    ).toEqual([]);
  });

  it("does not report an unchanged status", () => {
    expect(compareMatrices([left("Terraform", "met")], [right("Terraform", "met")])).toEqual([]);
  });

  it("treats an unmatched met row as a downgrade to missing", () => {
    // Conservative by design: if the rescore cannot account for a requirement
    // the resume used to meet, assume the rewrite lost it.
    const out = compareMatrices(
      [left("Distributed tracing", "met")],
      [right("Completely unrelated payroll compliance", "met")],
    );

    expect(out).toEqual([
      {
        requirement: "Distributed tracing",
        kind: "must_have",
        from: "met",
        to: "missing",
      },
    ]);
  });

  it("treats an unmatched partially_met row as a downgrade to missing", () => {
    const out = compareMatrices(
      [left("Distributed tracing", "partially_met")],
      [right("Completely unrelated payroll compliance", "met")],
    );

    expect(out).toEqual([
      {
        requirement: "Distributed tracing",
        kind: "must_have",
        from: "partially_met",
        to: "missing",
      },
    ]);
  });

  it("does not report an unmatched missing row — missing to missing is not a loss", () => {
    expect(
      compareMatrices([left("Distributed tracing", "missing")], [right("Payroll", "met")]),
    ).toEqual([]);
    expect(compareMatrices([left("Distributed tracing", "missing")], [])).toEqual([]);
  });

  it("returns [] for empty inputs on either side", () => {
    expect(compareMatrices([], [])).toEqual([]);
    expect(compareMatrices([], [right("Go", "met")])).toEqual([]);
  });

  it("pairs each rescore row at most once", () => {
    // Two left rows both match the single rescore row. The first claims it;
    // the second is left unpaired and reported, rather than both reading off
    // the same row and one loss going unseen.
    const out = compareMatrices(
      [left("Go microservices experience", "met"), left("Go experience", "met")],
      [right("Go experience", "met")],
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      requirement: "Go experience",
      kind: "must_have",
      from: "met",
      to: "missing",
    });
  });

  it("survives malformed rows without throwing", () => {
    const junk = [
      null,
      undefined,
      {},
      { requirement: 42, kind: "nonsense", status: "made_up" },
      { requirement: "Go" },
    ] as unknown as RequirementRow[];

    expect(() => compareMatrices(junk, junk as unknown as RescoreRow[])).not.toThrow();
    expect(() => compareMatrices(null as never, undefined as never)).not.toThrow();
    expect(compareMatrices(null as never, undefined as never)).toEqual([]);
  });

  it("handles a 500-row matrix without throwing", () => {
    const big: RequirementRow[] = Array.from({ length: 500 }, (_, i) =>
      left(`Requirement number ${i} about systems`, "met"),
    );
    const rescored: RescoreRow[] = big.map((r) => right(r.requirement, "missing"));

    let out: ReturnType<typeof compareMatrices> = [];
    expect(() => {
      out = compareMatrices(big, rescored);
    }).not.toThrow();
    expect(out).toHaveLength(500);
  });
});
