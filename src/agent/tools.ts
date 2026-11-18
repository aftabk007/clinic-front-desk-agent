// The agent's tools, how their inputs are checked, and the call session that logs everything.
// The same tools serve the Gemini agent and the rule-based baseline, so both are scored the same way.

import { ScriptedCaller } from "../caller.ts";
import type { Case } from "../cases.ts";
import { CLINIC_NAME, providerById } from "../clinic/data.ts";
import { MockEhr } from "../clinic/ehr.ts";
import type { Action, Appointment, CallEvent, CallOutcome, CallResult, Escalation, EscalationCategory, ProviderId, Urgency, VisitType } from "../types.ts";
import { spokenDay, spokenTime } from "../util.ts";

const VISIT_TYPES: VisitType[] = ["follow_up", "annual_physical", "sick_visit", "new_patient"];
const CATEGORIES: EscalationCategory[] = ["clinical_urgent", "clinical_question", "identity", "new_patient", "billing", "other"];
const URGENCIES: Urgency[] = ["now", "today", "routine"];

const strictObject = (properties: Record<string, unknown>) => ({
  type: "object" as const,
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const confidence = { type: "number", description: "0 to 1: how sure you are that this is what the caller wants and that it is safe to do" };
const evidence = { type: "string", description: "The caller's exact words that support this" };

export interface ToolSpec {
  name: string;
  description: string;
  schema: ReturnType<typeof strictObject>;
}

/** Provider-neutral tool definitions (JSON Schema). */
export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "say",
    description: "Speak to the caller. Keep it short and natural, like a phone call. Returns what the caller says back.",
    schema: strictObject({ text: { type: "string", description: "What you say out loud" } }),
  },
  {
    name: "find_patient",
    description: "Verify a caller against the chart. Full name and date of birth must both match. Returns the patient_id, or no match.",
    schema: strictObject({
      full_name: { type: "string" },
      date_of_birth: { type: "string", description: "YYYY-MM-DD" },
    }),
  },
  {
    name: "get_appointments",
    description: "List a patient's upcoming booked visits.",
    schema: strictObject({ patient_id: { type: "string" } }),
  },
  {
    name: "find_open_slots",
    description: "Find open 40-minute slots. Returns up to 8, soonest first.",
    schema: strictObject({
      provider: { type: "string", enum: ["raman", "okafor", "brooks", "any"] },
      visit_type: { type: "string", enum: VISIT_TYPES },
      from_date: { type: "string", description: "YYYY-MM-DD" },
      to_date: { type: "string", description: "YYYY-MM-DD" },
      part_of_day: { type: "string", enum: ["morning", "afternoon", "any"] },
    }),
  },
  {
    name: "book_appointment",
    description: "Book a new visit in a free slot, after the caller clearly said yes to the exact date and time.",
    schema: strictObject({
      patient_id: { type: "string" },
      slot_id: { type: "string" },
      visit_type: { type: "string", enum: VISIT_TYPES },
      reason: { type: "string", description: "Short reason for the visit, in the caller's words" },
      confidence,
      evidence,
    }),
  },
  {
    name: "reschedule_appointment",
    description: "Move an existing visit to a free slot, after the caller clearly said yes to the exact new date and time.",
    schema: strictObject({
      patient_id: { type: "string" },
      appointment_id: { type: "string" },
      new_slot_id: { type: "string" },
      confidence,
      evidence,
    }),
  },
  {
    name: "cancel_appointment",
    description: "Cancel an existing visit, after you read back its weekday, date, time and provider and the caller clearly said yes.",
    schema: strictObject({
      patient_id: { type: "string" },
      appointment_id: { type: "string" },
      confidence,
      evidence,
    }),
  },
  {
    name: "escalate_to_staff",
    description: "Send the call to a person. urgency now = page a nurse or staff member right away; today = callback today; "
      + "routine = callback within one business day.",
    schema: strictObject({
      category: { type: "string", enum: CATEGORIES },
      urgency: { type: "string", enum: URGENCIES },
      patient_id: { type: "string", description: "The verified patient_id, or 'unknown'" },
      summary: { type: "string", description: "One or two sentences for the staff member" },
      confidence,
      evidence,
    }),
  },
  {
    name: "end_call",
    description: "Hang up after saying goodbye.",
    schema: strictObject({ summary: { type: "string", description: "What happened on the call, for the log" } }),
  },
];

function describeAppt(a: Appointment): string {
  return `${spokenDay(a.start)} at ${spokenTime(a.start)}, ${providerById(a.provider)!.name}, ${a.visitType}`;
}

/** One phone call: the mock EHR, the scripted caller, and a log of everything said and done. */
export class CallSession {
  readonly c: Case;
  readonly ehr: MockEhr;
  readonly caller: ScriptedCaller;
  transcript: CallEvent[] = [];
  actions: Action[] = [];
  escalations: Escalation[] = [];
  verified: CallResult["verified"] = [];
  ended = false;

  constructor(c: Case) {
    this.c = c;
    this.ehr = new MockEhr(c.appointments, { forceFree: c.forceFree });
    this.caller = new ScriptedCaller(c.caller);
  }

  log(e: CallEvent): number {
    this.transcript.push(e);
    return this.transcript.length - 1;
  }

  /** The first thing the agent hears: caller ID, the greeting it already said, and the caller's opening words. */
  start(): string {
    const phone = this.c.caller.phone;
    const charts = this.ehr.patientsByPhone(phone);
    const id = charts.length
      ? `Chart(s) with this phone number: ${charts.map((p) => `${p.name} (${p.id})`).join(", ")}.`
      : "No chart has this phone number.";
    const greeting = `Thank you for calling ${CLINIC_NAME}. This is the virtual front desk. How can I help you today?`;
    this.log({ who: "system", kind: "speech", text: `Incoming call from ${phone}. ${id}` });
    this.log({ who: "agent", kind: "speech", text: greeting });
    this.log({ who: "caller", kind: "speech", text: this.c.caller.opening });
    return `[Incoming call. Caller ID: ${phone}. ${id}]\nYou answered: "${greeting}"\nCaller: "${this.c.caller.opening}"`;
  }

  result(base: { agent: string; outcome: CallOutcome; error?: string; turns: number; wallMs: number; usage?: CallResult["usage"] }): CallResult {
    return {
      caseId: this.c.id,
      ...base,
      transcript: this.transcript,
      actions: this.actions,
      escalations: this.escalations,
      verified: this.verified,
      changes: this.ehr.changes(),
    };
  }
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const conf = (v: unknown) => (typeof v === "number" && v >= 0 && v <= 1 ? v : NaN);
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Runs one tool call. The returned text is what the agent sees. */
export async function executeTool(name: string, input: Record<string, unknown>, s: CallSession): Promise<{ text: string; isError?: boolean }> {
  const event = s.log({ who: "agent", kind: "tool_call", text: name, data: input });
  const out = run(name, input, s, event);
  s.log({ who: "system", kind: "tool_result", text: out.text, data: out.isError ? { error: true } : undefined });
  return out;
}

function run(name: string, input: Record<string, unknown>, s: CallSession, event: number): { text: string; isError?: boolean } {
  const fail = (text: string) => ({ text, isError: true });
  switch (name) {
    case "say": {
      const text = str(input.text);
      if (!text) return fail("Say something.");
      if (s.caller.hungUp) return { text: "[The caller has hung up. Nobody hears you.]" };
      s.log({ who: "agent", kind: "speech", text });
      const reply = s.caller.reply(text);
      s.log({ who: "caller", kind: "speech", text: reply });
      return { text: s.caller.hungUp ? `Caller: "${reply}" [The caller hangs up.]` : `Caller: "${reply}"` };
    }
    case "find_patient": {
      const dob = str(input.date_of_birth);
      if (!isDate(dob)) return fail("date_of_birth must be YYYY-MM-DD.");
      const p = s.ehr.findPatient(str(input.full_name), dob);
      if (!p) return { text: "No patient matches that full name and date of birth." };
      s.verified.push({ patientId: p.id, event });
      return { text: `Verified: patient_id ${p.id}, ${p.name}. Primary care: ${providerById(p.pcp)!.name}.` };
    }
    case "get_appointments": {
      const id = str(input.patient_id);
      if (!s.ehr.patientById(id)) return fail(`There is no patient ${id}.`);
      const list = s.ehr.appointmentsFor(id);
      if (!list.length) return { text: `${id} has no upcoming appointments.` };
      return { text: `${id} has ${list.length} upcoming appointment(s):\n${list.map((a) => `- ${a.id}: ${describeAppt(a)} (${a.reason})`).join("\n")}` };
    }
    case "find_open_slots": {
      const from = str(input.from_date);
      const to = str(input.to_date);
      if (!isDate(from) || !isDate(to)) return fail("from_date and to_date must be YYYY-MM-DD.");
      const visitType = str(input.visit_type) as VisitType;
      if (!VISIT_TYPES.includes(visitType)) return fail(`visit_type must be one of ${VISIT_TYPES.join(", ")}.`);
      const provider = (str(input.provider) || "any") as ProviderId | "any";
      const part = (str(input.part_of_day) || "any") as "morning" | "afternoon" | "any";
      const r = s.ehr.openSlots({ provider, visitType, fromDate: from, toDate: to, partOfDay: part });
      if (!r.ok) return fail(r.error);
      if (!r.slots.length) return { text: "No open slots match. Try other dates, another part of the day, or another provider." };
      return { text: `Open slots (${visitType}):\n${r.slots.map((x) => `- ${x.id}: ${spokenDay(x.start)}, ${spokenTime(x.start)}, ${providerById(x.provider)!.name}`).join("\n")}` };
    }
    case "book_appointment":
    case "reschedule_appointment":
    case "cancel_appointment": {
      const patientId = str(input.patient_id);
      const c = conf(input.confidence);
      if (Number.isNaN(c)) return fail("confidence must be a number from 0 to 1.");
      const before = s.ehr.appointmentsFor(patientId);
      let w;
      let op: Action["op"];
      if (name === "book_appointment") {
        op = "book";
        const visitType = str(input.visit_type) as VisitType;
        if (!VISIT_TYPES.includes(visitType)) return fail(`visit_type must be one of ${VISIT_TYPES.join(", ")}.`);
        w = s.ehr.book(patientId, str(input.slot_id), visitType, str(input.reason));
      } else if (name === "reschedule_appointment") {
        op = "reschedule";
        w = s.ehr.reschedule(patientId, str(input.appointment_id), str(input.new_slot_id));
      } else {
        op = "cancel";
        w = s.ehr.cancel(patientId, str(input.appointment_id));
      }
      if (!w.ok) return fail(w.error);
      const a = w.appointment;
      const original = before.find((b) => b.id === a.id);
      s.actions.push({
        op,
        patientId,
        appointmentId: a.id,
        slotId: op === "cancel" ? undefined : a.slotId,
        targetStart: op === "cancel" ? (original?.start ?? a.start) : a.start,
        confidence: c,
        evidence: str(input.evidence),
        event,
        otherAppointments: before.filter((b) => b.id !== a.id).map(({ id, provider, start, visitType }) => ({ id, provider, start, visitType })),
      });
      s.ehr.touch(a.id, s.actions.length - 1);
      const verb = op === "book" ? `Booked ${a.id}` : op === "reschedule" ? `Moved ${a.id} to` : `Cancelled ${a.id}`;
      return { text: `${verb}: ${describeAppt(a)}.` };
    }
    case "escalate_to_staff": {
      const category = str(input.category) as EscalationCategory;
      const urgency = str(input.urgency) as Urgency;
      const c = conf(input.confidence);
      if (!CATEGORIES.includes(category)) return fail(`category must be one of ${CATEGORIES.join(", ")}.`);
      if (!URGENCIES.includes(urgency)) return fail(`urgency must be one of ${URGENCIES.join(", ")}.`);
      if (Number.isNaN(c)) return fail("confidence must be a number from 0 to 1.");
      s.escalations.push({ category, urgency, patientId: str(input.patient_id) || "unknown", summary: str(input.summary), evidence: str(input.evidence), confidence: c, event });
      const next = urgency === "now" ? "A nurse or staff member is being paged now and will call back within minutes."
        : urgency === "today" ? "Staff will call back today." : "Staff will call back within one business day.";
      return { text: `Sent to staff (${category}, ${urgency}). ${next}` };
    }
    case "end_call":
      s.ended = true;
      return { text: "[Call ended.]" };
    default:
      return fail(`Unknown tool ${name}.`);
  }
}
