// The scripted caller (the patient on the phone). Each case gives the caller an opening line, how they
// say their name and date of birth, and a few case rules. Rules are checked in order; the first match answers.
// Scripted on purpose: the same words every run, so two agents (or two review rules) can be compared fairly.

import type { PartOfDay } from "./types.ts";
import { MONTHS, spokenDay } from "./util.ts";

export type Say = string | ((agentText: string) => string);

export interface CallerRule {
  if: RegExp | RegExp[]; // all must match the agent's words
  not?: RegExp; // skip the rule if this matches
  say: Say;
  once?: boolean;
  hangUp?: boolean;
  takes?: { part?: PartOfDay }; // set by accept(): the caller has now agreed to a day
}

export interface CallerScript {
  phone: string; // caller ID
  opening: string;
  name: string; // the way the caller says it (may differ from the chart)
  dob: string; // the way the caller says it
  wants?: string; // what the caller says when offered a time that does not fit
  rules: CallerRule[];
}

/** A time of day: "9:00 AM", "1 p.m.", "13:40", "noon". */
export const TIME = /\b\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])|\b\d{1,2}:\d{2}\b|\bnoon\b/i;
/** A specific day: "November 24", "Dec. 7", "the 24th", "11/24", "today", "tomorrow". */
export const DAY_NUMBER = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)\.?\s+\d{1,2}(?!\d)|\b\d{1,2}(st|nd|rd|th)\b|\b\d{1,2}\/\d{1,2}\b|\btoday\b|\btomorrow\b/i;
export const MORNING = /\b(8|9|10|11)(:\d{2})?\s*a\.?m\.?(?![a-z])|\b(0?8|0?9|10|11):\d{2}\b(?!\s*p\.?m)/i;
export const AFTERNOON = /\b(12|1|2|3|4|5)(:\d{2})?\s*p\.?m\.?(?![a-z])|\b(12|13|14|15|16|17):\d{2}\b/i;

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
}

/** Matches the ways an agent can name one of these dates: "November 24", "Nov 24", "24th", "11/24". */
export function onDays(...isoDates: string[]): RegExp {
  const parts = isoDates.map((iso) => {
    const [, m, d] = iso.split("-").map(Number);
    const month = MONTHS[m - 1];
    return `(?:${month}|${month.slice(0, 3)}\\.?)\\s+${d}(?!\\d)|\\b${ordinal(d)}\\b|\\b${m}/${d}\\b`;
  });
  return new RegExp(parts.join("|"), "i");
}

/** Which of these dates the agent named first, so the caller can say which offer they take. */
function firstNamed(text: string, isoDates: string[]): string | undefined {
  let best: { iso: string; at: number } | undefined;
  for (const iso of isoDates) {
    const m = onDays(iso).exec(text);
    if (m && (!best || m.index < best.at)) best = { iso, at: m.index };
  }
  return best?.iso;
}

const PART = { morning: MORNING, afternoon: AFTERNOON };

/** The first time named in the text (after `from`) that fits the part of the day: "9:00 AM". */
function firstTime(text: string, part?: PartOfDay, from = 0): string | undefined {
  const all = [...text.matchAll(new RegExp(TIME.source, "gi"))].filter((m) => !part || PART[part].test(m[0]));
  return (all.find((m) => m.index >= from) ?? all[0])?.[0].replace(/\.$/, "");
}

/** The caller takes an offer on one of these dates (and part of the day, if given), naming the day and time taken. */
export function accept(isoDates: string[], part?: PartOfDay, opts: { words?: RegExp; reply?: string } = {}): CallerRule {
  const day = opts.words ? new RegExp(`${onDays(...isoDates).source}|${opts.words.source}`, "i") : onDays(...isoDates);
  return {
    if: [day, part ? PART[part] : TIME],
    not: /anything else|something else/i,
    takes: { part },
    say: (t) => {
      if (opts.reply) return opts.reply;
      const iso = firstNamed(t, isoDates);
      const at = iso ? onDays(iso).exec(t)!.index : (opts.words?.exec(t)?.index ?? 0);
      const time = firstTime(t, part, at);
      const when = iso ? spokenDay(iso) : (opts.words?.exec(t)?.[0] ?? "that day");
      return `Yes, ${when}${time ? ` at ${time}` : ""} works for me.`;
    },
  };
}

export class ScriptedCaller {
  hungUp = false;
  private used = new Set<number>();
  private agreed?: { part?: PartOfDay }; // the caller already said yes to a day
  private script: CallerScript;

  constructor(script: CallerScript) {
    this.script = script;
  }

  reply(agentText: string): string {
    if (this.hungUp) return "";
    for (const [i, r] of this.script.rules.entries()) {
      if (r.once && this.used.has(i)) continue;
      const all = Array.isArray(r.if) ? r.if : [r.if];
      if (!all.every((re) => re.test(agentText))) continue;
      if (r.not?.test(agentText)) continue;
      this.used.add(i);
      if (r.hangUp) this.hungUp = true;
      if (r.takes) this.agreed = r.takes;
      return typeof r.say === "function" ? r.say(agentText) : r.say;
    }
    return this.generic(agentText);
  }

  private generic(t: string): string {
    const s = this.script;
    if (/anything else|something else|else (i|we) can|else can (i|we)/i.test(t)) return "No, that's all. Thank you.";
    if (/\bname\b|date of birth|birth ?date|\bDOB\b|birthday/i.test(t)) return `It's ${s.name}, date of birth ${s.dob}.`;
    if (TIME.test(t)) {
      if (!DAY_NUMBER.test(t)) {
        if (!this.agreed) return "Sorry, which date would that be?";
        const time = firstTime(t, this.agreed.part);
        return time ? `${time} works for me.` : `No, I need the ${this.agreed.part}.`;
      }
      if (s.wants) return `No, that doesn't work for me. ${s.wants}`;
    }
    if (/phone number|callback number|best number|number to reach/i.test(t)) return `It's ${s.phone}.`;
    if (/\b(goodbye|bye|take care)\b|have a (good|great|nice|wonderful)/i.test(t)) return "Thanks, bye.";
    return "Okay.";
  }
}
