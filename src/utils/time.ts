/** Текущее время в формате ISO 8601 (UTC). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Возраст ISO-метки в секундах; null, если метка пустая или некорректная. */
export function ageSeconds(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}
