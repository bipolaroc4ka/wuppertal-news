# Wuppertal News Automation

Система сбора, фильтрации, перевода и модерации новостей Вупперталя для Telegram-канала @schwebezeit. Работает только на Cloudflare (Workers, Cron Triggers, D1). Архитектура описана в `ARCHITECTURE.md`.

## Состояние проекта

Этап 2 из 8: сбор новостей.

Что есть сейчас:
- Worker с эндпоинтом `GET /health`;
- cron каждую минуту: heartbeat и опрос одного источника, у которого подошло время проверки; ежедневное обслуживание в 03:00 UTC;
- сборщик RSS/Atom без внешних зависимостей: условные запросы (ETag, Last-Modified), лимиты размера и времени, запрет перенаправлений на другие домены, экспоненциальная пауза при ошибках;
- сохранение записей в D1 со статусом `new`: каноничный URL, GUID, нормализованный заголовок, хеши, дата публикации;
- схема D1 и 8 источников (все выключены; для Polizei Wuppertal и Feuerwehr Wuppertal адреса RSS проверены и заполнены).

Фильтрация, дедупликация по смыслу, AI и Telegram появятся на следующих этапах. Публикация без одобрения администратора запрещена на всех этапах.

## Требования

- Node.js 20 или новее и npm (для Wrangler).
- Для запуска тестов нужен Node.js 22.6 или новее.
- Аккаунт Cloudflare (достаточно бесплатного плана).

## Первый запуск (если этап 1 ещё не развёрнут)

```bash
npm install
npx wrangler login
npx wrangler d1 create wuppertal-news
```

`database_id` из вывода вставьте в `wrangler.jsonc` вместо `REPLACE_WITH_DATABASE_ID`, затем выполните шаги из раздела «Обновление до этапа 2».

## Обновление до этапа 2

1. Применить новую миграцию (добавляет адреса RSS, ничего не включает):

```bash
npm run db:migrate:remote
```

2. Развернуть Worker:

```bash
npm run deploy
```

3. Проверить `/health`: `sources_active` по-прежнему 0, `last_tick_age_seconds` меньше 120.

## Включение источников

Условия использования Presseportal (на нём публикуют полиция и пожарная служба) разрешают редакционное использование материалов, включая обработку с помощью ИИ. Про RSS-ленты они ничего не говорят. Любое использование в собственных коммерческих целях требует письменного согласия news aktuell GmbH. Если канал коммерческий или станет таким, уточните это заранее. Условия: https://www.presseportal.de/nutzungsbedingungen

Когда решите, включите оба источника:

```bash
npx wrangler d1 execute wuppertal-news --remote --command "UPDATE sources SET is_active=1 WHERE name IN ('Polizei Wuppertal','Feuerwehr Wuppertal')"
```

Через 1-2 минуты проверьте результат:

```bash
npx wrangler d1 execute wuppertal-news --remote --command "SELECT name, is_active, last_success_at, last_error, consecutive_errors, next_check_at FROM sources"
npx wrangler d1 execute wuppertal-news --remote --command "SELECT n.id, s.name, n.status, n.published_orig_at, n.title_orig FROM news n JOIN sources s ON s.id = n.source_id ORDER BY n.id DESC LIMIT 10"
```

Ожидается: у обоих источников заполнено `last_success_at`, `last_error` пусто, в `news` появились записи со статусом `new`. Лента содержит до 15 последних сообщений, при первом опросе они все попадут в базу; на этапе 3 фильтр по возрасту отсеет устаревшие.

Выключить источник:

```bash
npx wrangler d1 execute wuppertal-news --remote --command "UPDATE sources SET is_active=0 WHERE name='Feuerwehr Wuppertal'"
```

## Замер CPU (критерий этапа 2)

Бесплатный тариф даёт 10 мс CPU на вызов. После включения источников дайте системе поработать 15-30 минут, затем откройте Cloudflare Dashboard: Workers & Pages, wuppertal-news, Metrics. Посмотрите CPU time (медиана и p99) для cron-вызовов, а также ошибки `Exceeded CPU Time Limits`. Время CPU каждого вызова видно и в Workers Logs.

Если p99 стабильно ниже 10 мс, остаёмся на бесплатном тарифе. Если нет, пришлите значения: тогда решим, оптимизировать код или перейти на Workers Paid ($5 в месяц).

## Как добавить другой источник

Нужен адрес RSS или Atom-ленты (на сайте ищите значок RSS или ссылку «RSS»; проверьте, что лента открывается в браузере как XML). Затем:

```bash
npx wrangler d1 execute wuppertal-news --remote --command "INSERT INTO sources (name, url, rss_url, type, check_interval_min, is_active, trust_level) VALUES ('Название', 'https://сайт', 'https://адрес-ленты', 'rss', 15, 1, 2)"
```

Разрешены только https-адреса без IP, localhost и нестандартных портов. Лента не должна перенаправлять на другой домен. Для сайтов без RSS (`type='html'`) сборщик появится позже, только для публичных страниц и без обхода ограничений.

## Локальная проверка и тесты

```bash
npm test
```

17 тестов проверяют парсер RSS/Atom, нормализацию адресов и заголовков, а также весь цикл сборщика на SQLite вместо D1: сохранение, дубли, 304 и ETag, ошибки с паузой, защита от перенаправлений.

Запуск Worker локально:

```bash
npm run db:migrate:local
npm run dev
```

В другом терминале:

```bash
curl http://localhost:8787/health
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

Ежедневное обслуживание:

```bash
curl "http://localhost:8787/__scheduled?cron=0+3+*+*+*"
```

## Полезные команды

Логи в реальном времени:

```bash
npm run logs
```

Пауза и возобновление сбора (до появления команд Telegram):

```bash
npx wrangler d1 execute wuppertal-news --remote --command "UPDATE settings SET value='1' WHERE key='paused'"
npx wrangler d1 execute wuppertal-news --remote --command "UPDATE settings SET value='0' WHERE key='paused'"
```

Журнал ошибок:

```bash
npx wrangler d1 execute wuppertal-news --remote --command "SELECT created_at, scope, message FROM error_log ORDER BY id DESC LIMIT 20"
```

Проверка типов:

```bash
npm run typecheck
```

## Загрузка на GitHub

```bash
git add .
git commit -m "Этап 2: сбор новостей из RSS"
git push
```

В репозиторий не попадают `node_modules`, `.wrangler` и файлы с секретами (`.dev.vars`, `.env`). Токены Telegram и Claude API в коде и в Git не хранятся: на этапах 4 и 5 они добавляются командой `npx wrangler secret put`.

## Лимиты Cloudflare Free, которые учтены

- 10 мс CPU на вызов: каждый тик опрашивает один источник; разбор ленты без внешних библиотек, не более 25 записей за опрос.
- 50 запросов к D1 на вызов: опрос делает около 6 запросов плюс вставки одним batch (до 50 операций при 25 новых записях в ленте).
- 100 000 запросов Worker в сутки: проект использует около 1 500.
- D1: 100 000 записанных и 5 млн прочитанных строк в сутки. С 01.09.2026 при превышении запросы к D1 падают до 00:00 UTC.
- 5 cron-триггеров на аккаунт: используется 2.

Актуальные значения проверяйте в документации Cloudflare перед запуском.

## Примечания

- `/health` открыт без авторизации и показывает только счётчики и время последнего тика. Секретов в ответе нет.
- Лента Presseportal содержит усечённые анонсы (описание обрывается на «...»). Полный текст есть на странице сообщения по ссылке из ленты. Для достоверного перевода анонса может не хватить; решение о загрузке полного текста принимаем на этапе 3.
- Значения `compatibility_date` и версий пакетов в `package.json` выбраны без доступа к npm. Если `npm install` или `wrangler deploy` сообщат о несовместимости, обновите версии на актуальные.
