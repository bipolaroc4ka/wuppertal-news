-- Начальные источники и настройки.
-- Все источники добавлены ВЫКЛЮЧЕННЫМИ (is_active = 0) и без rss_url:
-- адреса RSS и условия использования каждого сайта проверяются на этапе 2,
-- после чего источник включается отдельной командой UPDATE.

INSERT OR IGNORE INTO sources (name, url, rss_url, type, check_interval_min, is_active, trust_level) VALUES
  ('Radio Wuppertal',        'https://www.radiowuppertal.de',            NULL, 'rss', 15, 0, 2),
  ('WDR',                    'https://www1.wdr.de/nachrichten',          NULL, 'rss', 15, 0, 2),
  ('Wuppertaler Rundschau',  'https://www.wuppertaler-rundschau.de',     NULL, 'rss', 15, 0, 2),
  ('Westdeutsche Zeitung',   'https://www.wz.de/nrw/wuppertal',          NULL, 'rss', 15, 0, 2),
  ('WSW',                    'https://www.wsw-online.de',                NULL, 'rss', 15, 0, 1),
  ('Stadt Wuppertal',        'https://www.wuppertal.de',                 NULL, 'rss', 15, 0, 1),
  ('Polizei Wuppertal',      'https://wuppertal.polizei.nrw',            NULL, 'rss', 15, 0, 1),
  ('Feuerwehr Wuppertal',    'https://www.wuppertal.de',                 NULL, 'html', 15, 0, 1);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('paused', '0'),
  ('channel', '@schwebezeit'),
  ('admin_user_id', ''),
  ('moderation_chat_id', ''),
  ('ai_default_model', 'claude-haiku-5-5'),
  ('ai_escalation_model', 'claude-sonnet-5-5'),
  ('ai_max_requests_day', '150'),
  ('ai_max_tokens_day', '300000'),
  ('ai_budget_month_usd', '10'),
  ('ai_max_input_chars', '6000'),
  ('ai_max_output_tokens', '900'),
  ('max_age_hours', '48');
