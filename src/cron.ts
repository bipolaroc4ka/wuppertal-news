import type { Env } from "./env";
import { getSetting, setSetting } from "./db/settings";
import { logError, purgeOldErrors } from "./db/errors";
import { log } from "./utils/log";
import { nowIso } from "./utils/time";

/** Расписание из wrangler.jsonc: ежедневное обслуживание. */
export const CRON_DAILY = "0 3 * * *";

/** Сколько дней хранить журнал ошибок. */
const ERROR_LOG_RETENTION_DAYS = 30;

export async function handleScheduled(event: ScheduledController, env: Env): Promise<void> {
  const scope = `cron:${event.cron}`;
  try {
    if (event.cron === CRON_DAILY) {
      await runDailyMaintenance(env);
    } else {
      await runTick(env);
    }
  } catch (e) {
    await logError(env.DB, scope, e, true);
  }
}

/**
 * Тик конвейера (каждую минуту). На этапе 1 фиксирует heartbeat и считает
 * источники, у которых наступило время проверки. Сбор новостей добавляется на этапе 2.
 */
async function runTick(env: Env): Promise<void> {
  const paused = (await getSetting(env.DB, "paused")) === "1";
  await setSetting(env.DB, "last_tick_at", nowIso());
  if (paused) {
    log("info", "tick_paused");
    return;
  }
  const row = await env.DB
    .prepare(
      "SELECT COUNT(*) AS due FROM sources WHERE is_active = 1 AND next_check_at <= datetime('now')",
    )
    .first<{ due: number }>();
  log("info", "tick", { sources_due: row?.due ?? 0 });
}

/** Ежедневное обслуживание (03:00 UTC): чистка журнала ошибок. */
async function runDailyMaintenance(env: Env): Promise<void> {
  const removed = await purgeOldErrors(env.DB, ERROR_LOG_RETENTION_DAYS);
  await setSetting(env.DB, "last_maintenance_at", nowIso());
  log("info", "maintenance_done", { error_log_removed: removed });
}
