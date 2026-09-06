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
const RANK: Record<ReqStatus, number> = {
  met: 2,
  partially_met: 1,
  missing: 0,
};

/**
 * The words every requirement carries. Ported verbatim from the bench
 * flip-detector (evaluator/bench/lib/score-parse-jd.ts), including
 * "experience"/"years"/"year" — the three that show up in most requirement
 * lines and, left in, let "Experience with distributed systems for 5 years"
 * pair with "Experience with payroll compliance for 5 years" at 0.67.
 */
const STOP = new Set([
  "a", "an", "and", "or", "the", "of", "to", "in", "with", "for", "on", "at",
  "is", "are", "be", "you", "your", "we", "our", "have", "has", "that", "this",
  "as", "by", "from", "it", "its", "not", "than", "into", "over", "across",
  "including", "experience", "years", "year",
]);

/**
 * The two matrices are written by two independent model calls, so a
 * requirement almost never comes back as the same string. Pairing is by word
 * overlap instead — the bench flip-detector's tokenizer, character class and
 * stop list included, so this gate and the bench measure the same thing.
 *
 * Two details are load-bearing:
 *   - `+ # . /` survive the punctuation strip, so "c++", "c#" and "node.js"
 *     stay whole and stay DIFFERENT from each other. Stripping them collapses
 *     "C++" to a one-character token the length filter then drops, leaving an
 *     empty set that matches nothing.
 *   - the class is Unicode-aware (\p{L}\p{N}), because an ASCII-only one
 *     erases a Chinese or Japanese requirement to the empty set — and an empty
 *     set matches nothing, so every row of a non-Latin JD would read as a
 *     vanished requirement and the floor would block every rewrite.
 */
function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}+#./ -]/gu, " ")
      .split(/[\s/,-]+/)
      .map((w) => w.replace(/\.$/, ""))
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

/**
 * |A ∩ B| / min(|A|,|B|) — the bench matcher's `jaccardish`, same denominator.
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
 * Pairs left-analysis rows with rescore rows by token overlap (>=0.5 of the
 * smaller token set — the tokenizer, stop list and threshold are the bench
 * matcher's, ported from evaluator/bench/lib/score-parse-jd.ts; the greedy
 * one-partner-each assignment below is this file's own, because the bench
 * scores a list against a gold list and this scores a matrix against its own
 * later self) and returns every row whose status got WORSE (met ->
 * partially_met/missing, or
 * partially_met -> missing). A left row with no match is treated as a
 * downgrade to "missing" — conservative by design. The one exception is a row
 * the tokenizer cannot represent at all (empty or all-punctuation): it is
 * dropped, because "" is not a requirement a reader can be shown as lost.
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
 *
 * EVERY left row is paired, including the "missing" ones that can never
 * produce a downgrade — only the REPORT is skipped for those. Skipping them
 * before pairing looks like a free optimisation and is not: it leaves their
 * rightful partner unclaimed for a later row to take. A requirement that went
 * missing -> met while a longer must-have vanished would hand the vanished row
 * the upgrade's partner, read met -> met, and hide the exact regression this
 * function exists to find.
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

    const leftTokens = tokens(requirement);

    // Nothing to pair on and nothing to name. Reporting it would put an empty
    // bullet in the panel's list of what the rewrite lost, which tells the
    // reader nothing and blocks the rewrite anyway.
    if (leftTokens.size === 0) continue;

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

    const matched = bestIndex >= 0 && bestScore >= MIN_OVERLAP;
    if (matched) claimed[bestIndex] = true;

    // A left row that is already "missing" cannot go anywhere worse — but it
    // has claimed its partner above, which is the point.
    if (from === "missing") continue;

    if (matched) {
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
