// Logging that never carries reminder text or conversation content.
// Paseo copies plugin stdout into the daemon log, which may be readable by
// other users on the host, so only ids, counts and states go out.

export type Fields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
}

function render(level: string, message: string, fields?: Fields): string {
  const parts = fields
    ? Object.entries(fields)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : String(v)}`)
    : [];
  return `[hopkins] ${level} ${message}${parts.length ? ` ${parts.join(" ")}` : ""}`;
}

export const consoleLogger: Logger = {
  info: (m, f) => console.log(render("info", m, f)),
  warn: (m, f) => console.log(render("warn", m, f)),
  error: (m, f) => console.error(render("error", m, f)),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** Error text without stack frames or embedded payloads. */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.split("\n")[0]!.slice(0, 200);
}
