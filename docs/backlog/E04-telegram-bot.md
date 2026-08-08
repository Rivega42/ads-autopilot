# E04 — Telegram Bot (Grammy)

**Цель:** Grammy-бот с командами онбординга, апрувами через inline-кнопки, доставкой отчётов.

**Зависимости:** E01, E02, E03.
**DoD эпика:** бот отвечает на `/start`, показывает статус, обрабатывает inline-кнопки апрува, доставляет утренний отчёт по расписанию.

---

## Задачи

- [ ] **T04.01** — Установка `grammy` + `@grammyjs/menu` + `@grammyjs/conversations`
  - **DoD:** зависимости в `package.json`, версии зафиксированы
  - **Files:** `package.json`
  - **P0** · 10м

- [ ] **T04.02** — Bot init (polling для dev, webhook для prod)
  - **DoD:** `src/bot/index.ts` создаёт `Bot`, режим по env `BOT_MODE=polling|webhook`
  - **Files:** `src/bot/index.ts`
  - **P0** · 25м

- [ ] **T04.03** — Webhook endpoint в Fastify
  - **DoD:** `POST /bot/webhook/:secret` принимает update, проверяет secret из env, передаёт в Grammy
  - **Files:** `src/routes/botWebhook.ts`
  - **P0** · 25м

- [ ] **T04.04** — Middleware: логгер апдейтов (без секретов)
  - **DoD:** каждый update пишет строку `[bot] update_id=X type=Y from=@user` в pino
  - **Files:** `src/bot/middleware/logger.ts`
  - **P0** · 15м

- [ ] **T04.05** — Middleware: `adminOnly` (переиспользуем из E03)
  - **DoD:** подключён к чувствительным командам
  - **Files:** `src/bot/index.ts`
  - **P0** · 10м

- [ ] **T04.06** — Команда `/start`
  - **DoD:** приветствие, кнопка «Начать онбординг» (открывает conversation из E07), проверка что клиент ещё не создан
  - **Files:** `src/bot/commands/start.ts` + тест
  - **P0** · 30м

- [ ] **T04.07** — Команда `/status`
  - **DoD:** показывает: подключённые кабинеты, активных кампаний, ожидающих апрувов
  - **Files:** `src/bot/commands/status.ts` + тест
  - **P0** · 30м

- [ ] **T04.08** — Команда `/help`
  - **DoD:** список команд с описанием, HTML-форматирование
  - **Files:** `src/bot/commands/help.ts`
  - **P1** · 15м

- [ ] **T04.09** — Команда `/link yandex`
  - **DoD:** генерит OAuth URL Яндекса, отправляет клиенту, ждёт callback
  - **Files:** `src/bot/commands/link.ts`
  - **P0** · 35м

- [ ] **T04.10** — Команда `/link vk`
  - **DoD:** аналогично Яндексу для VK Ads
  - **Files:** `src/bot/commands/link.ts` (расширить)
  - **P0** · 30м

- [ ] **T04.11** — Обработчик OAuth-callback (HTTP)
  - **DoD:** `/oauth/:provider/callback` обменивает code → token, сохраняет через `CredentialService`, отправляет "Успех" в бота
  - **Files:** `src/routes/oauthCallback.ts` + тесты
  - **P0** · 45м

- [ ] **T04.12** — Callback-роутер для inline-кнопок
  - **DoD:** структура `<domain>:<action>:<entityId>` (например, `approval:accept:clxxx`), диспатчинг по типу
  - **Files:** `src/bot/callbacks/router.ts` + тесты
  - **P0** · 40м

- [ ] **T04.13** — Обработчик `approval:accept`
  - **DoD:** валидирует что PendingApproval существует и не истёк, помечает APPROVED, эмитит событие для дальнейшей обработки
  - **Files:** `src/bot/callbacks/approval.ts` + тест
  - **P0** · 35м

- [ ] **T04.14** — Обработчик `approval:reject`
  - **DoD:** помечает REJECTED, обновляет сообщение в TG (убирает кнопки)
  - **Files:** `src/bot/callbacks/approval.ts`
  - **P0** · 25м

- [ ] **T04.15** — `MessageService.sendReport(chatId, report)`
  - **DoD:** сервис отправки форматированных отчётов (HTML), retry при 429, разбиение >4096 симв
  - **Files:** `src/bot/services/MessageService.ts` + тесты
  - **P0** · 40м

- [ ] **T04.16** — Ограничитель отправок (30 msg/sec Telegram limit)
  - **DoD:** очередь на BullMQ (или простая p-queue), не более 25 msg/sec на бота
  - **Files:** `src/bot/services/rateLimit.ts`
  - **P0** · 30м

- [ ] **T04.17** — Обработка voice/video-note (для будущих отчётов от Романа голосом)
  - **DoD:** транскрипция через Groq Whisper, сохраняется в контексте conversation
  - **Files:** `src/bot/utils/audio.ts`
  - **P2** · 40м

- [ ] **T04.18** — Error handler для бота
  - **DoD:** любая ошибка → лог + сообщение "Что-то сломалось, я передала админу", уведомление админа
  - **Files:** `src/bot/errorHandler.ts`
  - **P0** · 25м

- [ ] **T04.19** — Команда `/pause_all` (админ)
  - **DoD:** ставит на паузу все AI-задачи (флаг в БД), полезно на инциденте
  - **Files:** `src/bot/commands/admin/pauseAll.ts`
  - **P1** · 25м

- [ ] **T04.20** — Команда `/resume_all` (админ)
  - **DoD:** снимает паузу
  - **Files:** `src/bot/commands/admin/resumeAll.ts`
  - **P1** · 15м
