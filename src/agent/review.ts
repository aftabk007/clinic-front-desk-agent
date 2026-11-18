// Which calendar changes go to a person before they count, and when a call needs a person no matter
// what the agent did. It runs after the call, on saved results, so the rule can change without new calls.
// It does not trust the agent's own judgment alone: it reads the caller's words again.

import type { Action, CallResult } from "../types.ts";
import { MONTHS } from "../util.ts";

/**
 * Red-flag words in the CALLER's speech. A plain keyword list, written from common front-desk triage
 * guidance, not from a clinician. It is a backstop under the agent, not a replacement for it.
 */
export const RED_FLAGS = new RegExp([
  String.raw`chest (pain|pressure|tightness|hurts?)`, String.raw`chest (feels|is|gets|felt|was) (tight|heavy|sore)`, String.raw`(tight|tightness|pressure|pain) in (my|his|her|the) chest`,
  String.raw`short(ness)? of breath`, String.raw`out of breath`, String.raw`can'?t (catch (my|his|her) )?breathe?`, String.raw`trouble breathing`, String.raw`hard to breathe`,
  String.raw`faint(ed|ing)?\b`, String.raw`passed out`, String.raw`blacked out`,
  String.raw`droop(y|ing)?\b`, String.raw`slurr(ed|ing)`, String.raw`(numb|weak)(ness)? on one side`, String.raw`can'?t (move|feel) (my|his|her) (arm|leg|face)`,
  String.raw`worst headache`, String.raw`(severe|heavy) bleeding`, String.raw`bleeding (a lot|heavily|won'?t stop)`, String.raw`(coughing|vomiting|throwing) up blood`, String.raw`seizure`,
  String.raw`suicid`, String.raw`kill (my|him|her)self`, String.raw`end (my life|it all)`, String.raw`(hurt|harm)(ing)? myself`, String.raw`self[- ]harm`,
  String.raw`better off (without me|if i (was|were)n'?t)`, String.raw`(was|were)n'?t (here|around) anymore|if i (was|were)n'?t (here|around)`,
].join("|"), "i");

const AFFIRM = /\b(yes|yeah|yep|sure|works|fine|okay|ok|perfect|great|sounds good|correct|that's right|please do|please cancel|that one)\b/i;
// A "yes" that also asks for another time is not a clear yes: "Yes, that one. The week after, in the morning, please."
const DENY = /^\s*(no|nope)\b|\bnot\b|doesn'?t|\bactually\b|\bwait\b|instead|rather|week after|another (day|time)|different (day|time)|earlier|later in/i;
const HEDGE = /\b(i think|maybe|not sure|i guess|probably|i don'?t know)\b/i;

export interface ReviewDecision {
  needsReview: boolean;
  reason: string;
}

export interface CallReview {
  actions: ReviewDecision[]; // one per CallResult.actions
  redFlagWords: string[];
  agentEscalatedUrgent: boolean;
  backstop: boolean; // red-flag words but the agent did not escalate: the rule alerts a nurse
  sentToStaff: boolean; // anything on this call needs a person
}

export function callerWords(r: CallResult): string {
  return r.transcript.filter((e) => e.who === "caller" && e.kind === "speech").map((e) => e.text).join("\n");
}

export function redFlagWords(text: string): string[] {
  const re = new RegExp(RED_FLAGS.source, "gi");
  return [...new Set([...text.matchAll(re)].map((m) => m[0].toLowerCase()))];
}

/** Ways to say a date: "November 24", "Nov 24", "24th", "11/24". */
export function mentionsDate(text: string, iso: string): boolean {
  const [, m, d] = iso.slice(0, 10).split("-").map(Number);
  const month = MONTHS[m - 1];
  return new RegExp(`(${month}|${month.slice(0, 3)}\\.?)\\s+${d}(?!\\d)|\\b${d}(st|nd|rd|th)\\b|\\b${m}/${d}\\b`, "i").test(text);
}

/** Ways to say a time: "9:00 AM", "9 AM", "9:40", "13:40", "1:40 PM". */
export function mentionsTime(text: string, isoDateTime: string): boolean {
  const [h, min] = isoDateTime.slice(11, 16).split(":");
  const hour = Number(h);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? "a\\.?m\\.?" : "p\\.?m\\.?";
  const short = min === "00" ? `\\b${h12}(:00)?\\s*${ampm}` : `\\b${h12}:${min}\\b`;
  return new RegExp(`${short}|\\b${h}:${min}\\b`, "i").test(text);
}

/**
 * Was the exact date (and time, for a booking or move) said to the caller before the change,
 * and did the caller's next words agree? Looks at the last time the agent said that date.
 */
export function confirmedBeforeAction(r: CallResult, a: Action): boolean {
  const before = r.transcript.slice(0, a.event);
  for (let i = before.length - 1; i >= 0; i--) {
    const e = before[i];
    if (e.who !== "agent" || e.kind !== "speech") continue;
    const said = mentionsDate(e.text, a.targetStart) && (a.op === "cancel" || mentionsTime(e.text, a.targetStart));
    if (!said) continue;
    const answer = before.slice(i + 1).find((x) => x.who === "caller" && x.kind === "speech");
    return !!answer && AFFIRM.test(answer.text) && !DENY.test(answer.text);
  }
  return false;
}

/** Another visit with the same provider within 30 days, or any visit on the same day. */
export function possibleDuplicate(a: Action): boolean {
  const t = Date.parse(a.targetStart + ":00Z");
  return a.otherAppointments.some((o) => o.start.slice(0, 10) === a.targetStart.slice(0, 10)
    || (o.provider === a.slotId?.split("-")[0] && Math.abs(Date.parse(o.start + ":00Z") - t) <= 30 * 86_400_000));
}

export function reviewAction(r: CallResult, a: Action, redFlags: string[]): ReviewDecision {
  // First match wins, so the person sees the most useful reason first.
  if (redFlags.length) return { needsReview: true, reason: `red-flag words in the call (${redFlags.join(", ")}): a nurse decides first` };
  if (!r.verified.some((v) => v.patientId === a.patientId && v.event < a.event)) {
    return { needsReview: true, reason: "name and date of birth were not verified for this patient on this call" };
  }
  if (a.confidence < 0.8) return { needsReview: true, reason: `agent unsure (confidence ${a.confidence})` };
  if (!confirmedBeforeAction(r, a)) return { needsReview: true, reason: "exact date and time were not read back and confirmed first" };
  if (a.op === "book" && possibleDuplicate(a)) return { needsReview: true, reason: "patient already has a visit close to this one: possible double booking" };
  if (HEDGE.test(a.evidence)) return { needsReview: true, reason: "caller sounded unsure" };
  return { needsReview: false, reason: `verified, read back, confirmed (confidence ${a.confidence})` };
}

export function reviewCall(r: CallResult): CallReview {
  const redFlags = redFlagWords(callerWords(r));
  const actions = r.actions.map((a) => reviewAction(r, a, redFlags));
  const agentEscalatedUrgent = r.escalations.some((e) => e.category === "clinical_urgent");
  const backstop = redFlags.length > 0 && !agentEscalatedUrgent;
  return {
    actions,
    redFlagWords: redFlags,
    agentEscalatedUrgent,
    backstop,
    sentToStaff: r.escalations.length > 0 || backstop || actions.some((d) => d.needsReview),
  };
}
