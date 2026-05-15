## Цель

Личная система задач: плагин Obsidian с нормальным UI (date/time picker, без ручного markdown) + бэкенд на Lovable Cloud, который шлёт пуши в твой Telegram-бот за X минут до дедлайна.

## Архитектура

```
[Obsidian plugin]                    [Lovable Cloud]               [Telegram]
   |                                       |                          |
   |-- POST /api/public/tasks/sync ------->| Supabase: tasks table    |
   |   (push при изменении + full-sync     |                          |
   |    раз в N минут)                     |                          |
   |   header: x-api-key                   |                          |
   |                                       |                          |
   |                              pg_cron (раз в минуту)              |
   |                                       |                          |
   |                              /api/public/cron/notify             |
   |                                       |-- Telegram connector --->| пуш
```

Один пользователь = ты. Авторизация через shared API key, который ты копируешь из Lovable Cloud в настройки плагина. Никакого логина/OAuth.

## Часть 1 — Бэкенд (Lovable проект)

**Включаем Lovable Cloud + Telegram коннектор** (через @BotFather бота уже подключишь к коннектору).

**Схема БД (Supabase):**
- `tasks`
  - `id` uuid PK
  - `obsidian_id` text unique (стабильный id из плагина: hash от vault path + позиция/uuid в frontmatter)
  - `title` text
  - `due_at` timestamptz nullable
  - `notify_minutes_before` int default 15
  - `notified_at` timestamptz nullable (чтобы не дублировать)
  - `completed` boolean default false
  - `vault_path` text (откуда задача, для ссылки)
  - `updated_at` timestamptz
- `settings` (одна строка)
  - `telegram_chat_id` text — твой chat_id, куда слать
  - `default_lead_minutes` int

**Секреты:**
- `PLUGIN_API_KEY` — генерируем, кладём в Lovable secrets, ты копируешь в плагин
- `CRON_SECRET` — для защиты cron-эндпоинта
- Telegram коннектор подключаем через standard_connectors

**Эндпоинты (`src/routes/api/public/...`):**

1. `POST /api/public/tasks/sync` — приём батча задач из плагина
   - проверка `x-api-key === PLUGIN_API_KEY`
   - body: `{ mode: "push" | "full", tasks: Task[] }`
   - upsert по `obsidian_id`; при mode="full" задачи, которых нет в payload, помечаются `completed=true` или удаляются
   - сбрасывает `notified_at`, если `due_at` или `notify_minutes_before` изменились

2. `POST /api/public/cron/notify` — вызывается pg_cron раз в минуту
   - проверка `x-cron-secret`
   - выбирает задачи: `completed=false AND notified_at IS NULL AND now() >= due_at - notify_minutes_before*interval '1 minute'`
   - для каждой: шлёт сообщение через Telegram gateway, ставит `notified_at = now()`

3. `GET /api/public/telegram/webhook` — опционально, чтобы ловить `/start` от тебя и сохранять `chat_id` в `settings` автоматически (или впишешь руками одной insert-командой)

**pg_cron:** настроим один job: `select net.http_post('https://project--{id}.lovable.app/api/public/cron/notify', headers, body)` каждую минуту.

**Простая UI-страница в Lovable** (опционально, на будущее): список задач, ручное редактирование `telegram_chat_id`, отображение лога последних отправок. Без авторизации, но скрыто за тем же `?key=...`.

## Часть 2 — Плагин Obsidian (отдельный репо)

Это пишется отдельно от Lovable, в обычном TS-проекте по официальному Obsidian sample. План плагина:

**Команды:**
- `Add task` — открывает модал с полями: title, дата (нативный календарь), время, lead-time для пуша. Сохраняет в текущий файл блоком:
  ```
  - [ ] {title} <!-- task: id=xxx due=2026-05-20T15:00 notify=15 -->
  ```
- `Edit task at cursor` — парсит блок под курсором, открывает тот же модал.
- `Sync now` — ручной full-sync.

**Парсер:** регуляркой собирает все `- [ ] ... <!-- task: ... -->` из всех md-файлов vault.

**Sync-логика:**
- При сохранении файла (Vault `modify` event) — debounced push изменённых задач.
- Раз в 10 минут — full-sync всего vault → сервер.
- В настройках плагина: `API URL` (https://project--id.lovable.app), `API key`, `Default lead minutes`, `Sync interval`.

**UI:** модал на нативных Obsidian-компонентах (`Setting`, `Modal`) + `<input type="datetime-local">`. Минимально, чисто, без лишних зависимостей.

## Что вне скоупа этого Lovable проекта

Сам код плагина Obsidian Lovable не сгенерирует — это десктоп-плагин в отдельном репозитории. В Lovable строим только бэкенд (API + cron + telegram). Плагин я могу описать структурой файлов и кодом отдельно после того, как бэкенд будет готов и ты дашь мне URL + API key.

## Технические детали

- TanStack Start server routes под `/api/public/*` (без auth Lovable, но с проверкой `x-api-key`)
- Telegram через connector gateway (`https://connector-gateway.lovable.dev/telegram/sendMessage`), не прямой Bot API
- Cron — Supabase `pg_cron` + `pg_net`, дёргает наш собственный публичный эндпоинт со стабильного `project--{id}.lovable.app`
- Идемпотентность: `notified_at` гарантирует один пуш на задачу; при изменении `due_at` сбрасывается
- RLS включаем, но трогать таблицы будет только сервер с service role — клиентского доступа нет

## Порядок работ

1. Включить Lovable Cloud
2. Подключить Telegram коннектор
3. Миграция: таблицы `tasks`, `settings`
4. Сгенерировать `PLUGIN_API_KEY` и `CRON_SECRET`, добавить как secrets
5. Реализовать `/api/public/tasks/sync` и `/api/public/cron/notify`
6. Настроить pg_cron job
7. Простая страница-дашборд для просмотра задач и проверки
8. Тебе: вписать свой `telegram_chat_id` в `settings` (через Cloud UI)
9. Тестовый прогон: `curl` в sync → ждём минуту → пуш в телеге
10. Дальше — пишем плагин в отдельном репо