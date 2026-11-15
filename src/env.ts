/**
 * Привязки Worker. Секреты (токены Telegram и Claude API) добавляются
 * на следующих этапах через `wrangler secret put` и дописываются сюда.
 */
export interface Env {
  DB: D1Database;
}
