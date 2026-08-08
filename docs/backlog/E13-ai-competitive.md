# E13 — AI-Конкурентная разведка

**Цель:** раз в неделю анализировать топ-10 конкурентов, находить изменения в их рекламе, давать рекомендации.

**Зависимости:** E08 (профиль клиента с конкурентами), E04 (отправка отчёта).
**DoD эпика:** еженедельный TG-отчёт с новыми объявлениями конкурентов и рекомендациями что скопировать/улучшить.

---

## Задачи

- [ ] **T13.01** — `CompetitorScraper` — сбор рекламы конкурентов
  - **DoD:** SerpAPI `search(competitorDomain)` → paid results; парсит заголовки, тексты, URL; сохраняет в Redis с TTL 7 дней
  - **Files:** `src/ai/competitive/CompetitorScraper.ts` + тест (mock SerpAPI)
  - **P0** · 40м

- [ ] **T13.02** — `CompetitorDiffEngine` — diff новых объявлений vs прошлая неделя
  - **DoD:** сравнивает текущий snapshot vs предыдущий (из Redis/БД), возвращает `{new:[], changed:[], removed:[]}`
  - **Files:** `src/ai/competitive/CompetitorDiffEngine.ts` + тест
  - **P0** · 35м

- [ ] **T13.03** — Хранение снапшотов конкурентов
  - **DoD:** таблица `CompetitorSnapshot{clientId, competitorDomain, date, ads:json}` — история за 90 дней
  - **Files:** `prisma/schema.prisma`, миграция
  - **P0** · 20м

- [ ] **T13.04** — Prompt: анализ конкурентных объявлений (Sonnet)
  - **DoD:** `src/ai/competitive/prompts/analyst.txt` — что нового, что работает у конкурентов, что можно адаптировать; structured output `{findings[], suggestions[]}`
  - **Files:** `src/ai/competitive/prompts/analyst.txt`
  - **P0** · 30м

- [ ] **T13.05** — `CompetitiveIntelligenceAgent` — главный координатор
  - **DoD:** scrape → diff → analyze → format → send; запускается для каждого клиента раз в неделю (воскресенье 20:00)
  - **Files:** `src/ai/competitive/CompetitiveIntelligenceAgent.ts` + тест
  - **P0** · 50м

- [ ] **T13.06** — Форматирование отчёта
  - **DoD:** TG HTML с секциями: Что нового у конкурентов, Тренды ниши, Конкретные предложения для наших кампаний
  - **Files:** `src/ai/competitive/formatter.ts` + тест
  - **P0** · 30м

- [ ] **T13.07** — Добавление/удаление конкурентов через бот
  - **DoD:** `/competitors add domain.ru`, `/competitors list`, `/competitors remove domain.ru`; сохраняется в ClientProfile
  - **Files:** `src/bot/commands/competitors.ts`
  - **P1** · 25м

- [ ] **T13.08** — Мониторинг акций и скидок конкурентов
  - **DoD:** NLP (Haiku) ищет в текстах объявлений паттерны скидок (% off, "от N руб", "бесплатно"); алерт при обнаружении
  - **Files:** `src/ai/competitive/promotionDetector.ts` + тест
  - **P1** · 40м

- [ ] **T13.09** — Rate-limit SerpAPI
  - **DoD:** SerpAPI plan limit учитывается; макс. N запросов в день; очередь через BullMQ с delay
  - **Files:** `src/tools/serpapi.ts` (расширить)
  - **P0** · 20м

- [ ] **T13.10** — Тест: e2e (mock SerpAPI + mock LLM)
  - **DoD:** тест с 2 конкурентами → diff → отчёт содержит хотя бы 1 suggestion
  - **Files:** `tests/e2e/competitive.e2e.test.ts`
  - **P0** · 35м

- [ ] **T13.11** — Метрики
  - **DoD:** `competitor_scrape_total`, `new_competitor_ads_found`, `competitive_report_sent`
  - **Files:** `src/ai/competitive/metrics.ts`
  - **P2** · 15м

- [ ] **T13.12** — Документация
  - **DoD:** `docs/ai-components/competitive-intelligence.md`
  - **Files:** `docs/ai-components/competitive-intelligence.md`
  - **P1** · 15м
