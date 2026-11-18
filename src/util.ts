// Date and text helpers. The clinic runs on a fixed "today" so every run is the same.

export const TODAY = "2026-11-17"; // a Tuesday
export const NOW = "2026-11-17T10:05";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];

export function weekday(isoDate: string): string {
  return WEEKDAYS[new Date(isoDate.slice(0, 10) + "T00:00:00Z").getUTCDay()];
}

export function addDays(isoDate: string, n: number): string {
  const d = new Date(isoDate.slice(0, 10) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "2026-11-24" -> "Tuesday, November 24" */
export function spokenDay(isoDate: string): string {
  const [, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  return `${weekday(isoDate)}, ${MONTHS[m - 1]} ${d}`;
}

/** "2026-11-24T13:40" -> "1:40 PM" */
export function spokenTime(isoDateTime: string): string {
  const [h, min] = isoDateTime.slice(11, 16).split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(min).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** "1985-03-03" -> "March 3, 1985" */
export function spokenDob(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export function partOfDay(isoDateTime: string): "morning" | "afternoon" {
  return Number(isoDateTime.slice(11, 13)) < 12 ? "morning" : "afternoon";
}

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
}

/** The clinic days (weekdays) from a date, so the agent does not have to do date math alone. */
export function calendarLines(from: string, days: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    const wd = weekday(d);
    if (wd === "Saturday" || wd === "Sunday") continue;
    out.push(`${d} ${wd}${d === from ? " (today)" : ""}`);
  }
  return out;
}
