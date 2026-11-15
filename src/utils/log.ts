type Level = "info" | "warn" | "error";

/**
 * Структурный лог в одну строку JSON (виден в Workers Logs и `wrangler tail`).
 * В data нельзя передавать токены, ключи API и тексты секретов.
 */
export function log(level: Level, message: string, data?: Record<string, unknown>): void {
  const line = JSON.stringify({ level, message, ...data });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
