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

  // ------------------------------------------------------- the stop list

  it("does not pair two requirements that share only filler words", () => {
    // "experience", "with", "for", "years" are the words EVERY requirement
    // carries. Without a stop list they alone clear 0.5, and the pair below
    // reads as met -> met: a vanished requirement reported as fine. That is
    // the failure mode this gate exists to catch, so it must not be the one
    // the tokenizer produces.
    const out = compareMatrices(
      [left("Experience with distributed systems for 5 years", "met")],
      [right("Experience with payroll compliance for 5 years", "met")],
    );

    expect(out).toEqual([
      {
        requirement: "Experience with distributed systems for 5 years",
        kind: "must_have",
        from: "met",
        to: "missing",
      },
    ]);
  });

  it("does not let 'and' / 'in' carry a pair over the threshold", () => {
    const out = compareMatrices(
      [left("Kubernetes and Terraform in production", "met")],
      [right("Payroll and invoicing in production", "met")],
    );

    expect(out).toHaveLength(1);
    expect(out[0].to).toBe("missing");
  });

  // ------------------------------------------------- punctuated skill names

  it("keeps + and # so c++ and c# are different tokens", () => {
    // Stripping punctuation collapses both to a one-character token that the
    // length filter then drops, leaving an EMPTY token set: "C++" would match
    // nothing at all, and every C++ row would read as a false loss.
    expect(compareMatrices([left("C++", "met")], [right("C++ expertise", "met")])).toEqual([]);

    const crossed = compareMatrices([left("C++", "met")], [right("C#", "met")]);
    expect(crossed).toEqual([
      { requirement: "C++", kind: "must_have", from: "met", to: "missing" },
    ]);
  });

  it("keeps the dot in node.js", () => {
    expect(
      compareMatrices([left("Node.js", "met")], [right("Deep Node.js background", "met")]),
    ).toEqual([]);
  });

  // ------------------------------------------------------ non-Latin scripts

  it("tokenizes CJK requirements instead of reducing them to nothing", () => {
    // An ASCII-only character class erases these rows to the empty set, and an
    // empty set matches nothing — so every requirement in a Chinese-language
    // JD would report as a downgrade to missing and the floor would block
    // every rewrite.
    expect(
      compareMatrices([left("5年 Go 语言开发经验", "met")], [right("Go 语言开发经验", "met")]),
    ).toEqual([]);

    const unrelated = compareMatrices(
      [left("5年 Go 语言开发经验", "met")],
      [right("財務会計の実務経験", "met")],
    );
    expect(unrelated).toHaveLength(1);
    expect(unrelated[0].to).toBe("missing");
  });

  // --------------------------------------------------- where 0.5 actually is

  it("pairs at 0.6 overlap and refuses to pair at 0.4", () => {
    // Pins MIN_OVERLAP from both sides. Every other test here scores 1.0 or 0,
    // so the constant could drift anywhere in (0, 1] unnoticed.
    const paired = compareMatrices(
      [left("Kubernetes Terraform Postgres Kafka Redis", "met")],
      [right("Kubernetes Terraform Postgres Jenkins Splunk", "met")],
    );
    expect(paired).toEqual([]); // 3/5 = 0.6

    const unpaired = compareMatrices(
      [left("Kubernetes Terraform Postgres Kafka Redis", "met")],
      [right("Kubernetes Terraform Jenkins Splunk Datadog", "met")],
    );
    expect(unpaired).toHaveLength(1); // 2/5 = 0.4
    expect(unpaired[0].to).toBe("missing");
  });

  // ------------------------------------------------- rows with nothing to say

  it("drops a requirement with no tokens rather than reporting a nameless loss", () => {
    // requirement:"" renders as an empty bullet in the panel's "what this
    // rewrite lost" list. A row the tokenizer cannot represent is a row this
    // function has no opinion about, not a loss.
    expect(compareMatrices([left("", "met")], [right("Go experience", "met")])).toEqual([]);
    expect(compareMatrices([left("— ( ) —", "met")], [right("Go experience", "met")])).toEqual([]);
    expect(compareMatrices([left("a", "met")], [])).toEqual([]);
  });

  // --------------------------------------- every left row claims its partner

  it("does not let an upgraded row absorb the partner a vanished row needed", () => {
    // The worked example. "Kubernetes cluster operations" went missing -> met
    // (an upgrade, correctly unreported) and the longer must-have vanished. If
    // the missing row is skipped BEFORE pairing, the vanished row claims the
    // upgrade's partner, reads met -> met, and the real loss is invisible.
    const out = compareMatrices(
      [
        left("Kubernetes cluster operations", "missing"),
        left("Kubernetes cluster operations at scale", "met"),
      ],
      [right("Kubernetes cluster operations", "met")],
    );

    expect(out).toEqual([
      {
        requirement: "Kubernetes cluster operations at scale",
        kind: "must_have",
        from: "met",
        to: "missing",
      },
    ]);
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

  it("survives malformed rows that reach the pairing path", () => {
    // The junk above all coerces to "missing", which never reports — so it
    // exercises none of the matching. These rows carry status:"met" on BOTH
    // sides, so they pair, compare, and report for real.
    const junk = [
      null,
      undefined,
      { status: "met" },
      { requirement: 42, kind: "nonsense", status: "met" },
      { requirement: "Kubernetes in production", kind: "nonsense", status: "met" },
      { requirement: "Distributed tracing rollout", status: "met" },
    ] as unknown as RequirementRow[];

    let out: ReturnType<typeof compareMatrices> = [];
    expect(() => {
      out = compareMatrices(junk, junk as unknown as RescoreRow[]);
    }).not.toThrow();
    // Both nameable rows find their identical twin; nothing got worse.
    expect(out).toEqual([]);

    // And a malformed left row still reports when its partner really is gone.
    const lost = compareMatrices(junk, [
      { requirement: "Kubernetes in production", kind: "must_have", status: "missing" },
    ] as unknown as RescoreRow[]);
    expect(lost).toEqual([
      {
        requirement: "Kubernetes in production",
        kind: "must_have",
        from: "met",
        to: "missing",
      },
      {
        requirement: "Distributed tracing rollout",
        kind: "must_have",
        from: "met",
        to: "missing",
      },
    ]);
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
