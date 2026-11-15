import type { Env } from "./env";
import { handleScheduled } from "./cron";
import { getSetting } from "./db/settings";
import { logError } from "./db/errors";
import { ageSeconds } from "./utils/time";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function handleHealth(env: Env): Promise<Response> {
  try {
    const counts = await env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM sources) AS sources_total,
           (SELECT COUNT(*) FROM sources WHERE is_active = 1) AS sources_active,
           (SELECT COUNT(*) FROM sources WHERE is_active = 1 AND next_check_at <= datetime('now')) AS sources_due`,
      )
      .first<{ sources_total: number; sources_active: number; sources_due: number }>();
    const lastTick = await getSetting(env.DB, "last_tick_at");
    const lastMaintenance = await getSetting(env.DB, "last_maintenance_at");
    const paused = (await getSetting(env.DB, "paused")) === "1";
    return json({
      ok: true,
      db: "ok",
      paused,
      sources_total: counts?.sources_total ?? 0,
      sources_active: counts?.sources_active ?? 0,
      sources_due: counts?.sources_due ?? 0,
      last_tick_at: lastTick,
      last_tick_age_seconds: ageSeconds(lastTick),
      last_maintenance_at: lastMaintenance,
    });
  } catch (e) {
    await logError(env.DB, "health", e);
    return json({ ok: false, db: "error" }, 503);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return handleHealth(env);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx): Promise<void> {
    ctx.waitUntil(handleScheduled(event, env));
  },
} satisfies ExportedHandler<Env>;
