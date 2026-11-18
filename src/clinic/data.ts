// The synthetic clinic: three providers, made-up patients, and four weeks of 40-minute slots.
// Names, dates of birth and 555-01xx phone numbers are invented. No real patients or clinics.

import type { Patient, Provider, ProviderId, Slot } from "../types.ts";
import { addDays, TODAY, weekday } from "../util.ts";

export const CLINIC_NAME = "Demo Internal Medicine & Cardiology";

export const PROVIDERS: Provider[] = [
  { id: "raman", name: "Dr. Priya Raman", specialty: "internal medicine", visitTypes: ["follow_up", "annual_physical", "sick_visit", "new_patient"] },
  { id: "okafor", name: "Dr. Daniel Okafor", specialty: "internal medicine", visitTypes: ["follow_up", "annual_physical", "sick_visit", "new_patient"] },
  { id: "brooks", name: "Dr. Helen Brooks", specialty: "cardiology", visitTypes: ["follow_up", "new_patient"] },
];

export const PATIENTS: Patient[] = [
  { id: "P1001", name: "Maria Gomez", dob: "1985-03-03", phone: "555-0101", pcp: "raman" },
  { id: "P1002", name: "James Miller", dob: "1972-11-09", phone: "555-0102", pcp: "okafor" },
  { id: "P1003", name: "James Miller", dob: "1990-02-14", phone: "555-0103", pcp: "raman" },
  { id: "P1004", name: "Aisha Rahman", dob: "1987-06-21", phone: "555-0104", pcp: "raman" },
  { id: "P1005", name: "Robert Chen", dob: "1958-08-30", phone: "555-0105", pcp: "okafor" },
  { id: "P1006", name: "Linda Chen", dob: "1961-01-12", phone: "555-0161", pcp: "okafor" },
  { id: "P1007", name: "Thomas Becker", dob: "1990-07-04", phone: "555-0107", pcp: "okafor" },
  { id: "P1008", name: "Grace Liu", dob: "1949-05-17", phone: "555-0108", pcp: "raman" },
  { id: "P1009", name: "Samuel Ortiz", dob: "1966-09-02", phone: "555-0109", pcp: "okafor" },
  { id: "P1010", name: "Nora Feld", dob: "1995-12-01", phone: "555-0110", pcp: "raman" },
  { id: "P1011", name: "Kevin Walsh", dob: "1980-04-25", phone: "555-0111", pcp: "raman" },
  { id: "P1012", name: "Emily Park", dob: "2001-10-10", phone: "555-0112", pcp: "okafor" },
  { id: "P1013", name: "Harold Price", dob: "1953-03-28", phone: "555-0113", pcp: "raman" },
  { id: "P1014", name: "Diane Moss", dob: "1970-07-19", phone: "555-0114", pcp: "okafor" },
  { id: "P1015", name: "Victor Hale", dob: "1983-01-30", phone: "555-0115", pcp: "okafor" },
  { id: "P1016", name: "Rosa Delgado", dob: "1977-08-08", phone: "555-0116", pcp: "raman" },
  { id: "P1017", name: "Paul Nguyen", dob: "1962-02-11", phone: "555-0117", pcp: "okafor" },
  { id: "P1018", name: "Laura Kim", dob: "1988-09-14", phone: "555-0118", pcp: "raman" },
  { id: "P1019", name: "Omar Haddad", dob: "1975-12-20", phone: "555-0119", pcp: "raman" },
  { id: "P1020", name: "Megan Ross", dob: "1998-04-03", phone: "555-0120", pcp: "raman" },
  { id: "P1021", name: "Frank Ibe", dob: "1960-10-30", phone: "555-0121", pcp: "raman" },
  { id: "P1022", name: "Gary Moss", dob: "1968-02-02", phone: "555-0114", pcp: "okafor" },
];

export const SLOT_TIMES = ["09:00", "09:40", "10:20", "11:00", "13:00", "13:40", "14:20", "15:00", "15:40"];
export const LAST_DAY = "2026-12-11";
export const CLOSED_DAYS: Record<string, string> = { "2026-11-26": "Thanksgiving" };

export function providerById(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function slotId(provider: ProviderId, date: string, time: string): string {
  return `${provider}-${date.replace(/-/g, "")}-${time.replace(":", "")}`;
}

export function parseSlotId(id: string): Slot | undefined {
  const m = /^(raman|okafor|brooks)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(id);
  if (!m) return undefined;
  const slot: Slot = { id, provider: m[1] as ProviderId, start: `${m[2]}-${m[3]}-${m[4]}T${m[5]}:${m[6]}` };
  return allSlots().some((s) => s.id === id) ? slot : undefined;
}

let cached: Slot[] | undefined;

/** Every slot on the calendar, free or not: weekdays from today to LAST_DAY, except closed days. */
export function allSlots(): Slot[] {
  if (cached) return cached;
  const out: Slot[] = [];
  for (let d = TODAY; d <= LAST_DAY; d = addDays(d, 1)) {
    if (["Saturday", "Sunday"].includes(weekday(d)) || CLOSED_DAYS[d]) continue;
    for (const p of PROVIDERS) {
      for (const t of SLOT_TIMES) out.push({ id: slotId(p.id, d, t), provider: p.id, start: `${d}T${t}` });
    }
  }
  cached = out;
  return out;
}

/** About half the slots are already taken by other (unseen) patients. Fixed by a hash, so runs repeat. */
export function takenByOthers(id: string): boolean {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return h % 100 < 55;
}
