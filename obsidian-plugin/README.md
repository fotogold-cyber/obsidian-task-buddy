# Task Buddy — Obsidian plugin

Чек-листы Obsidian → напоминания в Telegram. UI как в Google Tasks: тап по чекбоксу → снизу всплывает шит с **Сегодня / Завтра / 🕒**.

Работает на десктопе и iOS (`isDesktopOnly: false`).

## Установка через BRAT (iPhone и десктоп)

1. Поставь плагин **BRAT** в Obsidian (Community plugins → Browse → "Obsidian42 - BRAT").
2. Залей содержимое папки `obsidian-plugin/` в отдельный публичный GitHub-репозиторий (или используй сабпуть, BRAT понимает оба).
3. Сделай GitHub release с тэгом `0.1.0`, прикрепи `manifest.json`, `main.js`, `styles.css` (после `npm run build`).
4. В Obsidian: **BRAT → Add Beta plugin → `<your-username>/<repo>`**.
5. Включи плагин в Settings → Community plugins.

## Сборка локально

```bash
cd obsidian-plugin
npm install
npm run build   # создаст main.js
```

Чтобы тестить на ПК — скопируй `manifest.json`, `main.js`, `styles.css` в `<vault>/.obsidian/plugins/obsidian-task-buddy/` и включи плагин.

## Настройки

- **API base URL** — `https://obsidian-task-buddy.lovable.app` (или твой preview URL).
- **API key** — `PLUGIN_API_KEY` из бэка.
- **Алерт по умолчанию** — за сколько минут до дедлайна слать напоминание.
- **Full sync каждые** — периодичность фоновой синхронизации.

## Как работает

- Тап на любой чекбокс `- [ ] Что-то` → снизу шит:
  - **Сегодня** → разворачивается выбор времени и lead.
  - **Завтра** → то же самое, но на завтра.
  - **🕒** → полный выбор даты+времени.
- Нажимаешь «Готово» — плагин:
  - дописывает в строку метаданные `<!--tb:{"d":"...","m":15,"id":"..."}-->`,
  - сразу пушит задачу на бэк (`/api/public/tasks/sync`),
  - дальше pg_cron на бэке за minute_before минут шлёт тебе сообщение в Telegram.
- Корзина в шите — удаляет напоминание (метаданные стираются, на бэке тоже).
- Раз в N минут плагин делает full-sync всех задач с метаданными `tb:`.
