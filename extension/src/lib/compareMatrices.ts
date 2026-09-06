import type { RequirementRow, ReqKind, ReqStatus } from "@shared/contract";

/**
 * One row of /api/rescore's trimmed matrix. Same three fields the route
 * returns — evidence and suggestion never make the trip.
 */
export interface RescoreRow {
  requirement: string;
  kind: ReqKind;
  status: ReqStatus;
}

export interface Downgrade {
  requirement: string;
  kind: ReqKind;
  from: ReqStatus;
  to: ReqStatus;
}

/**
 * How much worse a status can get. Comparing these numbers is the whole
 * definition of "downgrade": met(2) > partially_met(1) > missing(0), and a
 * pair is a loss when the new rank is strictly lower than the old one.
 */
const RANK: Record<string, number> = {
  met: 2,
  partially_met: 1,
  missing: 0,
};

/**
 * The two matrices are written by two independent model calls, so a
 * requirement almost never comes back as the same string. Pairing is by word
 * overlap instead: lowercase, drop punctuation, drop words shorter than three
 * characters (the "and"/"of"/"in" that every requirement shares and that no
 * pair should be built on).
 */
function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((w) => w.length >= 3),
  );
}

/**
 * |A ∩ B| / min(|A|,|B|) — the bench flip-detector's measure.
 *
 * The min denominator (rather than the union) is deliberate: a rescore row
 * that says "Kubernetes" and a left row that says "Production experience with
 * Kubernetes clusters" are the same requirement stated at two lengths, and
 * Jaccard would score that pair 0.2 and call the requirement vanished. Every
 * such false "vanished" becomes a false downgrade, which blocks a rewrite that
 * was fine.
 */
function overlap(a: Set<string>, b: Set<string>): number {
  const smaller = a.size <= b.size ? a : b;
  const larger = smaller === a ? b : a;
  if (smaller.size === 0) return 0;
  let shared = 0;
  for (const w of smaller) if (larger.has(w)) shared += 1;
  return shared / smaller.size;
}

const MIN_OVERLAP = 0.5;

/** Anything that is not one of the three known statuses is read as missing. */
function statusOf(value: unknown): ReqStatus {
  return value === "met" || value === "partially_met" || value === "missing" ? value : "missing";
}

function kindOf(value: unknown): ReqKind {
  return value === "nice_to_have" ? "nice_to_have" : "must_have";
}

function requirementOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Pairs left-analysis rows with rescore rows by token overlap (>=0.5 on
 * lowercased word sets — the bench flip-detector's algorithm) and returns
 * every row whose status got WORSE (met -> partially_met/missing, or
 * partially_met -> missing). A left row with no match is treated as a
 * downgrade to "missing" — conservative by design.
 *
 * Pure; never throws. It sits between two model calls and a score floor that
 * gates shipping a rewrite, so every input here is model output: a thrown
 * TypeError on a malformed row would fail the gate open, waving through the
 * regression it exists to catch. Unrecognized statuses read as "missing" for
 * the same reason — the cautious end of the scale.
 *
 * Greedy, first-come pairing: each left row takes the best still-unclaimed
 * rescore row, ties going to the earlier one. Matrices run to about 20 rows,
 * so an optimal assignment would buy nothing a reader could see.
 */
export function compareMatrices(left: RequirementRow[], rescored: RescoreRow[]): Downgrade[] {
  const leftRows = Array.isArray(left) ? left : [];
  const rightRows = Array.isArray(rescored) ? rescored : [];

  const rightTokens = rightRows.map((r) => tokens(requirementOf(r?.requirement)));
  const claimed = new Array<boolean>(rightRows.length).fill(false);
  const out: Downgrade[] = [];

  for (const row of leftRows) {
    const requirement = requirementOf(row?.requirement);
    const from = statusOf(row?.status);
    const kind = kindOf(row?.kind);

    // A left row that is already "missing" cannot go anywhere worse, so it can
    // never produce a downgrade — including the unmatched case below, where a
    // missing row that finds no partner is still just missing.
    if (RANK[from] === 0) continue;

    const leftTokens = tokens(requirement);
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < rightRows.length; i += 1) {
      if (claimed[i]) continue;
      const score = overlap(leftTokens, rightTokens[i]);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0 && bestScore >= MIN_OVERLAP) {
      claimed[bestIndex] = true;
      const to = statusOf(rightRows[bestIndex]?.status);
      if (RANK[to] < RANK[from]) out.push({ requirement, kind, from, to });
      continue;
    }

    // No partner. The requirement the resume used to meet is unaccounted for
    // in the rescore, and this function's job is to be conservative about
    // that: report it lost rather than assume the model just stopped
    // mentioning it.
    out.push({ requirement, kind, from, to: "missing" });
  }

  return out;
}
