const TRACKING_PARAM = /^(utm_.+|fbclid|gclid|mc_cid|mc_eid|ref_src|cmpid|wt_mc|at_medium|at_campaign)$/i;

/**
 * Приводит адрес к каноническому виду для сравнения: https, без www и фрагмента,
 * без трекинговых параметров, параметры отсортированы, без завершающего слэша.
 * Возвращает null для некорректных адресов и схем, кроме http/https.
 */
export function canonicalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;

  for (const key of Array.from(u.searchParams.keys())) {
    if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
  }
  u.searchParams.sort();

  const host = u.host.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") || "/" : u.pathname;
  const query = u.searchParams.toString();
  return `https://${host}${path}${query ? `?${query}` : ""}`;
}

/**
 * Проверяет адрес ленты перед запросом: только https, стандартный порт,
 * не localhost и не IP-адрес. Возвращает разобранный URL или бросает ошибку.
 */
export function assertAllowedFeedUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Некорректный адрес ленты");
  }
  if (u.protocol !== "https:") throw new Error("Разрешён только https");
  if (u.port !== "") throw new Error("Нестандартный порт запрещён");
  if (u.username !== "" || u.password !== "") throw new Error("Адрес с логином запрещён");
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Локальные адреса запрещены");
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) {
    throw new Error("IP-адреса запрещены");
  }
  return u;
}
