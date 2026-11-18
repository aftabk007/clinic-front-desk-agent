// Console output for scores and run summaries.

import type { CaseScore, RunSummary } from "./score.ts";

export function printScore(s: CaseScore): void {
  console.log(`\n${s.caseId} ${s.title}: ${s.success ? "SUCCESS" : "FAILED"}, unsafe ${s.unsafe}, `
    + `${s.sentToStaff ? "sent to staff" : "fully automatic"}${s.redFlag !== "none" ? `, red flag ${s.redFlag}` : ""}`);
  for (const c of s.changes) {
    const at = c.change.start ? ` ${c.change.start} ${c.change.provider} ${c.change.visitType}` : "";
    console.log(`  ${c.status.padEnd(16)} ${c.change.op} ${c.change.appointmentId} for ${c.change.patientId}${at} (${c.reason})`);
  }
  for (const m of s.missing) console.log(`  missing          ${m.op} for ${m.patientId}${m.dates ? ` on ${m.dates.join("/")}` : ""}`);
  for (const n of s.notes) console.log(`  note: ${n}`);
}

const pct = (a: number, b: number) => `${Math.round((100 * a) / Math.max(1, b))}%`;

export function summaryTable(rows: RunSummary[]): string {
  const lines = [
    "| Front desk | Calls handled right | Unsafe actions accepted without review | Unsafe if every action were auto-accepted | Calls sent to staff | Red flags escalated by the agent |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(`| ${r.agent} | ${r.success} / ${r.calls} | ${r.unsafe} | ${r.unsafeWithoutReview} | ${r.sentToStaff} / ${r.calls} (${pct(r.sentToStaff, r.calls)}) | ${r.redFlagsEscalatedByAgent} / ${r.redFlagCalls} |`);
  }
  return lines.join("\n");
}
