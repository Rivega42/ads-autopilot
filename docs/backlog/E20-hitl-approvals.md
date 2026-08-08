# E20 — Human-in-the-loop и апрувы

**Цель:** любые изменения выше порога, критичные операции и деньги — только с явным подтверждением Романа/клиента в Telegram. Rollback за 1 клик в течение 30 дней.

**Зависимости:** E02 (БД), E04 (бот), E11 (оптимизатор), E17 (импорт).
**DoD эпика:** ни одно «крупное» действие (>20% бюджета, новая кампания, массовое отключение, изменение стратегии) не уходит в API без явного `approve` от владельца; каждое действие имеет `undo`.

---

## Модель апрувов

- [ ] **T20.01** — Таблица `Approval`
  - **DoD:** Prisma-модель: `id`, `tenantId`, `type` (budget|new_campaign|bulk_disable|strategy_change|import_handover|manual), `payload JSON`, `impact JSON` (что изменится), `status` (pending|approved|rejected|expired|applied|rolled_back), `requestedBy`, `approvedBy`, `expiresAt`, timestamps
  - **Files:** `prisma/schema.prisma` + миграция
  - **P0** · 25м

- [ ] **T20.02** — `ApprovalService.request()`
  - **DoD:** метод: тип + payload + impact → создаёт запись, шлёт в TG инициатору, вешает TTL (default 24ч)
  - **Files:** `src/services/ApprovalService.ts` + тест
  - **P0** · 40м

- [ ] **T20.03** — `ApprovalService.decide()`
  - **DoD:** approve/reject: пишет status, `approvedBy`, `decidedAt`; вызывает executor колбэк при approve
  - **Files:** тот же файл + тест
  - **P0** · 35м

- [ ] **T20.04** — Auto-expire job
  - **DoD:** BullMQ-повторяющаяся задача: каждые 5 мин — `expiresAt < now && status=pending` → status=expired + уведомление
  - **Files:** `src/jobs/expireApprovals.ts` + тест
  - **P1** · 25м

- [ ] **T20.05** — Мидлварь `requireApproval(type, thresholdFn)`
  - **DoD:** декоратор для сервисов: если impact выше порога → создаёт Approval и бросает `ApprovalRequiredError`, action не выполняется до approve
  - **Files:** `src/lib/requireApproval.ts` + тест
  - **P0** · 45м

## Пороги (конфигурируемые)

- [ ] **T20.06** — Табличка `ApprovalThreshold` + сидинг дефолтов
  - **DoD:** per-tenant пороги: budget_change_pct (20), new_campaign (always), bulk_disable_count (10), spend_daily_rub (5000)
  - **Files:** миграция + `prisma/seed.ts`
  - **P0** · 25м

- [ ] **T20.07** — CLI/бот команда `/approval thresholds`
  - **DoD:** показать текущие пороги, изменить любой (через inline-кнопки)
  - **Files:** `src/bot/handlers/thresholds.ts`
  - **P1** · 40м

## Telegram UX

- [ ] **T20.08** — Карточка апрува в TG
  - **DoD:** сообщение: тип, канал, что будет сделано, ожидаемый impact (delta бюджета/CPA/охвата), кнопки `✅ Approve` / `❌ Reject` / `📋 Detail`
  - **Files:** `src/bot/handlers/approval.ts` + шаблон в `src/bot/templates/approval.ts`
  - **P0** · 55м

- [ ] **T20.09** — Кнопка `📋 Detail` → полный JSON diff
  - **DoD:** отдельным сообщением: `before`/`after`, если объектов много — .txt файлом
  - **Files:** тот же handler + тест
  - **P1** · 30м

- [ ] **T20.10** — Инлайновая кнопка `⏰ Отложить на 4ч`
  - **DoD:** `expiresAt += 4h`, статус `pending` сохраняется, лог `postponed`
  - **Files:** approval handler + тест
  - **P2** · 20м

- [ ] **T20.11** — Ежедневный дайджест `/approvals pending`
  - **DoD:** утренний отчёт: сколько pending, самое старое, кто ждёт
  - **Files:** `src/jobs/approvalDigest.ts` + шаблон
  - **P1** · 30м

## Change Log + Rollback

- [ ] **T20.12** — Таблица `ChangeLog`
  - **DoD:** `id`, `tenantId`, `provider`, `entityType`, `entityId`, `action`, `before JSON`, `after JSON`, `approvalId?`, `rolledBackAt?`, `actor`
  - **Files:** миграция
  - **P0** · 20м

- [ ] **T20.13** — Хук на все `Service.mutate*()`
  - **DoD:** любой write в провайдер = запись в ChangeLog (before/after); используем прокси/декоратор
  - **Files:** `src/lib/withChangeLog.ts` + тесты для 3 сервисов
  - **P0** · 50м

- [ ] **T20.14** — `RollbackService.undo(changeId)`
  - **DoD:** если < 30 дней — восстанавливает `before` через провайдер; фиксирует `rolledBackAt`
  - **Files:** `src/services/RollbackService.ts` + тест
  - **P0** · 60м

- [ ] **T20.15** — Bulk rollback: `undoWindow(from, to)`
  - **DoD:** откат всех изменений за интервал; апрув обязателен
  - **Files:** тот же сервис + тест
  - **P1** · 40м

- [ ] **T20.16** — Команда `/undo` в боте
  - **DoD:** `/undo` — последние 10 изменений с кнопками «откатить»; `/undo <id>` — прямой откат
  - **Files:** `src/bot/handlers/undo.ts` + тест
  - **P0** · 45м

## Kill-switch и глобальный стоп

- [ ] **T20.17** — Kill-switch per-tenant
  - **DoD:** флаг `Tenant.paused = true` — все сервисы читают, любой mutate возвращает `TenantPausedError`
  - **Files:** middleware `src/lib/tenantGuard.ts` + тест
  - **P0** · 25м

- [ ] **T20.18** — Kill-switch per-provider per-tenant
  - **DoD:** `providersDisabled[]` в Tenant; при попытке — `ProviderDisabledError`
  - **Files:** тот же guard + тест
  - **P1** · 20м

- [ ] **T20.19** — Команды `/pause` / `/resume` в боте
  - **DoD:** `/pause` — глобально или `/pause yandex`; `/resume` — обратно; лог в TG
  - **Files:** `src/bot/handlers/pauseResume.ts` + тест
  - **P0** · 30м

- [ ] **T20.20** — Автоматический pause по аномалии
  - **DoD:** если суточный расход > 3× медиана за 7 дней → auto-pause + запрос апрува на resume
  - **Files:** `src/jobs/spendAnomaly.ts` + тест
  - **P1** · 40м

## Аудит

- [ ] **T20.21** — Endpoint `GET /audit/approvals?tenantId&from&to`
  - **DoD:** список апрувов с фильтрами; CSV-экспорт
  - **Files:** `src/routes/audit.ts` + тест
  - **P2** · 30м

- [ ] **T20.22** — Endpoint `GET /audit/changelog?tenantId&entityType&entityId`
  - **DoD:** история изменений сущности; поддержка pagination
  - **Files:** тот же роутер + тест
  - **P2** · 30м

- [ ] **T20.23** — Автоответ бота при подозрительной активности
  - **DoD:** если один и тот же тип действия >10 раз за час — предупреждение владельцу
  - **Files:** `src/jobs/suspiciousActivity.ts`
  - **P2** · 25м

**Итого:** ~23 задачи, ~13ч.
