// Timezone helpers built on Intl (no external tz database needed).

export function isValidTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(date: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute) };
}

/** Convert a wall-clock time in `tz` to a UTC Date. */
export function zonedTimeToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): Date {
  let guess = Date.UTC(y, m - 1, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
    const target = Date.UTC(y, m - 1, d, h, mi);
    guess += target - asUtc;
  }
  return new Date(guess);
}

export const ymd = (p: { y: number; m: number; d: number }) =>
  `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;

export function parseHm(s: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return [6, 0];
  return [Math.min(23, Number(m[1])), Math.min(59, Number(m[2]))];
}

function addDays(p: { y: number; m: number; d: number }, n: number) {
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export interface EditionInfo {
  editionDate: string;
  edition: "morning" | "evening";
  startsAt: Date; // when this edition began
  endsAt: Date; // when the next edition begins (edition is final after this)
}

/** Which edition is current at `now` for a reader in `tz` with the given cutoffs. */
export function currentEdition(now: Date, tz: string, morning: string, evening: string): EditionInfo {
  const p = zonedParts(now, tz);
  const [mh, mm] = parseHm(morning);
  const [eh, em] = parseHm(evening);
  const today = { y: p.y, m: p.m, d: p.d };
  const morningToday = zonedTimeToUtc(p.y, p.m, p.d, mh, mm, tz);
  const eveningToday = zonedTimeToUtc(p.y, p.m, p.d, eh, em, tz);
  if (now >= eveningToday) {
    const t = addDays(today, 1);
    return { editionDate: ymd(today), edition: "evening", startsAt: eveningToday, endsAt: zonedTimeToUtc(t.y, t.m, t.d, mh, mm, tz) };
  }
  if (now >= morningToday) return { editionDate: ymd(today), edition: "morning", startsAt: morningToday, endsAt: eveningToday };
  const y = addDays(today, -1);
  return { editionDate: ymd(y), edition: "evening", startsAt: zonedTimeToUtc(y.y, y.m, y.d, eh, em, tz), endsAt: morningToday };
}

/** Start of the overnight window: `from` (e.g. 20:00) on the evening before the given morning. */
export function overnightStart(edition: EditionInfo, tz: string, from: string): Date {
  const [h, mi] = parseHm(from);
  const p = zonedParts(edition.startsAt, tz);
  const prev = addDays({ y: p.y, m: p.m, d: p.d }, edition.edition === "morning" ? -1 : 0);
  const d = zonedTimeToUtc(prev.y, prev.m, prev.d, h, mi, tz);
  return d < edition.startsAt ? d : new Date(edition.startsAt.getTime() - 12 * 3600_000);
}
