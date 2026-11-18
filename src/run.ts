// Run synthetic clinic calls and score them.
//
//   npm run call -- c05                    one call with the AI agent, printed live
//   npm run call -- c05 --agent baseline   the same call with the rule-based bot (no API key)
//   npm run bench                          all 20 calls with the AI agent
//   npm run bench -- --agent baseline      all 20 with the rule-based bot
//   options: --agent gemini|baseline, --concurrency 2, --resume results/runs/<run folder>

import { ApiError, GoogleGenAI, type GenerateContentParameters } from "@google/genai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { runGeminiCall } from "./agent/agent-gemini.ts";
import { runBaseline } from "./agent/baseline.ts";
import { reviewCall } from "./agent/review.ts";
import { CallSession } from "./agent/tools.ts";
import { CASES, getCase, type Case } from "./cases.ts";
import { printScore } from "./print.ts";
import { scoreCall, summarize, type CaseScore } from "./score.ts";
import type { CallEvent, CallResult } from "./types.ts";

// Same model as payer-call-agent: works on the free tier with tool calling.
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const all = args.includes("--all");
const agentKind = flag("agent", process.env.GEMINI_API_KEY ? "gemini" : "baseline");
const resumeDir = flag("resume", "");
const effort = (process.env.AGENT_EFFORT || "low") as "low" | "medium" | "high";
const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
const concurrency = Number(flag("concurrency", "2"));
if (!["gemini", "baseline"].includes(agentKind)) {
  console.error(`Unknown --agent ${agentKind}. Use gemini or baseline.`);
  process.exit(1);
}
if (agentKind === "gemini" && !process.env.GEMINI_API_KEY) {
  console.error("No GEMINI_API_KEY found. Copy .env.example to .env and set it.\nTo try the harness without a key: npm run bench -- --agent baseline");
  process.exit(1);
}
const gemini = agentKind === "gemini"
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { timeout: 90_000, retryOptions: { attempts: 1 } } })
  : null;

/** Thrown when the key's daily quota for this model is used up; retrying today won't help. */
class DailyLimitError extends Error {}
let dailyLimitHit = false;

/** Retries per-minute limits and server errors (waiting as long as Google asks); stops on the daily limit. */
async function geminiSend(params: GenerateContentParameters) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await gemini!.models.generateContent(params);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.status === 429 && /per ?day/i.test(err.message)) {
        dailyLimitHit = true;
        throw new DailyLimitError(`Daily free-tier limit reached for ${params.model}. ${/limit: \d+/.exec(err.message)?.[0] ?? ""}`);
      }
      if (attempt >= 6 || ![429, 500, 503, 504].includes(err.status)) throw err;
      const askedSeconds = Number(/retry in ([\d.]+)s/i.exec(err.message)?.[1] ?? 0);
      await new Promise((r) => setTimeout(r, askedSeconds ? askedSeconds * 1000 + 500 : Math.min(60_000, 2000 * 2 ** attempt)));
    }
  }
}

async function runOne(k: Case, live: boolean): Promise<CallResult> {
  const session = new CallSession(k);
  if (live) {
    const log = session.log.bind(session);
    session.log = (e: CallEvent) => {
      printEvent(e);
      return log(e);
    };
  }
  if (agentKind === "baseline") return runBaseline(session);
  return runGeminiCall(session, { model, effort, maxTurns: 30, send: geminiSend });
}

function printEvent(e: CallEvent): void {
  if (e.kind === "speech") console.log(`${{ caller: "CALLER", agent: "AGENT ", system: "LINE  " }[e.who]}  ${e.text}`);
  else if (e.kind === "tool_call" && e.text !== "say") console.log(`        → ${e.text} ${JSON.stringify(e.data)}`);
  else if (e.kind === "tool_result" && !e.text.startsWith("Caller:")) console.log(`        ← ${e.text.replace(/\n/g, "\n          ")}`);
}

async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length && !dailyLimitHit) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const cases = all ? CASES : [getCase(args.find((a) => /^c\d\d$/.test(a)) ?? "c01")];
const tag = agentKind === "baseline" ? "baseline" : `${model}-${effort}`;
const runId = resumeDir ? resumeDir.replace(/\/$/, "").split("/").pop()! : `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${tag}`;
const dir = `results/runs/${runId}`;
mkdirSync(dir, { recursive: true });

// --resume <dir>: keep the calls that already finished there, run only the rest.
type Done = { result: CallResult; score: CaseScore };
const saved = new Map<string, Done>();
for (const k of cases) {
  const file = `${dir}/${k.id}.json`;
  if (!resumeDir || !existsSync(file)) continue;
  const prev = JSON.parse(readFileSync(file, "utf8")) as Done;
  if (prev.result.outcome !== "error") saved.set(k.id, prev);
}
if (saved.size) console.log(`Resuming ${dir}: ${saved.size} calls already done.`);

const ran = await pool(cases.filter((k) => !saved.has(k.id)), all ? concurrency : 1, async (k) => {
  if (!all) console.log(`${k.id} ${k.title}\nTests: ${k.tests}\n`);
  const result = await runOne(k, !all);
  if (result.error?.startsWith("Daily free-tier limit")) {
    console.log(`${k.id} stopped: ${result.error}`);
    return undefined; // not saved, so --resume runs it again
  }
  const review = reviewCall(result);
  const score = scoreCall(k, result, review);
  writeFileSync(`${dir}/${k.id}.json`, JSON.stringify({ case: { id: k.id, title: k.title, tests: k.tests }, result, review, score }, null, 2));
  if (all) console.log(`${k.id} ${score.success ? "SUCCESS" : "failed "} unsafe ${score.unsafe} ${score.sentToStaff ? "staff" : "auto "} `
    + `${result.turns} turns, ${result.outcome}${result.error ? ` (${result.error})` : ""}`);
  return { result, score };
});

const results = cases.map((k) => saved.get(k.id) ?? ran.find((r) => r?.result.caseId === k.id)).filter((r): r is Done => !!r);
if (results.length === 0) {
  console.log("No call finished. " + (dailyLimitHit ? "The daily limit is used up; try again tomorrow or with another GEMINI_MODEL." : ""));
  process.exit(1);
}
const summary = summarize(results[0].result.agent, results.map((r) => r.score), results.map((r) => r.result));
writeFileSync(`${dir}/summary.json`, JSON.stringify({ runId, summary }, null, 2));
if (!all) {
  printScore(results[0].score);
  console.log(`\nSaved: ${dir}/${cases[0].id}.json`);
} else {
  console.log(`\n${summary.agent}: ${summary.success}/${summary.calls} calls right, ${summary.unsafe} unsafe actions accepted without review `
    + `(${summary.unsafeWithoutReview} without the review rule), ${summary.sentToStaff}/${summary.calls} calls sent to staff, `
    + `red flags escalated by the agent ${summary.redFlagsEscalatedByAgent}/${summary.redFlagCalls}.`);
  console.log(`Saved: ${dir}/`);
  if (results.length < cases.length) console.log(`${results.length}/${cases.length} calls done. To finish later: npm run bench -- --resume ${dir}`);
}
