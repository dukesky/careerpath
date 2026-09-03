import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const ASSERTION_TITLES = {
  A1: "Run token minted — panel POSTs /api/run-token and gets a token back",
  A2: "Identity on the wire — the worker's /api/analyze carries a uid claim, not a did",
  A3: "User bucket charged — the panel's allowance goes 5 -> 4 (the end-to-end outcome)",
  A4: "Device bucket untouched — after sign-out the device trial still reads 3",
  A5: "Latency ceiling — one generate completes within the timeout",
  A6: "Anonymous path not gated — a signed-out generate still completes (device 3 -> 2)",
  A7: "Rescore after tailor — /api/rescore is called under the same uid, charges nothing, and its score is the number the panel ends up showing",
};

export const PREFLIGHT_TITLES = {
  P1: "Build freshness — dist rebuilt, panel bundle contains run-token and localhost:3000",
  P2: "Server reachable — dev server up, anonymous GET /api/quota is 2xx",
  P3: "No beta bypass — fresh profile, no cp_beta_code, allowance is a number",
  P4: "Signed in — the panel shows the test account's email",
};

/**
 * A verdict is never PASS on a preflight failure. The whole point of the
 * preflight block is that a measurement taken with a stale build, a dead
 * server or a beta bypass in place is not a measurement at all — reporting
 * PASS from one would be worse than reporting nothing.
 */
export function computeVerdict(preflight, assertions) {
  const preflightFailed = Object.values(preflight).some((p) => p.status === "FAIL");
  if (preflightFailed) return "CANNOT_MEASURE";
  const anyFail = Object.values(assertions).some((a) => a.status === "FAIL");
  if (anyFail) return "FAIL";
  const allMeasured = Object.values(assertions).every((a) => a.status === "PASS");
  return allMeasured ? "PASS" : "FAIL";
}

export async function writeReport(reportsDir, stamp, report) {
  await mkdir(reportsDir, { recursive: true });
  const jsonPath = path.join(reportsDir, `${stamp}.json`);
  const mdPath = path.join(reportsDir, `${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2));
  await writeFile(mdPath, renderMarkdown(report));
  return { jsonPath, mdPath };
}

function renderMarkdown(r) {
  const lines = [];
  lines.push(`# Evaluator report — ${r.startedAt}`);
  lines.push("");
  lines.push(`**Verdict: ${r.verdict}**`);
  lines.push("");
  lines.push(`- mutation: \`${r.mutation ?? "none"}\``);
  lines.push(`- extension dist: \`${r.config.distDir}\``);
  lines.push(`- extension id: \`${r.config.extensionId}\``);
  lines.push(`- headless: ${r.config.headless}`);
  lines.push(`- LLM stubbed: ${r.config.stubLlm} ${r.config.stubLlm ? "(no real generate — verdict is not evidence about the product)" : ""}`);
  lines.push(`- duration: ${(r.durationMs / 1000).toFixed(1)}s`);
  lines.push("");

  lines.push("## Preflight");
  lines.push("");
  lines.push("| id | check | status | evidence |");
  lines.push("| -- | ----- | ------ | -------- |");
  for (const [id, entry] of Object.entries(r.preflight)) {
    lines.push(
      `| ${id} | ${PREFLIGHT_TITLES[id] ?? ""} | **${entry.status}** | ${cell(entry.evidence)} |`,
    );
  }
  lines.push("");

  lines.push("## Assertions");
  lines.push("");
  lines.push("| id | assertion | status | evidence |");
  lines.push("| -- | --------- | ------ | -------- |");
  for (const [id, entry] of Object.entries(r.assertions)) {
    lines.push(
      `| ${id} | ${ASSERTION_TITLES[id] ?? ""} | **${entry.status}** | ${cell(entry.evidence)} |`,
    );
  }
  lines.push("");

  if (r.quota) {
    lines.push("## Quota, as the panel stated it");
    lines.push("");
    for (const [when, value] of Object.entries(r.quota)) {
      lines.push(`- **${when}**: ${value === null ? "unknown" : JSON.stringify(value)}`);
    }
    lines.push("");
  }

  lines.push("## API traffic seen on the wire (recording proxy)");
  lines.push("");
  if (!r.apiRequests?.length) {
    lines.push("_none recorded_");
  } else {
    lines.push("| # | realm | method | path | status | identity | claims |");
    lines.push("| - | ----- | ------ | ---- | ------ | -------- | ------ |");
    for (const req of r.apiRequests) {
      const auth = req.authorization;
      lines.push(
        `| ${req.seq} | ${req.realm} | ${req.method} | ${req.path} | ${req.status ?? req.outcome} | ${auth?.kind ?? "none"} | ${auth?.claims ? cell(auth.claims) : ""} |`,
      );
    }
  }
  lines.push("");

  if (r.timings) {
    lines.push("## Timings");
    lines.push("");
    for (const [k, v] of Object.entries(r.timings)) lines.push(`- ${k}: ${v}`);
    lines.push("");
  }

  if (r.screenshots?.length) {
    lines.push("## Screenshots");
    lines.push("");
    for (const s of r.screenshots) lines.push(`- \`${s}\``);
    lines.push("");
  }

  if (r.notes?.length) {
    lines.push("## Notes");
    lines.push("");
    for (const n of r.notes) lines.push(`- ${n}`);
    lines.push("");
  }

  if (r.fatal) {
    lines.push("## Fatal error");
    lines.push("");
    lines.push("```");
    lines.push(String(r.fatal));
    lines.push("```");
  }

  return lines.join("\n") + "\n";
}

function cell(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 600);
}
