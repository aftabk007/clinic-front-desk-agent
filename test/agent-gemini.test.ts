// Tests the Gemini agent loop with a fake model, so no API key or network is needed.

import { GenerateContentResponse, type GenerateContentParameters, type Part } from "@google/genai";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runGeminiCall, thinkingFor, type GeminiCall } from "../src/agent/agent-gemini.ts";
import { CallSession } from "../src/agent/tools.ts";
import { getCase } from "../src/cases.ts";

const call = (name: string, args: Record<string, unknown>): Part => ({ functionCall: { id: `fc_${name}`, name, args }, thoughtSignature: "sig" });

function response(parts: Part[], finishReason = "STOP"): GenerateContentResponse {
  return Object.assign(new GenerateContentResponse(), {
    candidates: [{ content: { role: "model", parts }, finishReason }],
    usageMetadata: { promptTokenCount: 120, cachedContentTokenCount: 100, candidatesTokenCount: 15, thoughtsTokenCount: 40 },
  });
}

function scripted(turns: Array<[Part[], string?]>): { send: GeminiCall; sent: GenerateContentParameters[] } {
  const sent: GenerateContentParameters[] = [];
  let i = 0;
  const send: GeminiCall = async (params) => {
    sent.push(structuredClone(params));
    const [parts, finish] = turns[Math.min(i++, turns.length - 1)];
    return response(parts, finish);
  };
  return { send, sent };
}

test("gemini loop: verifies, books, returns tool errors, keeps thought signatures, ends the call", async () => {
  const s = new CallSession(getCase("c01"));
  const { send, sent } = scripted([
    [[call("say", { text: "Sure. May I have your full name and date of birth?" })]],
    [[call("find_patient", { full_name: "Kevin Walsh", date_of_birth: "1980-04-25" })]],
    [[call("say", { text: "I have Monday, November 23 at 9:40 AM with Dr. Raman. Does that work?" })]],
    [[
      call("book_appointment", { patient_id: "P1011", slot_id: "raman-20261123-0940", visit_type: "follow_up", reason: "blood pressure", confidence: 0.95, evidence: "Yes" }),
      call("book_appointment", { patient_id: "P1011", slot_id: "raman-20261123-0940", visit_type: "follow_up", reason: "again", confidence: 0.95, evidence: "Yes" }),
    ]],
    [[{ text: "thinking out loud" }], "MALFORMED_FUNCTION_CALL"],
    [[call("end_call", { summary: "booked" })]],
  ]);

  const r = await runGeminiCall(s, { model: "gemini-test", effort: "low", maxTurns: 20, send });

  assert.equal(r.outcome, "completed");
  assert.deepEqual(r.verified.map((v) => v.patientId), ["P1011"]);
  assert.deepEqual(r.changes.map((c) => [c.op, c.slotId]), [["book", "raman-20261123-0940"]]);
  assert.deepEqual(r.usage, { input: 120, output: 330, cacheRead: 600 });

  const contents = sent.at(-1)!.contents as Array<{ role: string; parts: Part[] }>;
  assert.equal(contents[1].role, "model");
  assert.equal(contents[1].parts[0].thoughtSignature, "sig");
  // The second booking of the same slot came back as an error, matched to the call id.
  const bookResults = contents.find((c) => c.parts.filter((p) => p.functionResponse?.name === "book_appointment").length === 2)!;
  assert.ok(bookResults.parts[1].functionResponse!.response!.error);
  assert.ok(contents.some((c) => c.parts.some((p) => /could not be read/.test(p.text ?? ""))));
  assert.equal(sent.at(-1)!.config!.toolConfig!.functionCallingConfig!.mode, "ANY");
});

test("gemini loop: the opening message has caller ID and the caller's words, the system prompt has no case data", async () => {
  const s = new CallSession(getCase("c16"));
  const { send, sent } = scripted([[[call("end_call", { summary: "x" })]]]);
  await runGeminiCall(s, { model: "gemini-test", effort: "low", maxTurns: 3, send });
  const first = (sent[0].contents as Array<{ parts: Part[] }>)[0].parts[0].text!;
  assert.match(first, /Caller ID: 555-0105\. Chart\(s\) with this phone number: Robert Chen \(P1005\)/);
  assert.match(first, /this is Linda Chen/);
  assert.doesNotMatch(String(sent[0].config!.systemInstruction), /Linda|Robert|P10\d\d/);
});

test("gemini loop: a safety block stops the call as a refusal", async () => {
  const { send } = scripted([[[], "SAFETY"]]);
  const r = await runGeminiCall(new CallSession(getCase("c01")), { model: "gemini-test", effort: "low", maxTurns: 5, send });
  assert.equal(r.outcome, "refusal");
});

test("thinking settings depend on the model generation", () => {
  assert.deepEqual(thinkingFor("gemini-2.5-flash", "low"), { thinkingBudget: 512 });
  assert.deepEqual(thinkingFor("gemini-3.5-flash-lite", "low"), { thinkingLevel: "LOW" });
  assert.equal(thinkingFor("gemma-3-27b-it", "low"), undefined);
});
