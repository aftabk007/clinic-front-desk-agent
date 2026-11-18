// Shared types for the clinic front desk demo. All data is synthetic.

export type ProviderId = "raman" | "okafor" | "brooks";
export type VisitType = "follow_up" | "annual_physical" | "sick_visit" | "new_patient";
export type PartOfDay = "morning" | "afternoon";

export interface Provider {
  id: ProviderId;
  name: string;
  specialty: "internal medicine" | "cardiology";
  visitTypes: VisitType[];
}

export interface Patient {
  id: string;
  name: string; // legal name on the chart
  dob: string; // YYYY-MM-DD
  phone: string; // fictional 555-01xx numbers
  pcp: ProviderId;
}

export interface Slot {
  id: string; // e.g. "raman-20261124-0900"
  provider: ProviderId;
  start: string; // local time, "2026-11-24T09:00"
}

export interface Appointment {
  id: string;
  patientId: string;
  slotId: string;
  provider: ProviderId;
  start: string;
  visitType: VisitType;
  reason: string;
  status: "booked" | "cancelled";
}

export type EscalationCategory =
  | "clinical_urgent" // red-flag symptom: nurse now, or 911 / 988
  | "clinical_question" // medication, results, advice: nurse calls back
  | "identity" // could not verify who is calling
  | "new_patient" // not in the chart yet: staff registers them
  | "billing"
  | "other";

export type Urgency = "now" | "today" | "routine";

/** One write the caller made in the mock EHR during the call. */
export interface Action {
  op: "book" | "reschedule" | "cancel";
  patientId: string;
  appointmentId: string; // the appointment created (book) or changed
  slotId?: string; // book / reschedule: the new slot
  targetStart: string; // book / reschedule: the new time; cancel: the time of the cancelled visit
  confidence: number;
  evidence: string; // the caller's words that confirm it
  event: number; // index of the tool-call event in the transcript
  /** The patient's other booked appointments at the moment of the write (for the double-booking check). */
  otherAppointments: Array<Pick<Appointment, "id" | "provider" | "start" | "visitType">>;
}

export interface Escalation {
  category: EscalationCategory;
  urgency: Urgency;
  patientId: string; // "unknown" when not verified
  summary: string;
  evidence: string;
  confidence: number;
  event: number;
}

export interface CallEvent {
  who: "caller" | "agent" | "system";
  kind: "speech" | "tool_call" | "tool_result" | "end";
  text: string;
  data?: unknown;
}

export type CallOutcome = "completed" | "max_turns" | "refusal" | "error";

/** Net change in the calendar after the call, per appointment. */
export interface CalendarChange {
  op: "book" | "reschedule" | "cancel";
  patientId: string;
  appointmentId: string;
  slotId?: string;
  provider?: ProviderId;
  start?: string;
  visitType?: VisitType;
  actions: number[]; // indexes into CallResult.actions that made this change
}

export interface CallResult {
  caseId: string;
  agent: string; // "gemini-3.5-flash-lite (low)" or "baseline (rules, no LLM)"
  outcome: CallOutcome;
  error?: string;
  turns: number;
  wallMs: number;
  usage?: { input: number; output: number; cacheRead: number };
  transcript: CallEvent[];
  actions: Action[];
  escalations: Escalation[];
  verified: Array<{ patientId: string; event: number }>; // successful name + DOB checks
  changes: CalendarChange[];
}
