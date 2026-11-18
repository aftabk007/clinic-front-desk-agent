import assert from "node:assert/strict";
import { test } from "node:test";
import { allSlots, takenByOthers } from "../src/clinic/data.ts";
import { MockEhr } from "../src/clinic/ehr.ts";
import type { Appointment } from "../src/types.ts";

const visit: Appointment = { id: "A-1", patientId: "P1009", slotId: "okafor-20261119-1420", provider: "okafor", start: "2026-11-19T14:20", visitType: "follow_up", reason: "check", status: "booked" };
const free = (ehr: MockEhr, provider: "raman" | "okafor" | "brooks", day: string) => {
  const r = ehr.openSlots({ provider, visitType: "follow_up", fromDate: day, toDate: day, partOfDay: "any" });
  assert.ok(r.ok);
  return r.slots;
};

test("patient lookup needs the exact name and date of birth", () => {
  const ehr = new MockEhr();
  assert.equal(ehr.findPatient("kevin  walsh", "1980-04-25")?.id, "P1011");
  assert.equal(ehr.findPatient("Kevin Walsh", "1980-04-26"), undefined);
  assert.equal(ehr.findPatient("Tom Becker", "1990-07-04"), undefined); // the chart says Thomas
  // Two patients share a name; the date of birth picks the right one.
  assert.equal(ehr.findPatient("James Miller", "1972-11-09")?.id, "P1002");
  assert.equal(ehr.findPatient("James Miller", "1990-02-14")?.id, "P1003");
});

test("the calendar skips weekends and Thanksgiving, and about half the slots are taken", () => {
  const days = new Set(allSlots().map((s) => s.start.slice(0, 10)));
  assert.ok(!days.has("2026-11-21") && !days.has("2026-11-26") && days.has("2026-11-27"));
  const share = allSlots().filter((s) => takenByOthers(s.id)).length / allSlots().length;
  assert.ok(share > 0.4 && share < 0.7, `taken share ${share}`);
});

test("open slots: no past times today, no visit types the provider does not offer", () => {
  const ehr = new MockEhr();
  assert.ok(free(ehr, "raman", "2026-11-17").every((s) => s.start > "2026-11-17T10:05"));
  const r = ehr.openSlots({ provider: "brooks", visitType: "annual_physical", fromDate: "2026-12-07", toDate: "2026-12-11", partOfDay: "any" });
  assert.equal(r.ok, false);
});

test("book, reschedule and cancel, with the checks a real scheduler makes", () => {
  const ehr = new MockEhr([visit]);
  const slot = free(ehr, "okafor", "2026-11-23")[0];
  assert.equal(ehr.book("P1009", visit.slotId, "follow_up", "x").ok, false, "slot is taken");
  assert.equal(ehr.book("P9999", slot.id, "follow_up", "x").ok, false, "unknown patient");
  assert.equal(ehr.reschedule("P1011", "A-1", slot.id).ok, false, "not this patient's visit");
  assert.equal(ehr.reschedule("P1009", "A-1", slot.id).ok, true);
  assert.equal(ehr.isFree(visit.slotId), true, "the old slot is free again");
  assert.equal(ehr.cancel("P1009", "A-1").ok, true);
  assert.equal(ehr.cancel("P1009", "A-1").ok, false, "already cancelled");
});

test("net calendar changes: book-then-move is one booking; book-then-cancel is nothing", () => {
  const ehr = new MockEhr([visit]);
  const [a, b, c] = free(ehr, "raman", "2026-11-24");
  const first = ehr.book("P1011", a.id, "follow_up", "bp");
  assert.ok(first.ok);
  ehr.touch(first.appointment.id, 0);
  ehr.reschedule("P1011", first.appointment.id, b.id);
  ehr.touch(first.appointment.id, 1);
  const gone = ehr.book("P1011", c.id, "follow_up", "x");
  assert.ok(gone.ok);
  ehr.cancel("P1011", gone.appointment.id);
  ehr.reschedule("P1009", "A-1", a.id);
  const changes = ehr.changes();
  assert.deepEqual(changes.map((x) => [x.op, x.slotId]), [["reschedule", a.id], ["book", b.id]]);
  assert.deepEqual(changes[1].actions, [0, 1]);
});
