// A small mock EHR / practice management calendar. One fresh copy per call.
// It checks what a real scheduling system checks (slot free, visit type allowed, slot not in the past),
// and it does NOT stop a patient from holding two visits: that is the agent's and the review rule's job.

import type { Appointment, CalendarChange, Patient, ProviderId, Slot, VisitType } from "../types.ts";
import { normalizeName, NOW, partOfDay } from "../util.ts";
import { allSlots, parseSlotId, PATIENTS, providerById, takenByOthers } from "./data.ts";

export interface SlotQuery {
  provider: ProviderId | "any";
  visitType: VisitType;
  fromDate: string; // YYYY-MM-DD
  toDate: string;
  partOfDay: "morning" | "afternoon" | "any";
}

export type Write = { ok: true; appointment: Appointment } | { ok: false; error: string };

export class MockEhr {
  readonly patients: Patient[];
  private appts = new Map<string, Appointment>();
  private initial = new Map<string, Appointment>();
  private touched = new Map<string, number[]>();
  private forceFree: Set<string>;
  private nextId = 1;

  constructor(existing: Appointment[] = [], opts: { forceFree?: string[]; patients?: Patient[] } = {}) {
    this.patients = opts.patients ?? PATIENTS;
    this.forceFree = new Set(opts.forceFree ?? []);
    for (const a of existing) {
      this.appts.set(a.id, { ...a });
      this.initial.set(a.id, { ...a });
    }
  }

  /** Name and date of birth must both match the chart exactly (case and punctuation ignored). */
  findPatient(name: string, dob: string): Patient | undefined {
    const n = normalizeName(name);
    return this.patients.find((p) => normalizeName(p.name) === n && p.dob === dob.trim());
  }

  patientById(id: string): Patient | undefined {
    return this.patients.find((p) => p.id === id);
  }

  patientsByPhone(phone: string): Patient[] {
    return this.patients.filter((p) => p.phone === phone);
  }

  /** Upcoming booked visits for one patient, soonest first. */
  appointmentsFor(patientId: string): Appointment[] {
    return [...this.appts.values()]
      .filter((a) => a.patientId === patientId && a.status === "booked" && a.start >= NOW)
      .sort((a, b) => a.start.localeCompare(b.start));
  }

  isFree(slotId: string): boolean {
    const taken = [...this.appts.values()].some((a) => a.slotId === slotId && a.status === "booked");
    return !taken && (this.forceFree.has(slotId) || !takenByOthers(slotId));
  }

  openSlots(q: SlotQuery, limit = 8): { ok: true; slots: Slot[] } | { ok: false; error: string } {
    const providers = q.provider === "any" ? ["raman", "okafor", "brooks"] : [q.provider];
    const allowed = providers.filter((id) => providerById(id)?.visitTypes.includes(q.visitType));
    if (allowed.length === 0) {
      const p = providerById(q.provider)!;
      return { ok: false, error: `${p.name} (${p.specialty}) does not offer ${q.visitType} visits.` };
    }
    const slots = allSlots().filter((s) =>
      allowed.includes(s.provider)
      && s.start.slice(0, 10) >= q.fromDate && s.start.slice(0, 10) <= q.toDate
      && (q.partOfDay === "any" || partOfDay(s.start) === q.partOfDay)
      && s.start > NOW
      && this.isFree(s.id));
    return { ok: true, slots: slots.slice(0, limit) };
  }

  private checkSlot(slotId: string, visitType: VisitType): Slot | string {
    const slot = parseSlotId(slotId);
    if (!slot) return `There is no slot ${slotId}.`;
    if (slot.start <= NOW) return "That slot has already passed.";
    if (!this.isFree(slot.id)) return "That slot is no longer free.";
    const p = providerById(slot.provider)!;
    if (!p.visitTypes.includes(visitType)) return `${p.name} (${p.specialty}) does not offer ${visitType} visits.`;
    return slot;
  }

  book(patientId: string, slotId: string, visitType: VisitType, reason: string): Write {
    if (!this.patientById(patientId)) return { ok: false, error: `There is no patient ${patientId}.` };
    const slot = this.checkSlot(slotId, visitType);
    if (typeof slot === "string") return { ok: false, error: slot };
    const appt: Appointment = {
      id: `A-N${this.nextId++}`, patientId, slotId: slot.id, provider: slot.provider, start: slot.start,
      visitType, reason, status: "booked",
    };
    this.appts.set(appt.id, appt);
    return { ok: true, appointment: { ...appt } };
  }

  private ownAppointment(patientId: string, appointmentId: string): Appointment | string {
    const a = this.appts.get(appointmentId);
    if (!a || a.patientId !== patientId) return `Patient ${patientId} has no appointment ${appointmentId}.`;
    if (a.status !== "booked") return `Appointment ${appointmentId} is already cancelled.`;
    return a;
  }

  reschedule(patientId: string, appointmentId: string, newSlotId: string): Write {
    const a = this.ownAppointment(patientId, appointmentId);
    if (typeof a === "string") return { ok: false, error: a };
    const slot = this.checkSlot(newSlotId, a.visitType);
    if (typeof slot === "string") return { ok: false, error: slot };
    Object.assign(a, { slotId: slot.id, provider: slot.provider, start: slot.start });
    return { ok: true, appointment: { ...a } };
  }

  cancel(patientId: string, appointmentId: string): Write {
    const a = this.ownAppointment(patientId, appointmentId);
    if (typeof a === "string") return { ok: false, error: a };
    a.status = "cancelled";
    return { ok: true, appointment: { ...a } };
  }

  /** Remembers which logged action changed an appointment, so a net change can be traced to it. */
  touch(appointmentId: string, actionIndex: number): void {
    this.touched.set(appointmentId, [...(this.touched.get(appointmentId) ?? []), actionIndex]);
  }

  /**
   * What is different in the calendar now compared to before the call. A visit booked and then moved
   * during the call counts as one booking at its final time; one booked and cancelled counts as nothing.
   */
  changes(): CalendarChange[] {
    const out: CalendarChange[] = [];
    for (const a of this.appts.values()) {
      const before = this.initial.get(a.id);
      const actions = this.touched.get(a.id) ?? [];
      const at = { slotId: a.slotId, provider: a.provider, start: a.start, visitType: a.visitType };
      if (!before) {
        if (a.status === "booked") out.push({ op: "book", patientId: a.patientId, appointmentId: a.id, ...at, actions });
      } else if (before.status === "booked" && a.status === "cancelled") {
        out.push({ op: "cancel", patientId: a.patientId, appointmentId: a.id, actions });
      } else if (a.status === "booked" && a.slotId !== before.slotId) {
        out.push({ op: "reschedule", patientId: a.patientId, appointmentId: a.id, ...at, actions });
      }
    }
    return out;
  }
}
