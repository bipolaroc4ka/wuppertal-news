import { decodeEntities, stripHtml } from "../utils/text.ts";

export interface FeedItem {
  guid: string | null;
  url: string;
  title: string;
  /** Описание из ленты: чистый текст без HTML. Может быть усечённым анонсом. */
  text: string;
  /** Дата публикации в ISO 8601 (UTC) или null, если её нет или она не разобралась. */
  publishedAt: string | null;
}

const ITEM_RE = /<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;

/** Минимальная длина описания, при которой оно считается достаточным без content:encoded. */
const MIN_DESCRIPTION_CHARS = 40;

function xmlText(raw: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  return cdata ? (cdata[1] ?? "") : decodeEntities(raw);
}

function getTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const m = re.exec(block);
  return m ? xmlText(m[1] ?? "") : null;
}

function getLink(block: string): string | null {
  const text = getTag(block, "link");
  if (text && text.trim()) return text.trim();
  // Atom: <link href="..." rel="alternate"/>
  let fallback: string | null = null;
  for (const m of block.matchAll(/<link\s[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const href = decodeEntities(m[1] ?? "").trim();
    const hasOtherRel = /\srel\s*=\s*["'](?!alternate)/i.test(m[0]);
    if (!hasOtherRel) return href;
    fallback ??= href;
  }
  return fallback;
}

function toIso(raw: string | null): string | null {
  if (!raw) return null;
  const t = Date.parse(raw.trim());
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function pickText(block: string): string {
  const short = stripHtml(getTag(block, "description") ?? getTag(block, "summary") ?? "");
  if (short.length >= MIN_DESCRIPTION_CHARS) return short;
  const long = stripHtml(getTag(block, "content:encoded") ?? getTag(block, "content") ?? "");
  return long.length > short.length ? long : short;
}

/**
 * Разбирает RSS 2.0 и Atom без внешних зависимостей. Берёт не более maxItems записей
 * в порядке ленты. Записи без заголовка или адреса пропускаются.
 * Бросает ошибку, если ответ не похож на ленту (например, HTML-страница с ошибкой).
 */
export function parseFeed(xml: string, maxItems = 50): FeedItem[] {
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml.slice(0, 4000))) {
    throw new Error("Ответ не похож на RSS или Atom");
  }
  const items: FeedItem[] = [];
  for (const m of xml.matchAll(ITEM_RE)) {
    const block = m[2] ?? "";
    const title = stripHtml(getTag(block, "title") ?? "").replace(/\s+/g, " ");
    const url = getLink(block);
    if (!title || !url) continue;
    const guid = (getTag(block, "guid") ?? getTag(block, "id"))?.trim() || null;
    const published =
      getTag(block, "pubDate") ?? getTag(block, "published") ?? getTag(block, "updated") ?? getTag(block, "dc:date");
    items.push({ guid, url, title, text: pickText(block), publishedAt: toIso(published) });
    if (items.length >= maxItems) break;
  }
  return items;
}
