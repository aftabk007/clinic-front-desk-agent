// Re-scores saved runs with the CURRENT review rule and answer key. No API calls.
//
//   npm run report                                   the newest full run of each front desk
//   npm run report -- results/runs/<run folder> ...  specific runs

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { reviewCall } from "./agent/review.ts";
import { CASES, getCase } from "./cases.ts";
import { printScore, summaryTable } from "./print.ts";
import { scoreCall, summarize, type RunSummary } from "./score.ts";
import type { CallResult } from "./types.ts";

const ROOT = "results/runs";
const verbose = process.argv.includes("--verbose");
let dirs = process.argv.slice(2).filter((a) => !a.startsWith("--"));

if (dirs.length === 0) {
  const full = existsSync(ROOT)
    ? readdirSync(ROOT).filter((d) => CASES.every((k) => existsSync(`${ROOT}/${d}/${k.id}.json`))).sort()
    : [];
  const newest = new Map<string, string>();
  for (const d of full) newest.set(d.replace(/^\d+-/, ""), `${ROOT}/${d}`); // sorted by time, so the last one wins
  dirs = [...newest.values()];
}
if (dirs.length === 0) {
  console.log("No full runs saved yet. Try: npm run bench -- --agent baseline");
  process.exit(1);
}

const rows: RunSummary[] = [];
for (const dir of dirs) {
  const files = readdirSync(dir).filter((f) => /^c\d\d\.json$/.test(f)).sort();
  const results = files.map((f) => (JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as { result: CallResult }).result);
  const scores = results.map((r) => scoreCall(getCase(r.caseId), r, reviewCall(r)));
  const summary = summarize(results[0].agent, scores, results);
  rows.push(summary);
  console.log(`\n=== ${dir} (${summary.agent})`);
  for (const s of scores) {
    if (verbose || !s.success || s.unsafe > 0) printScore(s);
  }
  const t = summary.tokens;
  console.log(`\n${summary.success}/${summary.calls} right, ${summary.unsafe} unsafe accepted without review, `
    + `${summary.sentToStaff}/${summary.calls} sent to staff, ${summary.wrongChanges} wrong calendar changes in total`
    + (t ? `, tokens: ${t.input.toLocaleString()} in + ${t.cacheRead.toLocaleString()} cached, ${t.output.toLocaleString()} out` : ""));
}

console.log(`\n${summaryTable(rows)}`);
