// Time formatting in the reader's chosen time zone. Publication, retrieval and update
// times are always labelled separately.

/** A short outlet label for inline citations: "BBC News — World" → "BBC News", "AP World (via ABC News)" → "AP". */
export function shortSource(name: string) {
  if (/^AP & Reuters/.test(name)) return "AP/Reuters";
  if (/^AP\b/.test(name)) return "AP";
  return name.replace(/\s+[—–-]\s+.*$/, "").replace(/\s*\(.*\)$/, "").replace(/^The\s+/, "");
}

let zone: string | undefined;
export function setTimeZone(tz: string | undefined) {
  zone = tz || undefined;
}
export function getTimeZone() {
  return zone;
}

export function fmtTime(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: zone });
}
export function fmtDate(iso?: string | null, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { ...opts, timeZone: zone });
}
export function fmtDateTime(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: zone });
}
export function fmtLongDate(d = new Date()) {
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: zone });
}
export function ago(iso?: string | null) {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 0) return "just now";
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} day${d === 1 ? "" : "s"} ago`;
  return fmtDate(iso);
}
export function until(iso?: string | null) {
  if (!iso) return "";
  const s = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (s <= 0) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h} hr`;
  return `in ${Math.round(h / 24)} days`;
}
export function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
/** Only http(s) links are ever rendered as hrefs. */
export function safeHref(url?: string | null) {
  if (!url) return undefined;
  try {
    const u = new URL(url, window.location.origin);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}
