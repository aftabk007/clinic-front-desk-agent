// The front desk agent on Gemini function calling. Each model turn must call at least one tool
// (mode ANY), because on a phone call, text that is not said through a tool is never heard.

import {
  FunctionCallingConfigMode,
  ThinkingLevel,
  type Content,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Part,
  type ThinkingConfig,
} from "@google/genai";
import type { CallOutcome, CallResult } from "../types.ts";
import { systemPrompt } from "./prompt.ts";
import { executeTool, TOOL_SPECS, type CallSession } from "./tools.ts";

/** Sends one request. In the app this is ai.models.generateContent; tests pass a fake. */
export type GeminiCall = (params: GenerateContentParameters) => Promise<GenerateContentResponse>;

export interface GeminiAgentOptions {
  model: string;
  effort: "low" | "medium" | "high";
  maxTurns: number;
  send: GeminiCall;
}

const BLOCKED = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"]);
const RETRYABLE = new Set(["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL"]);

const FUNCTION_DECLARATIONS = TOOL_SPECS.map((t) => ({
  name: t.name,
  description: t.description,
  parametersJsonSchema: t.schema,
}));

/** Gemini 2.x models take a thinking budget in tokens; newer models take a thinking level; Gemma takes neither. */
export function thinkingFor(model: string, effort: GeminiAgentOptions["effort"]): ThinkingConfig | undefined {
  if (/^gemma/.test(model)) return undefined;
  if (/gemini-2\./.test(model)) return { thinkingBudget: { low: 512, medium: 2048, high: 8192 }[effort] };
  return { thinkingLevel: { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH }[effort] };
}

export async function runGeminiCall(session: CallSession, opts: GeminiAgentOptions): Promise<CallResult> {
  const contents: Content[] = [{ role: "user", parts: [{ text: session.start() }] }];
  const config: GenerateContentParameters["config"] = {
    systemInstruction: systemPrompt(),
    tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
    toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } },
    thinkingConfig: thinkingFor(opts.model, opts.effort),
  };
  const usage = { input: 0, output: 0, cacheRead: 0 };
  const started = Date.now();
  let outcome: CallOutcome = "max_turns";
  let error: string | undefined;
  let turns = 0;

  try {
    while (turns < opts.maxTurns) {
      turns++;
      const res = await opts.send({ model: opts.model, contents, config });
      const u = res.usageMetadata;
      const cached = u?.cachedContentTokenCount ?? 0;
      usage.input += (u?.promptTokenCount ?? 0) - cached;
      usage.cacheRead += cached;
      usage.output += (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0);

      const cand = res.candidates?.[0];
      const finish = String(cand?.finishReason ?? "");
      if (res.promptFeedback?.blockReason || BLOCKED.has(finish)) {
        outcome = "refusal";
        error = String(res.promptFeedback?.blockReason ?? finish);
        break;
      }
      // Keep the model's turn exactly as returned: it carries thought signatures Gemini needs back.
      if (cand?.content?.parts?.length) contents.push(cand.content);

      const calls = res.functionCalls ?? [];
      if (calls.length === 0) {
        if (finish === "MAX_TOKENS") {
          outcome = "error";
          error = "The model hit max output tokens without a tool call.";
          break;
        }
        const why = RETRYABLE.has(finish) ? "Your last tool call could not be read. Try again." : "Nothing happens on the line. Only tool calls reach the call.";
        contents.push({ role: "user", parts: [{ text: `[${why}]` }] });
        continue;
      }

      const parts: Part[] = [];
      for (const call of calls) {
        const name = call.name ?? "";
        if (session.ended) {
          parts.push({ functionResponse: { id: call.id, name, response: { output: "[Skipped: the call is over.]" } } });
          continue;
        }
        const out = await executeTool(name, call.args ?? {}, session);
        parts.push({ functionResponse: { id: call.id, name, response: out.isError ? { error: out.text } : { output: out.text } } });
      }
      contents.push({ role: "user", parts });
      if (session.ended) {
        outcome = "completed";
        break;
      }
    }
  } catch (err) {
    outcome = "error";
    error = err instanceof Error ? err.message : String(err);
  }

  return session.result({ agent: `${opts.model} (${opts.effort})`, outcome, error, turns, wallMs: Date.now() - started, usage });
}
