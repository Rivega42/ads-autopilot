# E17 — Импорт существующих кампаний (§15 ТЗ)

**Цель:** режим наблюдателя 72ч → AI-аудит → handover в 3 этапа → rollback через ChangeLog.

**Зависимости:** E05 (Direct sync), E06 (VK sync), E11 (оптимизатор), E04 (апрув).
**DoD эпика:** клиент подключает существующий кабинет → через 72ч получает аудит и план → одобряет → система берёт управление.

---

## Задачи

- [ ] **T17.01** — Модель `ImportSession` в Prisma
  - **DoD:** clientId, provider, startedAt, observerUntil, auditGeneratedAt, handoverStartedAt, currentPhase (OBSERVER|AUDIT|HANDOVER_WEEK_1|WEEK_2|WEEK_3|FULL), status
  - **Files:** `prisma/schema.prisma`, миграция
  - **P0** · 25м

- [ ] **T17.02** — Discovery для Яндекс Директа
  - **DoD:** `YandexDiscovery.discover(clientId)` — загружает Campaigns → AdGroups → Ads → Keywords → BidModifiers → Sitelinks; сохраняет baseline snapshot
  - **Files:** `src/services/import/YandexDiscovery.ts` + тест
  - **P0** · 50м

- [ ] **T17.03** — Discovery для VK Ads
  - **DoD:** `VkDiscovery.discover(clientId)` — plans → groups → banners + статистика за 30 дней
  - **Files:** `src/services/import/VkDiscovery.ts` + тест
  - **P0** · 40м

- [ ] **T17.04** — Baseline snapshot storage
  - **DoD:** `Campaign.baselineData` json — снимок метрик на момент импорта: 30-дневная стата, структура, ставки
  - **Files:** `src/services/import/BaselineSnapshotter.ts` + тест
  - **P0** · 30м

- [ ] **T17.05** — Observer mode enforcement
  - **DoD:** `Campaign.handoverMode='observer'` блокирует любые вызовы update/delete в CampaignService; тесты проверяют что попытка изменения throwит
  - **Files:** `src/services/CampaignService.ts`, `src/services/import/observerGuard.ts` + тест
  - **P0** · 40м

- [ ] **T17.06** — 72-часовое накопление статистики
  - **DoD:** каждый час сохраняет свежую стату; счётчик часов; при 72 часах — триггерит T17.07
  - **Files:** `src/services/import/ObserverCollector.ts`
  - **P0** · 30м

- [ ] **T17.07** — Prompt: AI-аудитор (Opus 4.7)
  - **DoD:** `src/services/import/prompts/auditor.txt` — принимает baseline + 72ч стата, возвращает структурированный `AuditReport{campaignHealth[], quickWins[], firstWeekPlan[], estimated_improvement}`
  - **Files:** `src/services/import/prompts/auditor.txt`
  - **P0** · 45м

- [ ] **T17.08** — `AuditorAgent` — генератор аудита
  - **DoD:** вызывает Opus с промптом, валидирует Zod-схемой, сохраняет в `Campaign.auditResult`
  - **Files:** `src/services/import/AuditorAgent.ts` + тест (mock LLM)
  - **P0** · 45м

- [ ] **T17.09** — Форматирование аудита для TG
  - **DoD:** красивый HTML: 🟢 Работает хорошо / 🟡 Требует внимания / 🔴 Проблема + прогноз экономии + кнопки
  - **Files:** `src/services/import/AuditFormatter.ts` + тест
  - **P0** · 35м

- [ ] **T17.10** — Отправка аудита + кнопки одобрения
  - **DoD:** `AuditNotifier.send(clientId)` — TG с кнопками [Одобрить план] [Подробный отчёт] [Не трогать]; сохраняет `PendingApproval{kind:'IMPORT_HANDOVER'}`
  - **Files:** `src/services/import/AuditNotifier.ts`
  - **P0** · 25м

- [ ] **T17.11** — Handover Week 1: только минус-слова
  - **DoD:** `HandoverWeek1.execute(sessionId)` — применяет только рекомендации по минус-словам и отключение объявлений с 0 CTR за 30 дней; никаких изменений ставок
  - **Files:** `src/services/import/HandoverWeek1.ts` + тест
  - **P0** · 40м

- [ ] **T17.12** — Handover Week 2: корректировки ±15%
  - **DoD:** после 7 дней успешной Week 1 — корректировки ставок по устройствам/времени; каждое изменение в ChangeLog с обоснованием
  - **Files:** `src/services/import/HandoverWeek2.ts` + тест
  - **P0** · 40м

- [ ] **T17.13** — Handover Week 3: полное управление
  - **DoD:** `Campaign.handoverMode='managed'` — снимает блокировки observer, оптимизатор работает в штатном режиме
  - **Files:** `src/services/import/HandoverWeek3.ts` + тест
  - **P0** · 25м

- [ ] **T17.14** — Детектор конфликтов: автостратегии Яндекса
  - **DoD:** если `Campaign.strategy in [AVERAGE_CPA, AVERAGE_ROI, MAX_CONVERSIONS]` — блокируем изменения ставок, только минус-слова
  - **Files:** `src/services/import/ConflictDetector.ts` + тест
  - **P0** · 30м

- [ ] **T17.15** — Детектор конфликтов: A/B эксперименты
  - **DoD:** если активен Яндекс Эксперимент — не вмешиваемся до его окончания
  - **Files:** `src/services/import/ConflictDetector.ts` (расширить)
  - **P0** · 25м

- [ ] **T17.16** — Детектор конфликтов: сторонняя автоматизация
  - **DoD:** если история изменений содержит паттерны сторонней системы (большие частые правки) — предупреждение клиенту "аккаунт похоже уже управляется"
  - **Files:** `src/services/import/ConflictDetector.ts`
  - **P1** · 30м

- [ ] **T17.17** — Отчёт "Пропущенные / Забытые кампании"
  - **DoD:** после discovery — отчёт клиенту: X кампаний на паузе, Y — нулевой бюджет, Z — не работают > 30 дней
  - **Files:** `src/services/import/AbandonedCampaignsReport.ts`
  - **P1** · 30м

- [ ] **T17.18** — Rollback endpoint
  - **DoD:** `POST /api/rollback/:changeLogId` (в дашборде и в боте) — читает ChangeLog, применяет обратное изменение через провайдера; помечает `rolledBackAt`
  - **Files:** `src/routes/rollback.ts`, `src/services/RollbackService.ts` (уже из E11)
  - **P0** · 30м

- [ ] **T17.19** — Изоляция ключей: не трогать что не наше
  - **DoD:** ключи/группы созданные вне системы помечаются `Keyword.origin='external'`; оптимизатор может паузить, но не удалять
  - **Files:** `prisma/schema.prisma`, `src/repos/KeywordRepository.ts`
  - **P1** · 25м

- [ ] **T17.20** — CLI: manual re-audit
  - **DoD:** `pnpm cli reaudit --client-id=X` — запускает Аудитор повторно (для отладки/по запросу клиента)
  - **Files:** `scripts/cli/reaudit.ts`
  - **P2** · 20м

- [ ] **T17.21** — Тест: полный сценарий импорта (mock all)
  - **DoD:** discovery → observer 72ч (mock time) → аудит → одобрение → week 1/2/3
  - **Files:** `tests/e2e/import.e2e.test.ts`
  - **P0** · 60м

- [ ] **T17.22** — Документация
  - **DoD:** `docs/features/import-existing-campaigns.md` — процесс, риски, откат
  - **Files:** `docs/features/import-existing-campaigns.md`
  - **P1** · 25м
