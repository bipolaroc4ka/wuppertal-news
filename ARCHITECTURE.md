# Wuppertal News Automation. Архитектура (этап 0)

Дата проверки лимитов: 15.11.2026. Все цифры ниже взяты из документации Cloudflare и Anthropic; перед запуском их нужно сверить ещё раз.

## 1. Проверенные лимиты и что из них следует

| Параметр | Workers Free | Источник |
|---|---|---|
| Запросов в сутки | 100 000 | developers.cloudflare.com/workers/platform/limits |
| CPU на один вызов | 10 мс (ожидание сети и D1 не считается) | там же |
| Subrequests на вызов | 50 | там же |
| Cron Triggers на аккаунт | 5 | там же |
| Длительность cron-вызова | до 15 минут | там же |
| D1: чтение / запись в сутки | 5 млн строк / 100 тыс. строк | developers.cloudflare.com/d1/platform/pricing |
| D1: размер базы / запросов на вызов | 500 МБ / 50 | developers.cloudflare.com/d1/platform/limits |
| Queues | доступны на Free с 04.02.2026, хранение сообщений 24 ч | developers.cloudflare.com/changelog/2026-02-04-queues-free-plan |

Важно:
1. С 01.09.2026 при превышении суточных лимитов D1 запросы реально падают с ошибкой (до 00:00 UTC). Нужен контроль расхода строк.
2. Главный риск бесплатного тарифа: 10 мс CPU на вызов. Сетевые ожидания (fetch, D1, AI, Telegram) CPU не потребляют, но разбор RSS и нормализация текста потребляют. Поэтому один вызов делает один небольшой шаг.
3. Платный тариф ($5/мес) поднимает CPU до 30 с по умолчанию. Это запасной вариант, если 10 мс окажется мало. Решение принимаем по замерам на этапе 2.

## 2. Архитектура

Принцип: никаких долгих задач. Состояние живёт в D1, каждый вызов Worker делает один шаг и завершается. Прерванная работа подхватывается следующим вызовом.

Cron Triggers (2 из 5 доступных):
- `* * * * *` : тик конвейера, раз в минуту.
- `0 3 * * *` : ежедневное обслуживание (чистка, суточная статистика, сброс счётчиков, отчёт админу).

Тик конвейера за один вызов выполняет ровно один шаг в порядке приоритета:
1. Восстановление: задачи с истёкшей блокировкой возвращаются в очередь.
2. Отправка в чат модерации (task `send_moderation`).
3. AI-обработка одной новости из `processing_queue` (task `ai`), если не исчерпаны лимиты.
4. Опрос одного источника, у которого наступил `next_check_at`.

Производительность: 1440 тиков в сутки. Нагрузка: 8 источников по 96 опросов = 768, плюс не более 100 AI-обработок и 100 отправок. Запас большой. Интервал опроса каждого источника (по умолчанию 15 минут) хранится в `sources.check_interval_min`.

Конвейер новости:
```
RSS/HTML -> parser (без AI) -> filter (релевантность, реклама, возраст)
  -> dedup (URL, GUID, заголовок, hash, контекст) -> news (status=queued)
  -> processing_queue(ai) -> AI (1 запрос: анализ+перевод+текст)
  -> news (status=processed) -> send_moderation -> pending
  -> кнопки админа -> approved -> publish -> published
```

Webhook: `POST /telegram/webhook` в том же Worker. Проверка заголовка `X-Telegram-Bot-Api-Secret-Token` (сравнение за постоянное время), затем проверка user ID администратора, затем идемпотентность через `admin_actions.callback_id UNIQUE`.

Защита от двойной публикации: `publications.news_id UNIQUE` и атомарный переход статуса `approved -> publishing` одним UPDATE с проверкой `changes() = 1`.

Защита от параллельной обработки: захват задачи одним `UPDATE ... SET locked_until=? WHERE id=(SELECT ... ) AND (locked_until IS NULL OR locked_until < now) RETURNING *`.

Экономия токенов (всё до AI, на чистом JS): каноникализация URL, GUID, нормализованный заголовок, SimHash/shingles по тексту, словари улиц и районов Вупперталя, стоп-слова рекламы, лимит возраста. В AI уходит только заголовок + очищенный текст до N символов. Системный промпт короткий и неизменный (prompt caching). Ответ в минимальном JSON.

Антиинъекция: текст новости передаётся в блоке `<article>` с инструкцией считать его данными; ответ AI валидируется по схеме; HTML для Telegram экранируется и допускается только `<b>`.

Лимиты расходов (таблица `settings`): `ai_max_requests_day`, `ai_max_tokens_day`, `ai_budget_month_usd`, `ai_max_input_chars`, `ai_max_output_tokens`. При достижении лимита задачи получают статус `waiting_budget`, новости не теряются, админу уходит уведомление (один раз в сутки).

## 3. Структура проекта

```
wuppertal-news/
  package.json
  tsconfig.json
  wrangler.jsonc
  .gitignore
  README.md
  migrations/
    0001_init.sql
    0002_seed_sources_settings.sql
  src/
    index.ts                 точка входа: fetch (webhook, /health) и scheduled
    env.ts                   типы Env и чтение settings
    cron.ts                  тик конвейера и ежедневное обслуживание
    news/
      collectors.ts          опрос источника (RSS/HTML/API), ETag, лимиты размера
      parser.ts              разбор RSS/Atom, очистка HTML
      filter.ts              релевантность, категории, приоритет, реклама, возраст
      deduplication.ts       многоуровневая проверка дублей, склейка источников
      locality.ts            словари Вупперталя (районы, улицы, организации)
    ai/
      client.ts              вызов Claude API, учёт токенов, ретраи
      prompts.ts             системный промпт, версия промпта, JSON-схема ответа
      processor.ts           подготовка входа, валидация ответа, запись результата
      budget.ts              проверка лимитов и расчёт стоимости
    telegram/
      api.ts                 обёртка Bot API (sendMessage, edit, answerCallbackQuery)
      webhook.ts             проверка секрета, маршрутизация update
      commands.ts            /status /stats /sources /pause /resume /help
      moderation.ts          карточка, кнопки, редактирование, повтор обработки
      publisher.ts           публикация в @schwebezeit
      format.ts              безопасный HTML, разбиение длинных текстов (лимит 4096)
    db/
      news.ts  sources.ts  queue.ts  settings.ts  stats.ts  errors.ts
    queue/
      worker.ts              захват, повторы, экспоненциальная задержка, восстановление
    utils/
      hash.ts  url.ts  text.ts  time.ts  safe-compare.ts  log.ts
  scripts/
    set-webhook.mjs          разовая настройка webhook (Node, не серверный runtime)
  test/
    *.test.ts                тесты фильтра, дедупликации, парсера
```

Отличия от ТЗ: добавлены `locality.ts` (словари), `budget.ts`, `format.ts`, `commands.ts`, `env.ts`, тесты. Cloudflare Pages и Queues в версию 1 не входят (см. раздел 6).

## 4. Схема D1 (миграция 0001_init.sql)

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  rss_url TEXT,
  type TEXT NOT NULL CHECK (type IN ('rss','html','api')),
  check_interval_min INTEGER NOT NULL DEFAULT 15,
  is_active INTEGER NOT NULL DEFAULT 1,
  trust_level INTEGER NOT NULL DEFAULT 2,       -- 1 официальный, 2 СМИ, 3 прочее
  etag TEXT,
  last_modified TEXT,
  next_check_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_checked_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sources_due ON sources (is_active, next_check_at);

CREATE TABLE news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  guid TEXT,
  url TEXT NOT NULL,
  url_canonical TEXT NOT NULL,
  title_orig TEXT NOT NULL,
  body_orig TEXT,
  title_norm TEXT NOT NULL,
  title_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  simhash TEXT,
  published_orig_at TEXT,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  category TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  relevance_score REAL,
  filter_reason TEXT,
  duplicate_of INTEGER REFERENCES news(id),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN
    ('new','filtered','queued','processing','processed','pending',
     'approved','rejected','published','error')),
  title_ru TEXT,
  body_ru TEXT,
  ai_warnings TEXT,
  ai_model TEXT,
  prompt_version TEXT,
  ai_input_hash TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  processed_at TEXT,
  moderation_chat_id TEXT,
  moderation_message_id INTEGER,
  edited_text TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX uq_news_canonical ON news (url_canonical);
CREATE UNIQUE INDEX uq_news_guid ON news (source_id, guid) WHERE guid IS NOT NULL;
CREATE INDEX idx_news_title_hash ON news (title_hash);
CREATE INDEX idx_news_content_hash ON news (content_hash);
CREATE INDEX idx_news_status ON news (status, priority DESC, discovered_at);
CREATE INDEX idx_news_published ON news (published_orig_at);

-- Один и тот же материал у нескольких СМИ
CREATE TABLE news_sources (
  news_id INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  url TEXT NOT NULL,
  title TEXT,
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (news_id, url)
);

-- Существенные дополнения к уже известной новости
CREATE TABLE news_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  news_id INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  summary TEXT,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE processed_urls (
  url_canonical TEXT PRIMARY KEY,
  guid TEXT,
  content_hash TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  news_id INTEGER REFERENCES news(id) ON DELETE SET NULL
);

CREATE TABLE processing_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  news_id INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL CHECK (task_type IN ('ai','send_moderation','publish','regenerate')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','running','done','failed','waiting_budget')),
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_after TEXT NOT NULL DEFAULT (datetime('now')),
  locked_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX uq_queue_active ON processing_queue (news_id, task_type)
  WHERE status IN ('pending','running','waiting_budget');
CREATE INDEX idx_queue_next ON processing_queue (status, run_after, priority DESC);

CREATE TABLE publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  news_id INTEGER NOT NULL UNIQUE REFERENCES news(id),
  channel TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('publishing','published','failed')),
  tg_message_id INTEGER,
  text_published TEXT,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT
);

CREATE TABLE admin_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  news_id INTEGER REFERENCES news(id) ON DELETE SET NULL,
  admin_user_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  callback_id TEXT UNIQUE,                      -- идемпотентность callback
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_admin_actions_news ON admin_actions (news_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  news_id INTEGER REFERENCES news(id) ON DELETE SET NULL,
  day TEXT NOT NULL,                            -- YYYY-MM-DD (UTC)
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ai_usage_day ON ai_usage (day);

CREATE TABLE error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,                          -- source:<id>, ai, telegram, cron
  message TEXT NOT NULL,
  critical INTEGER NOT NULL DEFAULT 0,
  notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_error_log_created ON error_log (created_at);
```

Ключи `settings` по умолчанию: `paused=0`, `ai_default_model`, `ai_escalation_model`, `ai_max_requests_day=150`, `ai_max_tokens_day=300000`, `ai_budget_month_usd=10`, `ai_max_input_chars=6000`, `ai_max_output_tokens=900`, `max_age_hours=48`, `admin_user_id`, `moderation_chat_id`, `channel=@schwebezeit`.

Экономия D1: индексы удваивают запись, поэтому индексов столько, сколько нужно для дедупликации и очереди; старые тела `body_orig` обнуляются через 30 дней ежедневной задачей.

## 5. Расчёт расходов

Допущения (оценка, не измерение; уточняется на этапе 4):
- Вход AI: около 1 500 токенов (короткий системный промпт около 500, статья около 1 000).
- Выход: около 700 токенов (русский текст и JSON).
- Повторные обработки и перегенерации: +15% к числу запросов.
- «Новостей в сутки» означает материалы, прошедшие фильтр и дубликаты и дошедшие до AI.
- Цены за 1 млн токенов: Haiku 5.5 $0.10 вход / $0.50 выход (для промптов до 100 тыс. токенов); Sonnet 5.5 $2 / $10. Кэш и Batch API дают дополнительные скидки, здесь не учтены.
- Месяц = 30 дней.

Стоимость одной новости: Haiku 5.5 около $0.0005; Sonnet 5.5 около $0.010.

| Новостей в сутки | AI-запросов в месяц (с повторами) | Только Haiku 5.5 | 90% Haiku + 10% Sonnet |
|---|---|---|---|
| 10 | 345 | около $0.17 | около $0.50 |
| 30 | 1 035 | около $0.52 | около $1.50 |
| 50 | 1 725 | около $0.86 | около $2.50 |
| 100 | 3 450 | около $1.73 | около $5.00 |

Cloudflare (Workers Free + D1 Free), оценка нагрузки в сутки:

| Новостей в сутки | Запросов Worker (из 100 000) | Строк записи D1 (из 100 000) | Строк чтения D1 (из 5 млн) | Итого |
|---|---|---|---|---|
| 10 | около 1 600 | около 3 000 | около 150 000 | $0 |
| 30 | около 1 700 | около 4 500 | около 250 000 | $0 |
| 50 | около 1 800 | около 6 000 | около 350 000 | $0 |
| 100 | около 2 000 | около 9 000 | около 600 000 | $0 |

Основная запись D1 идёт от опросов источников (обновление `sources` 768 раз в сутки с индексом) и тиков очереди, а не от самих новостей. Чтения зависят от дедупликации; все проверки идут по индексам. Если окажется, что 10 мс CPU мало, переход на Workers Paid добавит $5 в месяц (включённые лимиты платного плана D1 значительно больше).

Telegram Bot API бесплатен. Стоимость Anthropic API должна быть сверена на https://platform.claude.com/docs/en/about-claude/pricing перед запуском.

## 6. Решения и альтернативы

1. Очередь на D1 вместо Cloudflare Queues. Проще, не зависит от 24-часового хранения сообщений на Free, всё состояние в одном месте. Queues подключаются позже, если понадобится отдельный вызов (и отдельные 10 мс CPU) на каждый источник.
2. Один бот для модерации и публикации в канал: бот должен быть администратором @schwebezeit с правом публикации. Бот отправляет в приватный чат модерации и в канал.
3. Cloudflare Pages (веб-панель) не входит в версию 1: управление идёт через Telegram-команды.
4. Модель по умолчанию Haiku 5.5, эскалация на Sonnet 5.5 только по явным правилам (приоритет 3, флаг спорных утверждений, повторная обработка по кнопке). Качество русского перевода Haiku проверяем на 20-30 реальных материалах до включения по умолчанию.
5. Для сайтов без RSS (WSW, Stadt Wuppertal, Polizei, Feuerwehr) сначала проверяем наличие RSS/пресс-порталов; HTML-разбор добавляем только для публичных страниц, без обхода ограничений. Robots.txt и условия использования проверяются по каждому источнику на этапе 2.
6. Приватность канала и права бота: перед этапом 5 нужны токен бота, ID чата модерации и ваш Telegram user ID.

## 7. Этапы

1. Инфраструктура: Worker, D1, миграции, Wrangler, cron-тик, `/health`.
2. Сбор: 3-4 источника, RSS, замер CPU на вызов (критерий: укладывается в 10 мс; иначе решаем про платный тариф).
3. Фильтрация и дедупликация без AI, тесты.
4. AI: Claude API, учёт токенов, лимиты, кэш результата.
5. Telegram: webhook, карточки в чат модерации.
6. Модерация: кнопки, редактирование, повтор.
7. Публикация в @schwebezeit.
8. Тестирование: дубли, расходы, восстановление после ошибок.
