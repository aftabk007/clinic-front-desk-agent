import assert from "node:assert/strict";
import { test } from "node:test";
import { accept, onDays, ScriptedCaller } from "../src/caller.ts";
import { getCase } from "../src/cases.ts";

test("date matching: the ways an agent names a day", () => {
  const re = onDays("2026-11-24");
  for (const t of ["Tuesday, November 24 at 9", "Nov. 24th", "the 24th", "11/24"]) assert.ok(re.test(t), t);
  for (const t of ["November 2", "November 240", "2024"]) assert.ok(!re.test(t), t);
});

test("an accepted offer names the day and time taken", () => {
  const c = new ScriptedCaller({ phone: "", opening: "", name: "A B", dob: "x", wants: "The 23rd.", rules: [accept(["2026-11-23"], "afternoon")] });
  assert.equal(c.reply("Monday, November 23 has 9:00 AM or 1:00 PM."), "Yes, Monday, November 23 at 1:00 PM works for me.");
  assert.equal(c.reply("Which time, 1:00 PM or 3:00 PM?"), "1:00 PM works for me.");
  assert.equal(c.reply("You're booked for Monday, November 23 at 1:00 PM. Anything else?"), "No, that's all. Thank you.");
  assert.equal(c.reply("I have Tuesday, November 24 at 1:00 PM."), "No, that doesn't work for me. The 23rd.");
});

test("a time with no date gets a question back, not a yes", () => {
  const c = new ScriptedCaller({ phone: "", opening: "", name: "A B", dob: "x", rules: [] });
  assert.equal(c.reply("How about 9:00 AM?"), "Sorry, which date would that be?");
});

test("'next Friday': the caller says yes to 'Friday' with no date, corrects the 20th, takes the 27th", () => {
  const c10 = getCase("c10");
  assert.equal(new ScriptedCaller(c10.caller).reply("I can do Friday at 9:00 AM. Does that work?"), "Yes, Friday at that time works.");
  assert.match(new ScriptedCaller(c10.caller).reply("I have Friday, November 20 at 9:00 AM."), /not this Friday/);
  assert.match(new ScriptedCaller(c10.caller).reply("I have Friday, November 27 at 9:00 AM."), /^Yes, Friday, November 27/);
});

test("rules fire once when asked to, and a caller can hang up", () => {
  const c18 = new ScriptedCaller(getCase("c18").caller);
  assert.match(c18.reply("Tuesday, November 24 at 2:20 PM?"), /Actually, wait/);
  assert.match(c18.reply("Tuesday, November 24 at 3:40 PM?"), /Wednesday the 25th now/);
  const c07 = new ScriptedCaller(getCase("c07").caller);
  c07.reply("Please hang up and call 911 now.");
  assert.equal(c07.hungUp, true);
  assert.equal(c07.reply("Hello?"), "");
});
