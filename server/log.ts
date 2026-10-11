import { json, nowIso, run } from "./db.ts";

type Level = "debug" | "info" | "warn" | "error";

// Structured logging: one JSON line to stdout, and warn/error persisted to app_log so
// administrators can inspect problems from the dashboard. Callers must never pass
// credentials in `data`; redact() is a last line of defence for common key shapes.
const SECRET_PATTERN = /(sk-ant-[A-Za-z0-9_-]+|api[_-]?key=[^&\s]+|password=[^&\s]+)/gi;
function redact(s: string) {
  return s.replace(SECRET_PATTERN, "[redacted]");
}

export function log(level: Level, area: string, message: string, data?: Record<string, unknown>) {
  const line = { at: nowIso(), level, area, message: redact(message), ...(data ?? {}) };
  if (process.env.LOG_SILENT !== "1" && (level !== "debug" || process.env.LOG_DEBUG === "1")) {
    const out = redact(JSON.stringify(line));
    if (level === "error" || level === "warn") console.error(out);
    else console.log(out);
  }
  if (level === "warn" || level === "error" || (level === "info" && data?.persist)) {
    try {
      run(
        "INSERT INTO app_log (at, level, area, message, data) VALUES (?, ?, ?, ?, ?)",
        line.at,
        level,
        area,
        redact(message),
        data ? redact(json(data)) : null,
      );
    } catch {
      // Database might be unavailable; stdout already has the line.
    }
  }
}
