"use client";

import { useMemo } from "react";
import { diffLines, diffWords } from "diff";

type RowKind = "same" | "add" | "del" | "change";
interface Row {
  left: string | null;
  right: string | null;
  kind: RowKind;
}

function splitLines(value: string): string[] {
  return value.replace(/\n$/, "").split("\n");
}

function buildRows(original: string, revised: string): Row[] {
  const parts = diffLines(original, revised);
  const rows: Row[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p.added && !p.removed) {
      for (const l of splitLines(p.value))
        rows.push({ left: l, right: l, kind: "same" });
    } else if (p.removed && parts[i + 1]?.added) {
      const L = splitLines(p.value);
      const R = splitLines(parts[i + 1].value);
      const n = Math.max(L.length, R.length);
      for (let k = 0; k < n; k++) {
        const left = k < L.length ? L[k] : null;
        const right = k < R.length ? R[k] : null;
        if (left !== null && right !== null)
          rows.push({ left, right, kind: "change" });
        else if (left !== null) rows.push({ left, right: null, kind: "del" });
        else rows.push({ left: null, right, kind: "add" });
      }
      i++; // consumed the paired "added" part
    } else if (p.removed) {
      for (const l of splitLines(p.value))
        rows.push({ left: l, right: null, kind: "del" });
    } else {
      for (const l of splitLines(p.value))
        rows.push({ left: null, right: l, kind: "add" });
    }
  }
  return rows;
}

/** Word-level highlight for a changed line pair. */
function WordDiff({
  left,
  right,
  side,
}: {
  left: string;
  right: string;
  side: "left" | "right";
}) {
  const parts = diffWords(left, right);
  return (
    <>
      {parts.map((part, i) => {
        if (side === "left") {
          if (part.added) return null;
          return part.removed ? (
            <mark key={i} className="rounded bg-rose-200/70 text-rose-900">
              {part.value}
            </mark>
          ) : (
            <span key={i}>{part.value}</span>
          );
        }
        if (part.removed) return null;
        return part.added ? (
          <mark key={i} className="rounded bg-emerald-200/70 text-emerald-900">
            {part.value}
          </mark>
        ) : (
          <span key={i}>{part.value}</span>
        );
      })}
    </>
  );
}

function Cell({ row, side }: { row: Row; side: "left" | "right" }) {
  const value = side === "left" ? row.left : row.right;
  const isEmpty = value === null;
  const tone =
    side === "left"
      ? row.kind === "del" || row.kind === "change"
        ? "bg-rose-50"
        : ""
      : row.kind === "add" || row.kind === "change"
        ? "bg-emerald-50"
        : "";

  return (
    <div
      className={`whitespace-pre-wrap break-words px-3 py-0.5 ${tone} ${
        isEmpty ? "bg-slate-50/50" : ""
      }`}
    >
      {isEmpty ? (
        " "
      ) : row.kind === "change" && row.left !== null && row.right !== null ? (
        <WordDiff left={row.left} right={row.right} side={side} />
      ) : (
        value || " "
      )}
    </div>
  );
}

export function ResumeDiff({
  original,
  revised,
}: {
  original: string;
  revised: string;
}) {
  const rows = useMemo(() => buildRows(original, revised), [original, revised]);
  const changed = rows.some((r) => r.kind !== "same");

  return (
    <div>
      <div className="mb-3 flex items-center gap-4 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-rose-200" /> Original
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-emerald-200" /> Tailored
        </span>
      </div>

      {!changed && (
        <p className="mb-3 text-sm text-slate-400">
          No textual differences — the tailored resume matches the original.
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <div className="grid min-w-[640px] grid-cols-2 font-mono text-xs leading-relaxed text-slate-800">
          <div className="sticky top-0 border-b border-r border-slate-200 bg-slate-100 px-3 py-1.5 font-sans text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Original
          </div>
          <div className="sticky top-0 border-b border-slate-200 bg-slate-100 px-3 py-1.5 font-sans text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Tailored
          </div>
          {rows.map((row, i) => (
            <div key={i} className="contents">
              <div className="border-r border-slate-100">
                <Cell row={row} side="left" />
              </div>
              <div>
                <Cell row={row} side="right" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
