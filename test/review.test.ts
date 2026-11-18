import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmedBeforeAction, mentionsTime, possibleDuplicate, redFlagWords, reviewCall } from "../src/agent/review.ts";
import { getCase } from "../src/cases.ts";
import { call } from "./helpers.ts";

test("red-flag words are found even when said in passing", () => {
  for (const id of ["c05", "c06", "c07", "c19"]) {
    assert.ok(redFlagWords(getCase(id).caller.opening).length > 0, id);
  }
});

test("'chest X-ray', a cold and a high blood pressure number are not red flags", () => {
  for (const id of ["c08", "c09", "c14"]) assert.deepEqual(redFlagWords(getCase(id).caller.opening), [], id);
});

test("times: 9:00 AM, 9 AM and 13:40 / 1:40 PM", () => {
  assert.ok(mentionsTime("Tuesday at 9 AM", "2026-11-24T09:00"));
  assert.ok(mentionsTime("at 9:00 a.m.", "2026-11-24T09:00"));
  assert.ok(mentionsTime("1:40 PM", "2026-11-24T13:40"));
  assert.ok(!mentionsTime("10:00 AM", "2026-11-24T09:00"));
});

test("a booking counts as confirmed only if the exact day and time got a clear yes", () => {
  const yes = call({
    verified: ["P1011"],
    lines: [["agent", "I have Tuesday, November 24 at 9:00 AM with Dr. Raman. Does that work?"], ["caller", "Yes, that works for me."]],
    actions: [{ op: "book", patientId: "P1011", targetStart: "2026-11-24T09:00", slotId: "raman-20261124-0900" }],
  });
  assert.equal(confirmedBeforeAction(yes, yes.actions[0]), true);
  const noDate = call({
    verified: ["P1016"],
    lines: [["agent", "I can do Friday at 9:00 AM."], ["caller", "Yes, Friday at that time works."]],
    actions: [{ op: "book", patientId: "P1016", targetStart: "2026-11-20T09:00", slotId: "raman-20261120-0900" }],
  });
  assert.equal(confirmedBeforeAction(noDate, noDate.actions[0]), false);
  const changedMind = call({
    verified: ["P1019"],
    lines: [["agent", "Tuesday, November 24 at 2:20 PM?"], ["caller", "Actually, wait. Wednesday the 25th would be better."]],
    actions: [{ op: "book", patientId: "P1019", targetStart: "2026-11-24T14:20", slotId: "raman-20261124-1420" }],
  });
  assert.equal(confirmedBeforeAction(changedMind, changedMind.actions[0]), false);
});

test("review order: red flag, identity, confidence, read-back, duplicate", () => {
  const base = {
    lines: [["agent", "Tuesday, November 24 at 9:00 AM with Dr. Raman?"], ["caller", "Yes, that works for me."]] as Array<["agent" | "caller", string]>,
    actions: [{ op: "book" as const, patientId: "P1001", targetStart: "2026-11-24T09:00", slotId: "raman-20261124-0900" }],
  };
  assert.match(reviewCall(call({ ...base })).actions[0].reason, /not verified/);
  assert.equal(reviewCall(call({ ...base, verified: ["P1001"] })).actions[0].needsReview, false);
  const unsure = call({ ...base, verified: ["P1001"], actions: [{ ...base.actions[0], confidence: 0.6 }] });
  assert.match(reviewCall(unsure).actions[0].reason, /unsure/);
  const dup = call({ ...base, verified: ["P1001"], actions: [{ ...base.actions[0], otherAppointments: [{ id: "A-1101", provider: "raman", start: "2026-11-24T10:20", visitType: "follow_up" }] }] });
  assert.equal(possibleDuplicate(dup.actions[0]), true);
  assert.match(reviewCall(dup).actions[0].reason, /double booking/);
  const flagged = call({ ...base, verified: ["P1001"], lines: [["caller", "My chest feels tight on the stairs."], ...base.lines] });
  assert.match(reviewCall(flagged).actions[0].reason, /red-flag/);
});

test("backstop: red-flag words with no clinical_urgent escalation send the call to staff", () => {
  const missed = reviewCall(call({ lines: [["caller", "I've been short of breath all week."]] }));
  assert.equal(missed.backstop, true);
  assert.equal(missed.sentToStaff, true);
  const handled = reviewCall(call({ lines: [["caller", "I've been short of breath all week."]], escalations: [{ category: "clinical_urgent" }] }));
  assert.equal(handled.backstop, false);
});

test("a yes that asks for another time is not a clear yes (rule-based bot, c12, 18 Nov run)", () => {
  const r = call({
    verified: ["P1015"],
    lines: [["agent", "I have Tuesday, November 17 at 1:00 PM with Dr. Helen Brooks. Does that work?"], ["caller", "Yes, that one. The week after, in the morning, please."]],
    actions: [{ op: "reschedule", patientId: "P1015", targetStart: "2026-11-17T13:00", slotId: "brooks-20261117-1300" }],
  });
  assert.equal(confirmedBeforeAction(r, r.actions[0]), false);
});
