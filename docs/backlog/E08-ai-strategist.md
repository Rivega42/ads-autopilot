# E08 — AI-Стратег

**Цель:** Opus-агент анализирует нишу через SerpAPI/Wordstat, генерит план кампании, отправляет на апрув.

**Зависимости:** E07 (профиль клиента), E04 (апрув через бот).
**DoD эпика:** после онбординга AI-Стратег автоматически создаёт стратегию и отправляет её клиенту на подтверждение.

---

## Задачи

- [ ] **T08.01** — SerpAPI клиент
  - **DoD:** `src/tools/serpapi.ts` — `search(query, gl:'ru')` → top-10 органика + top-5 ads; retry при 429; кеш в Redis 6ч
  - **Files:** `src/tools/serpapi.ts` + тест (mock API)
  - **P0** · 30м

- [ ] **T08.02** — Yandex Wordstat клиент
  - **DoD:** `src/tools/wordstat.ts` — `getForecast(phrases[])` → показы/месяц, CPC оценка; использует Yandex Direct API (Forecasts service)
  - **Files:** `src/tools/wordstat.ts` + тест
  - **P0** · 35м

- [ ] **T08.03** — Конкурентный анализ (SerpAPI)
  - **DoD:** по нише из ClientProfile парсит топ-10 конкурентов: название, домен, примеры объявлений (из блока ads); структурированный output
  - **Files:** `src/ai/strategist/competitorAnalyzer.ts` + тест
  - **P0** · 40м

- [ ] **T08.04** — Прогноз бюджета (Wordstat + исторические CPС)
  - **DoD:** оценка охвата и CTR по целевым ключам, рекомендуемый месячный бюджет по каналам
  - **Files:** `src/ai/strategist/budgetEstimator.ts` + тест
  - **P0** · 40м

- [ ] **T08.05** — Prompt системного AI-Стратега (Opus 4.7)
  - **DoD:** `src/ai/strategist/prompts/strategist.txt` — 1000-1500 токенов, структурированный output (JSON), contains: channel_mix, campaign_types, audience_segments, budget_allocation, kpi_targets
  - **Files:** `src/ai/strategist/prompts/strategist.txt`
  - **P0** · 45м

- [ ] **T08.06** — Zod-схема выходного плана стратегии
  - **DoD:** `CampaignStrategySchema` — channel (enum), type (SEARCH|RSA|VK_FEED|...), audience, dailyBudget, targetCpa, startDate, priority
  - **Files:** `src/ai/strategist/schemas.ts`
  - **P0** · 25м

- [ ] **T08.07** — Вызов Opus с tool_use (structured output)
  - **DoD:** LLM вызывается с инструментом `create_strategy`, получает `ClientProfile` + конкурентный анализ + прогноз → возвращает `CampaignStrategy[]`
  - **Files:** `src/ai/strategist/StrategistAgent.ts` + тест (mock LLM)
  - **P0** · 55м

- [ ] **T08.08** — Форматирование стратегии для TG
  - **DoD:** `formatStrategy(strategy)` → красивый HTML-текст: бюджет по каналам, KPI, сроки, объяснение выбора
  - **Files:** `src/ai/strategist/formatter.ts` + тест
  - **P0** · 30м

- [ ] **T08.09** — Отправка на апрув + сохранение PendingApproval
  - **DoD:** бот отправляет форматированную стратегию + кнопки [Одобрить] [Изменить бюджет] [Отклонить]; сохраняет `PendingApproval{kind:'STRATEGY'}`
  - **Files:** `src/ai/strategist/StrategistAgent.ts`
  - **P0** · 35м

- [ ] **T08.10** — Обработчик: клиент одобрил стратегию
  - **DoD:** APPROVED → создаёт черновики кампаний в БД (status: DRAFT), запускает E09 (генерацию креативов)
  - **Files:** `src/bot/callbacks/strategyApproval.ts` + тест
  - **P0** · 40м

- [ ] **T08.11** — Обработчик: «Изменить бюджет»
  - **DoD:** клиент вводит новый бюджет, стратег пересчитывает распределение по каналам, отправляет обновлённый вариант
  - **Files:** `src/bot/callbacks/strategyApproval.ts`
  - **P1** · 35м

- [ ] **T08.12** — Переодический пересмотр стратегии
  - **DoD:** раз в 30 дней или при значительном изменении KPI (+/-30%) — стратег запускается заново, сравнивает с текущей, предлагает обновление
  - **Files:** `src/ai/strategist/StrategyReviewer.ts`
  - **P1** · 45м

- [ ] **T08.13** — Сохранение `CampaignStrategy` в БД
  - **DoD:** модель `Strategy` (clientId, channels[], budgetPlan, kpiTargets, approvedAt, validUntil)
  - **Files:** `prisma/schema.prisma`, миграция, `src/repos/StrategyRepository.ts`
  - **P0** · 30м

- [ ] **T08.14** — Тест: стратег e2e (mock SerpAPI + mock LLM)
  - **DoD:** за < 5с генерит стратегию для тестового ClientProfile; проверка что все поля заполнены
  - **Files:** `tests/e2e/strategist.e2e.test.ts`
  - **P0** · 40м

- [ ] **T08.15** — Метрики стратега
  - **DoD:** `strategy_approval_rate`, `strategy_generation_latency_ms` в Prometheus
  - **Files:** `src/ai/strategist/metrics.ts`
  - **P2** · 20м

- [ ] **T08.16** — Документация: как работает стратег
  - **DoD:** `docs/ai-components/strategist.md` — архитектура, промпты, примеры вывода, как менять KPI
  - **Files:** `docs/ai-components/strategist.md`
  - **P1** · 25м
