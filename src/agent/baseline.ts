// A rule-based front desk bot with no LLM: keyword intents, regex for name and date of birth,
// and the first free slot that fits. It uses the same tools as the AI agent, runs without an API key,
// and it is the "before" row next to the AI agent.

import { providerById } from "../clinic/data.ts";
import type { CallResult, ProviderId, VisitType } from "../types.ts";
import { addDays, MONTHS, spokenDay, spokenTime, TODAY, weekday } from "../util.ts";
import { executeTool, type CallSession } from "./tools.ts";

// A short emergency keyword list, like a simple phone bot would have.
const BASIC_RED_FLAGS = /chest pain|can'?t breathe|not breathing|stroke|suicid|unconscious|heart attack|911/i;
const YES = /\b(yes|yeah|yep|sure|works|fine|okay|ok|perfect|great|please)\b/i;
const NO = /^\s*(no|nope)\b|\bnot\b|doesn'?t|\bactually\b|\bwait\b/i;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

type Intent = "book" | "reschedule" | "cancel" | "billing" | "clinical_question" | "new_patient" | "other";

function intentOf(text: string): Intent {
  if (/become a patient|new patient|first visit|never been/i.test(text)) return "new_patient";
  if (/\bbill|charge|insurance covered|payment/i.test(text)) return "billing";
  if (/cancel/i.test(text)) return "cancel";
  if (/reschedul|move|change my/i.test(text)) return "reschedule";
  if (/book|appointment|schedule|visit|follow-up|check-up|physical|come in|see (him|her|dr)/i.test(text)) return "book";
  if (/dose|medication|lisinopril|results|refill/i.test(text)) return "clinical_question";
  return "other";
}

/** Name and date of birth from "It's Kevin Walsh, date of birth April 25th, 1980." */
export function parseIdentity(text: string): { name: string; dob: string } | undefined {
  const name = /(?:[Ii]t'?s|[Tt]his is|[Mm]y name is|I'?m|[Nn]ame is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/.exec(text)?.[1];
  const month = new RegExp(`(${MONTHS.join("|")})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`, "i").exec(text);
  const numeric = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(text);
  let dob: string | undefined;
  if (month) dob = `${month[3]}-${String(MONTHS.findIndex((m) => m.toLowerCase() === month[1].toLowerCase()) + 1).padStart(2, "0")}-${month[2].padStart(2, "0")}`;
  else if (numeric) dob = `${numeric[3]}-${numeric[1].padStart(2, "0")}-${numeric[2].padStart(2, "0")}`;
  return name && dob ? { name, dob } : undefined;
}

/** A date range from simple phrases: today, tomorrow, next week, a weekday, "the 23rd", "week of December 7th". */
export function parseDates(text: string): { from: string; to: string } {
  const t = text.toLowerCase();
  const monday = (d: string) => addDays(d, -((new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7));
  const dayOf = (n: number, monthName?: string) => {
    const m = monthName ? MONTHS.findIndex((x) => x.toLowerCase().startsWith(monthName.slice(0, 3))) + 1 : n >= 17 ? 11 : 12;
    return `2026-${String(m).padStart(2, "0")}-${String(n).padStart(2, "0")}`;
  };
  const weekOf = /week of (?:(january|february|march|april|may|june|july|august|september|october|november|december)\s+)?(\d{1,2})/.exec(t);
  if (weekOf) {
    const start = monday(dayOf(Number(weekOf[2]), weekOf[1]));
    return { from: start, to: addDays(start, 4) };
  }
  if (/today or tomorrow/.test(t)) return { from: TODAY, to: addDays(TODAY, 1) };
  if (/\btoday\b/.test(t)) return { from: TODAY, to: TODAY };
  if (/\btomorrow\b/.test(t)) return { from: addDays(TODAY, 1), to: addDays(TODAY, 1) };
  if (/next week/.test(t)) {
    const start = addDays(monday(TODAY), 7);
    return { from: start, to: addDays(start, 4) };
  }
  const exact = /(?:(january|february|march|april|may|june|july|august|september|october|november|december)\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/.exec(t);
  if (exact) {
    const d = dayOf(Number(exact[2]), exact[1]);
    return { from: d, to: d };
  }
  for (const [i, name] of WEEKDAYS.entries()) {
    if (!t.includes(name)) continue;
    let d = addDays(TODAY, 1);
    while (new Date(d + "T00:00:00Z").getUTCDay() !== i) d = addDays(d, 1); // the next one, even for "next Friday"
    return { from: d, to: d };
  }
  if (/next month|later in the month/.test(t)) return { from: addDays(TODAY, 14), to: addDays(TODAY, 24) };
  return { from: TODAY, to: addDays(TODAY, 14) };
}

function visitTypeOf(text: string): VisitType {
  if (/physical|yearly|annual/i.test(text)) return "annual_physical";
  if (/sick|sore throat|fever|cough|cold\b|stuffy/i.test(text)) return "sick_visit";
  return "follow_up";
}

function providerOf(text: string): ProviderId | undefined {
  if (/brooks|heart doctor|cardiolog/i.test(text)) return "brooks";
  if (/raman/i.test(text)) return "raman";
  if (/okafor/i.test(text)) return "okafor";
  return undefined;
}

export async function runBaseline(s: CallSession): Promise<CallResult> {
  const started = Date.now();
  s.start();
  const opening = s.c.caller.opening;
  let turns = 0;
  const tool = async (name: string, input: Record<string, unknown>) => {
    turns++;
    return (await executeTool(name, input, s)).text;
  };
  const say = async (text: string) => (await tool("say", { text })).replace(/^Caller: "|"( \[The caller hangs up\.\])?$/g, "");
  const escalate = (category: string, urgency: string, summary: string, patientId = "unknown") =>
    tool("escalate_to_staff", { category, urgency, patient_id: patientId, summary, confidence: 0.9, evidence: opening });
  const finish = async (goodbye = "Thank you for calling. Goodbye.") => {
    await say(goodbye);
    await tool("end_call", { summary: "baseline done" });
    return s.result({ agent: "baseline (rules, no LLM)", outcome: "completed", turns, wallMs: Date.now() - started });
  };

  if (BASIC_RED_FLAGS.test(opening)) {
    await say("If this is a medical emergency, please hang up and call 911 now.");
    await escalate("clinical_urgent", "now", "Emergency keyword in the opening.");
    return finish();
  }
  const intent = intentOf(opening);
  if (intent === "billing" || intent === "clinical_question" || intent === "new_patient" || intent === "other") {
    await escalate(intent, "routine", `Caller asked: ${opening}`);
    return finish("I've sent your request to our staff. They will call you back. Goodbye.");
  }

  // Identity: two tries.
  let patientId: string | undefined;
  for (const ask of ["Can I have your full name and date of birth, please?", "Sorry, I could not find you. Please say your full name and date of birth again."]) {
    const id = parseIdentity(await say(ask));
    if (!id) continue;
    const found = await tool("find_patient", { full_name: id.name, date_of_birth: id.dob });
    patientId = /patient_id (P\d+)/.exec(found)?.[1];
    if (patientId) break;
  }
  if (!patientId) {
    await escalate("identity", "routine", "Could not verify the caller.");
    return finish("I could not verify your details. Our staff will call you back. Goodbye.");
  }

  const appts = await tool("get_appointments", { patient_id: patientId });
  const list = [...appts.matchAll(/- (A-[\w]+): (\w+, \w+ \d+) at ([\d:]+ [AP]M), (Dr\. [\w ]+), (\w+)/g)]
    .map((m) => ({ id: m[1], day: m[2], time: m[3], provider: m[4], visitType: m[5] }));
  const heard = [opening];

  if (intent === "cancel" || intent === "reschedule") {
    if (!list.length) {
      await escalate("other", "routine", "Caller wants to change a visit but none is on file.", patientId);
      return finish("I don't see an upcoming appointment. Our staff will call you back. Goodbye.");
    }
    const target = list[0]; // the soonest one
    if (intent === "cancel") {
      const ok = await say(`I will cancel your ${target.visitType} on ${target.day} at ${target.time} with ${target.provider}. Is that right?`);
      if (YES.test(ok) && !NO.test(ok)) await tool("cancel_appointment", { patient_id: patientId, appointment_id: target.id, confidence: 0.9, evidence: ok });
      return finish();
    }
    const range = parseDates(opening);
    const provider = Object.values({ raman: "raman", okafor: "okafor", brooks: "brooks" }).find((p) => providerById(p)!.name === target.provider) as ProviderId;
    return offerAndWrite(provider, target.visitType as VisitType, range, heard, (slot, ev) =>
      tool("reschedule_appointment", { patient_id: patientId, appointment_id: target.id, new_slot_id: slot, confidence: 0.9, evidence: ev }));
  }

  // Book.
  const pcp = /Primary care: (Dr\. [\w ]+)\./.exec(s.transcript.map((e) => e.text).join("\n"))?.[1];
  const provider = providerOf(opening) ?? (["raman", "okafor", "brooks"] as ProviderId[]).find((p) => providerById(p)!.name === pcp) ?? "raman";
  return offerAndWrite(provider, visitTypeOf(opening), parseDates(opening), heard, (slot, ev) =>
    tool("book_appointment", { patient_id: patientId, slot_id: slot, visit_type: visitTypeOf(opening), reason: opening.slice(0, 80), confidence: 0.9, evidence: ev }));

  async function offerAndWrite(provider: ProviderId, visitType: VisitType, range: { from: string; to: string }, said: string[],
    write: (slotId: string, evidence: string) => Promise<string>): Promise<CallResult> {
    const part = /morning/i.test(said.join(" ")) ? "morning" : /afternoon/i.test(said.join(" ")) ? "afternoon" : "any";
    const found = await tool("find_open_slots", { provider, visit_type: visitType, from_date: range.from, to_date: range.to, part_of_day: part });
    const slots = [...found.matchAll(/- ([a-z]+-\d{8}-\d{4}):/g)].map((m) => m[1]).slice(0, 3);
    for (const slot of slots) {
      const [, p, ymd, hm] = /^([a-z]+)-(\d{8})-(\d{4})$/.exec(slot)!;
      const start = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}T${hm.slice(0, 2)}:${hm.slice(2)}`;
      const answer = await say(`I have ${spokenDay(start)} at ${spokenTime(start)} with ${providerById(p)!.name}. Does that work?`);
      if (YES.test(answer) && !NO.test(answer)) {
        await write(slot, answer);
        return finish(`You're all set for ${weekday(start)} at ${spokenTime(start)}. Goodbye.`);
      }
    }
    await escalate("other", "routine", "Could not find a time that works.", patientId);
    return finish("Sorry, I could not find a time. Our staff will call you back. Goodbye.");
  }
}
