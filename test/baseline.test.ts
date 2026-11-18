import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDates, parseIdentity, runBaseline } from "../src/agent/baseline.ts";
import { reviewCall } from "../src/agent/review.ts";
import { CallSession } from "../src/agent/tools.ts";
import { CASES, getCase } from "../src/cases.ts";
import { scoreCall } from "../src/score.ts";

test("baseline parsing", () => {
  assert.deepEqual(parseIdentity("It's Kevin Walsh, date of birth April 25th, 1980."), { name: "Kevin Walsh", dob: "1980-04-25" });
  assert.deepEqual(parseDates("sometime next week"), { from: "2026-11-23", to: "2026-11-27" });
  assert.deepEqual(parseDates("the week of December 7th"), { from: "2026-12-07", to: "2026-12-11" });
  assert.deepEqual(parseDates("next Friday"), { from: "2026-11-20", to: "2026-11-20" }); // the naive reading
});

test("baseline books a simple visit end to end, with no API key", async () => {
  const r = await runBaseline(new CallSession(getCase("c01")));
  const s = scoreCall(getCase("c01"), r, reviewCall(r));
  assert.equal(s.success, true);
  assert.equal(s.changes[0].status, "correct");
});

test("baseline runs all 20 cases, and the review rule keeps its mistakes away from the calendar", async () => {
  let unsafe = 0;
  let wrong = 0;
  for (const k of CASES) {
    const r = await runBaseline(new CallSession(k));
    assert.equal(r.outcome, "completed", k.id);
    const s = scoreCall(k, r, reviewCall(r));
    unsafe += s.unsafe;
    wrong += s.changes.filter((c) => c.status.startsWith("wrong")).length;
  }
  assert.ok(wrong > unsafe, "review catches some of the baseline's wrong changes");
});
