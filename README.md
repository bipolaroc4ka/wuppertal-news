# Wuppertal News Automation

Система сбора, фильтрации, перевода и модерации новостей Вупперталя для Telegram-канала @schwebezeit. Работает только на Cloudflare (Workers, Cron Triggers, D1). Архитектура описана в `ARCHITECTURE.md`.

## Состояние проекта

Этап 1 из 8: инфраструктура. Сейчас в проекте есть:
- Worker с эндпоинтом `GET /health`;
- cron каждую минуту (heartbeat, подсчёт источников, у которых подошло время проверки) и ежедневное обслуживание в 03:00 UTC;
- схема D1 (все таблицы из ТЗ) и начальные данные: 8 источников (выключены) и настройки по умолчанию.

Сбор новостей, AI и Telegram появятся на следующих этапах. Публикация без одобрения администратора запрещена на всех этапах.

## Требования

- Node.js 20 или новее и npm.
- Аккаунт Cloudflare (достаточно бесплатного плана).

## Первый запуск

1. Установить зависимости:

```bash
npm install
```

2. Войти в Cloudflare:

```bash
npx wrangler login
```

3. Создать базу D1:

```bash
npx wrangler d1 create wuppertal-news
```

В выводе будет `database_id`. Вставьте его в `wrangler.jsonc` вместо `REPLACE_WITH_DATABASE_ID`.

4. Применить миграции к удалённой базе:

```bash
npm run db:migrate:remote
```

5. Развернуть Worker:

```bash
npm run deploy
```

Wrangler выведет адрес вида `https://wuppertal-news.<ваш-поддомен>.workers.dev`.

6. Проверить:

```bash
curl https://wuppertal-news.<ваш-поддомен>.workers.dev/health
```

Ожидаемый ответ: `"ok": true`, `"sources_total": 8`, `"sources_active": 0`. Через минуту после деплоя поле `last_tick_at` заполнится, а `last_tick_age_seconds` будет меньше 120. Это значит, что cron работает.

## Локальная проверка

```bash
npm run db:migrate:local
npm run dev
```

В другом терминале:

```bash
curl http://localhost:8787/health
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
curl http://localhost:8787/health
```

После второго вызова `/health` поле `last_tick_at` заполнено. Ежедневное обслуживание запускается так:

```bash
curl "http://localhost:8787/__scheduled?cron=0+3+*+*+*"
```

## Полезные команды

Логи в реальном времени:

```bash
npm run logs
```

Запрос к базе:

```bash
npx wrangler d1 execute wuppertal-news --remote --command "SELECT name, is_active FROM sources"
```

Пауза и возобновление сбора (до появления команд Telegram):

```bash
npx wrangler d1 execute wuppertal-news --remote --command "UPDATE settings SET value='1' WHERE key='paused'"
npx wrangler d1 execute wuppertal-news --remote --command "UPDATE settings SET value='0' WHERE key='paused'"
```

Проверка типов:

```bash
npm run typecheck
```

## Загрузка на GitHub

```bash
git init
git add .
git commit -m "Этап 1: инфраструктура"
git branch -M main
git remote add origin https://github.com/<ваш-аккаунт>/<репозиторий>.git
git push -u origin main
```

В репозиторий не попадают `node_modules`, `.wrangler` и файлы с секретами (`.dev.vars`, `.env`). Токены Telegram и Claude API в коде и в Git не хранятся: на этапах 4 и 5 они добавляются командой `npx wrangler secret put`.

## Лимиты Cloudflare Free, которые учтены

- 10 мс CPU на вызов: каждый тик делает один небольшой шаг.
- 100 000 запросов Worker в сутки: проект использует около 1 500.
- D1: 100 000 записанных и 5 млн прочитанных строк в сутки. С 01.09.2026 при превышении запросы к D1 падают до 00:00 UTC.
- 5 cron-триггеров на аккаунт: используется 2.

Актуальные значения проверяйте в документации Cloudflare перед запуском.

## Примечания

- `/health` открыт без авторизации и показывает только счётчики и время последнего тика. Секретов в ответе нет.
- Значения `compatibility_date` и версий пакетов в `package.json` задавались без доступа к npm. Если `npm install` или `wrangler deploy` сообщат о несовместимости, обновите версии на актуальные.
