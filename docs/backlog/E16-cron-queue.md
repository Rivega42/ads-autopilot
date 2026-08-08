# E16 — Cron & очереди (BullMQ)

**Цель:** все повторяющиеся задачи (сбор статы, отчёты, оптимизация, refresh токенов) через BullMQ + Redis.

**Зависимости:** E01 (Redis), E02 (репозитории).
**DoD эпика:** все задачи из §10 ТЗ запущены, health-check показывает `queues: healthy`, retries работают.

---

## Задачи

- [ ] **T16.01** — Установка BullMQ + `@bull-board/api` (UI)
  - **DoD:** `bullmq`, `ioredis` в deps; конфиг подключения к Redis
  - **Files:** `package.json`, `src/queue/connection.ts`
  - **P0** · 20м

- [ ] **T16.02** — Базовый Queue Factory
  - **DoD:** `createQueue(name, opts)` — единая точка создания, дефолты: retries=3, backoff=exponential, removeOnComplete=100
  - **Files:** `src/queue/queueFactory.ts`
  - **P0** · 25м

- [ ] **T16.03** — Worker runner
  - **DoD:** `src/queue/worker.ts` — отдельный процесс, регистрирует всех воркеров; запускается через `pnpm worker`
  - **Files:** `src/queue/worker.ts`, `package.json`
  - **P0** · 30м

- [ ] **T16.04** — Cron: сбор статистики каждый час (55 мин)
  - **DoD:** `StatCollectionJob` — для всех активных клиентов вызывает YandexStatCollector + VkStatCollector
  - **Files:** `src/jobs/StatCollectionJob.ts` + тест
  - **P0** · 30м

- [ ] **T16.05** — Cron: refresh VK-токенов каждые 20ч
  - **DoD:** `VkTokenRefreshJob` — вызывает tokenRefresher (из E06)
  - **Files:** `src/jobs/VkTokenRefreshJob.ts`
  - **P0** · 15м

- [ ] **T16.06** — Cron: утренний отчёт 08:00 МСК
  - **DoD:** `DailyReportJob` (из E12) регистрируется в scheduler
  - **Files:** `src/queue/scheduler.ts`
  - **P0** · 20м

- [ ] **T16.07** — Cron: убийство лузеров 03:00 МСК
  - **DoD:** `LosersKillerJob` — вызывает KeywordPauser (из E11)
  - **Files:** `src/jobs/LosersKillerJob.ts`
  - **P0** · 20м

- [ ] **T16.08** — Cron: минус-слова раз в 3 дня
  - **DoD:** `NegativeKeywordsJob` — вызывает NegativeKeywordOptimizer (из E11)
  - **Files:** `src/jobs/NegativeKeywordsJob.ts`
  - **P0** · 15м

- [ ] **T16.09** — Cron: конкурентная разведка воскресенье 20:00
  - **DoD:** `CompetitiveIntelligenceJob` (из E13)
  - **Files:** `src/queue/scheduler.ts`
  - **P0** · 15м

- [ ] **T16.10** — Cron: недельный отчёт пн 09:00
  - **DoD:** `WeeklyReportJob` (из E12)
  - **Files:** `src/queue/scheduler.ts`
  - **P0** · 10м

- [ ] **T16.11** — Cron: истечение PendingApproval через 2ч
  - **DoD:** `ExpiredApprovalsJob` — каждые 5 мин помечает EXPIRED, шлёт уведомление
  - **Files:** `src/jobs/ExpiredApprovalsJob.ts`
  - **P0** · 25м

- [ ] **T16.12** — Cron: polling модерации каждые 15 мин
  - **DoD:** `ModerationPollingJob` вызывает ModerationPoller Yandex+VK
  - **Files:** `src/jobs/ModerationPollingJob.ts`
  - **P0** · 20м

- [ ] **T16.13** — Bull-Board UI (только для админа)
  - **DoD:** `/admin/queues` защищён basicAuth (env `ADMIN_USER`/`ADMIN_PASS`); показывает все очереди
  - **Files:** `src/routes/adminQueues.ts`
  - **P1** · 25м

- [ ] **T16.14** — Health-check очередей
  - **DoD:** `/health` возвращает `queues.<name>: {healthy, waiting, active, failed}`
  - **Files:** `src/routes/health.ts`
  - **P0** · 25м

- [ ] **T16.15** — Алерт на упавшие джобы
  - **DoD:** worker событие `failed` → TG-алерт админу если > 5 fail за 15 мин на 1 очередь
  - **Files:** `src/queue/failureAlerter.ts` + тест
  - **P0** · 30м

- [ ] **T16.16** — Тест: смоук-запуск всех джобов
  - **DoD:** тестовый скрипт триггерит каждый job вручную, ждёт completed
  - **Files:** `tests/smoke/jobs.smoke.ts`
  - **P0** · 40м
