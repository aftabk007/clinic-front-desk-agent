// Builds small CallResults by hand for review and scoring tests.

import type { Action, CallEvent, CallResult, CalendarChange, Escalation } from "../src/types.ts";

export function call(parts: {
  caseId?: string;
  lines?: Array<["agent" | "caller", string]>;
  actions?: Array<Partial<Action> & Pick<Action, "op" | "patientId" | "targetStart">>;
  verified?: string[];
  escalations?: Array<Partial<Escalation> & Pick<Escalation, "category">>;
  changes?: CalendarChange[];
}): CallResult {
  const transcript: CallEvent[] = [];
  for (const id of parts.verified ?? []) transcript.push({ who: "agent", kind: "tool_call", text: "find_patient", data: { id } });
  for (const [who, text] of parts.lines ?? []) transcript.push({ who, kind: "speech", text });
  const verified = (parts.verified ?? []).map((patientId, event) => ({ patientId, event }));
  const actions: Action[] = (parts.actions ?? []).map((a, i) => {
    const event = transcript.push({ who: "agent", kind: "tool_call", text: a.op }) - 1;
    return { appointmentId: `A-N${i + 1}`, confidence: 0.95, evidence: "", otherAppointments: [], event, ...a };
  });
  const escalations: Escalation[] = (parts.escalations ?? []).map((e) => ({ urgency: "now", patientId: "unknown", summary: "", evidence: "", confidence: 0.9, event: 0, ...e }));
  return {
    caseId: parts.caseId ?? "c01", agent: "test", outcome: "completed", turns: 1, wallMs: 1,
    transcript, actions, escalations, verified, changes: parts.changes ?? [],
  };
}
