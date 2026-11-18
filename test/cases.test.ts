import assert from "node:assert/strict";
import { test } from "node:test";
import { CASES } from "../src/cases.ts";
import { PATIENTS } from "../src/clinic/data.ts";
import { MockEhr } from "../src/clinic/ehr.ts";

test("20 cases with unique ids, a description, and the traps the eval needs", () => {
  assert.equal(CASES.length, 20);
  assert.equal(new Set(CASES.map((c) => c.id)).size, 20);
  for (const c of CASES) assert.ok(c.title && c.tests, c.id);
  assert.ok(CASES.filter((c) => c.expect.redFlag).length >= 4, "red-flag calls");
  assert.ok(CASES.filter((c) => c.expect.noUrgentEscalation).length >= 2, "control calls");
  assert.ok(CASES.filter((c) => c.expect.changes.length === 0).length >= 8, "calls where nothing may change");
});

test("synthetic data only: fictional 555-01xx phone numbers", () => {
  for (const p of PATIENTS) assert.match(p.phone, /^555-01\d\d$/, p.id);
  for (const c of CASES) assert.match(c.caller.phone, /^555-01\d\d$/, c.id);
});

test("every expected booking or move has at least one free slot that fits", () => {
  for (const c of CASES) {
    const ehr = new MockEhr(c.appointments, { forceFree: c.forceFree });
    for (const e of c.expect.changes) {
      if (e.op === "cancel") continue;
      const visitType = e.visitType ?? c.appointments.find((a) => a.id === e.appointmentId)!.visitType;
      const fits = e.provider!.some((p) => {
        const r = ehr.openSlots({ provider: p, visitType, fromDate: e.dates![0], toDate: e.dates!.at(-1)!, partOfDay: e.partOfDay ?? "any" }, 100);
        return r.ok && r.slots.some((s) => e.dates!.includes(s.start.slice(0, 10)));
      });
      assert.ok(fits, `${c.id} has no free slot for its answer`);
    }
  }
});

test("existing visits in the answer key belong to the right patient", () => {
  for (const c of CASES) {
    for (const e of c.expect.changes) {
      if (!e.appointmentId) continue;
      assert.equal(c.appointments.find((a) => a.id === e.appointmentId)?.patientId, e.patientId, c.id);
    }
  }
});
