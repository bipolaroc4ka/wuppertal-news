import type { Env } from "../env.ts";
import { logError } from "../db/errors.ts";
import { log } from "../utils/log.ts";
import { assertAllowedFeedUrl, canonicalizeUrl } from "../utils/url.ts";
import { normalizeBody, normalizeTitle, truncate } from "../utils/text.ts";
import { sha256Hex } from "../utils/hash.ts";
import { parseFeed } from "./parser.ts";
import type { FeedItem } from "./parser.ts";

/**
 * Лимиты выбраны под Workers Free: не более 50 запросов к D1 на вызов.
 * Один опрос делает около 6 запросов плюс по 2 вставки на новую запись (одним batch).
 */
const MAX_ITEMS_PER_POLL = 25;
const MAX_FEED_BYTES = 2_000_000;
const MAX_BODY_CHARS = 8000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MIN = 360;
const CRITICAL_AFTER_ERRORS = 5;
const USER_AGENT = "WuppertalNewsBot/0.2 (RSS reader)";

interface SourceRow {
  id: number;
  name: string;
  url: string;
  rss_url: string | null;
  type: string;
  check_interval_min: number;
  etag: string | null;
  last_modified: string | null;
  consecutive_errors: number;
}

export interface PollResult {
  source: string;
  status: "ok" | "not_modified" | "error" | "skipped";
  found: number;
  inserted: number;
  error?: string;
}

interface FetchedFeed {
  notModified: boolean;
  body: string;
  etag: string | null;
  lastModified: string | null;
}

interface PreparedItem {
  item: FeedItem;
  canonical: string;
  titleNorm: string;
  body: string;
  titleHash: string;
  contentHash: string;
}

/**
 * Опрашивает ОДИН источник, у которого наступило время проверки.
 * Источник «занимается» атомарным UPDATE: next_check_at сдвигается сразу,
 * поэтому параллельные или повторные вызовы не опрашивают его дважды.
 * Возвращает null, если проверять нечего.
 */
export async function pollNextSource(env: Env): Promise<PollResult | null> {
  const source = await claimDueSource(env.DB);
  if (!source) return null;

  if (!source.rss_url || source.type !== "rss") {
    const reason = "Источник не поддерживается: нужен type='rss' и заполненный rss_url";
    await env.DB
      .prepare("UPDATE sources SET is_active = 0, last_error = ?1 WHERE id = ?2")
      .bind(reason, source.id)
      .run();
    await logError(env.DB, `source:${source.name}`, reason);
    return { source: source.name, status: "skipped", found: 0, inserted: 0, error: reason };
  }

  const started = Date.now();
  try {
    const fetched = await fetchFeed(source.rss_url, source);
    if (fetched.notModified) {
      await markSuccess(env.DB, source.id, source.etag, source.last_modified);
      log("info", "source_not_modified", { source: source.name });
      return { source: source.name, status: "not_modified", found: 0, inserted: 0 };
    }
    const items = parseFeed(fetched.body, MAX_ITEMS_PER_POLL);
    const inserted = await storeItems(env.DB, source.id, items);
    await markSuccess(env.DB, source.id, fetched.etag, fetched.lastModified);
    log("info", "source_polled", {
      source: source.name,
      found: items.length,
      inserted,
      wall_ms: Date.now() - started,
    });
    return { source: source.name, status: "ok", found: items.length, inserted };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await markFailure(env.DB, source, e);
    return { source: source.name, status: "error", found: 0, inserted: 0, error: message };
  }
}

async function claimDueSource(db: D1Database): Promise<SourceRow | null> {
  return db
    .prepare(
      `UPDATE sources
         SET next_check_at = datetime('now', '+' || check_interval_min || ' minutes'),
             last_checked_at = datetime('now')
       WHERE id = (
         SELECT id FROM sources
         WHERE is_active = 1 AND next_check_at <= datetime('now')
         ORDER BY next_check_at
         LIMIT 1
       )
       RETURNING id, name, url, rss_url, type, check_interval_min, etag, last_modified, consecutive_errors`,
    )
    .first<SourceRow>();
}

async function fetchFeed(rssUrl: string, source: SourceRow): Promise<FetchedFeed> {
  const feedUrl = assertAllowedFeedUrl(rssUrl);
  const headers = new Headers({
    "User-Agent": USER_AGENT,
    Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
  });
  if (source.etag) headers.set("If-None-Match", source.etag);
  if (source.last_modified) headers.set("If-Modified-Since", source.last_modified);

  const res = await fetch(feedUrl.toString(), {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
  });
  if (res.url && new URL(res.url).hostname !== feedUrl.hostname) {
    throw new Error("Перенаправление на другой домен запрещено");
  }
  if (res.status === 304) {
    return { notModified: true, body: "", etag: source.etag, lastModified: source.last_modified };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_FEED_BYTES) throw new Error("Лента слишком большая");
  const body = await res.text();
  if (body.length > MAX_FEED_BYTES) throw new Error("Лента слишком большая");

  return {
    notModified: false,
    body,
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
  };
}

/**
 * Сохраняет новые записи со статусом 'new'. Дубликаты по каноническому адресу отсекаются
 * проверкой processed_urls и уникальными индексами (url_canonical, source_id+guid).
 * Фильтрация и смысловая дедупликация выполняются на этапе 3.
 * Возвращает число добавленных записей.
 */
async function storeItems(db: D1Database, sourceId: number, items: FeedItem[]): Promise<number> {
  const prepared: PreparedItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const canonical = canonicalizeUrl(item.url);
    if (!canonical || seen.has(canonical)) continue;
    const titleNorm = normalizeTitle(item.title);
    if (!titleNorm) continue;
    seen.add(canonical);
    const body = truncate(item.text, MAX_BODY_CHARS);
    prepared.push({
      item,
      canonical,
      titleNorm,
      body,
      titleHash: await sha256Hex(titleNorm),
      contentHash: await sha256Hex(`${titleNorm}\n${normalizeBody(body)}`),
    });
  }
  if (prepared.length === 0) return 0;

  const placeholders = prepared.map((_, i) => `?${i + 1}`).join(",");
  const known = await db
    .prepare(`SELECT url_canonical FROM processed_urls WHERE url_canonical IN (${placeholders})`)
    .bind(...prepared.map((p) => p.canonical))
    .all<{ url_canonical: string }>();
  const knownSet = new Set(known.results.map((r) => r.url_canonical));

  const fresh = prepared.filter((p) => !knownSet.has(p.canonical));
  if (fresh.length === 0) return 0;
  // Старые записи первыми, чтобы идентификаторы росли в хронологическом порядке.
  fresh.sort((a, b) => (a.item.publishedAt ?? "").localeCompare(b.item.publishedAt ?? ""));

  const statements: D1PreparedStatement[] = [];
  for (const p of fresh) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO news
             (source_id, guid, url, url_canonical, title_orig, body_orig, title_norm,
              title_hash, content_hash, published_orig_at, status)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'new')`,
        )
        .bind(
          sourceId,
          p.item.guid,
          p.item.url,
          p.canonical,
          p.item.title,
          p.body,
          p.titleNorm,
          p.titleHash,
          p.contentHash,
          p.item.publishedAt,
        ),
      db
        .prepare(
          `INSERT OR IGNORE INTO processed_urls (url_canonical, guid, content_hash, news_id)
           SELECT url_canonical, guid, content_hash, id FROM news WHERE url_canonical = ?1`,
        )
        .bind(p.canonical),
    );
  }
  const results = await db.batch(statements);
  let inserted = 0;
  for (let i = 0; i < results.length; i += 2) inserted += results[i]?.meta.changes ?? 0;
  return inserted;
}

async function markSuccess(
  db: D1Database,
  id: number,
  etag: string | null,
  lastModified: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE sources
         SET etag = ?1, last_modified = ?2, last_success_at = datetime('now'),
             last_error = NULL, consecutive_errors = 0
       WHERE id = ?3`,
    )
    .bind(etag, lastModified, id)
    .run();
}

async function markFailure(db: D1Database, source: SourceRow, error: unknown): Promise<void> {
  const errors = source.consecutive_errors + 1;
  const delayMin = Math.min(source.check_interval_min * 2 ** Math.min(errors, 6), MAX_BACKOFF_MIN);
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  await db
    .prepare(
      `UPDATE sources
         SET last_error = ?1, consecutive_errors = ?2,
             next_check_at = datetime('now', '+' || ?3 || ' minutes')
       WHERE id = ?4`,
    )
    .bind(message, errors, delayMin, source.id)
    .run();
  await logError(db, `source:${source.name}`, error, errors === CRITICAL_AFTER_ERRORS);
}
