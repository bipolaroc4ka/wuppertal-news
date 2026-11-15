import { log } from "../utils/log";

/** Максимальная длина сообщения в журнале ошибок. */
const MAX_MESSAGE_LENGTH = 1000;

/**
 * Записывает ошибку в error_log. Сама никогда не бросает исключение:
 * сбой журнала не должен ломать основную задачу.
 */
export async function logError(
  db: D1Database,
  scope: string,
  error: unknown,
  critical = false,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_MESSAGE_LENGTH);
  log("error", "task_failed", { scope, message, critical });
  try {
    await db
      .prepare("INSERT INTO error_log (scope, message, critical) VALUES (?1, ?2, ?3)")
      .bind(scope, message, critical ? 1 : 0)
      .run();
  } catch (e) {
    log("error", "error_log_write_failed", {
      scope,
      reason: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Удаляет записи журнала старше указанного числа дней. Возвращает число удалённых строк. */
export async function purgeOldErrors(db: D1Database, days: number): Promise<number> {
  const res = await db
    .prepare("DELETE FROM error_log WHERE created_at < datetime('now', ?1)")
    .bind(`-${Math.max(1, Math.floor(days))} days`)
    .run();
  return res.meta.changes ?? 0;
}
