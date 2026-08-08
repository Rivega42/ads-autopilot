# E12 — AI-Аналитик

**Цель:** утренний отчёт (08:00), недельный разбор, anomaly detection, инсайты через LLM.

**Зависимости:** E05/E06 (статистика), E04 (доставка), E16 (крон).
**DoD эпика:** каждое утро клиент получает TG-сообщение с вчерашними данными и выявленными аномалиями.

---

## Задачи

- [ ] **T12.01** — `StatAggregator` — агрегация данных за период
  - **DoD:** `aggregate(clientId, from, to)` → `{totalSpend, totalConversions, avgCpa, avgCpc, ctr, byChannel[], topCampaigns[], bottomCampaigns[]}`; тест
  - **Files:** `src/ai/analyst/StatAggregator.ts` + тест
  - **P0** · 35м

- [ ] **T12.02** — `AnomalyDetector` — обнаружение аномалий
  - **DoD:** сравнивает вчера vs 7-дневная скользящая средняя; аномалия если отклонение > 2σ; возвращает `{metric, value, expected, severity: 'warning'|'critical'}`
  - **Files:** `src/ai/analyst/AnomalyDetector.ts` + тест
  - **P0** · 45м

- [ ] **T12.03** — Prompt: AI-аналитик (Sonnet)
  - **DoD:** `src/ai/analyst/prompts/analyst.txt` — принимает агрегат + аномалии, генерит 5-8 bullet инсайтов на русском; тон: конкретный, без воды
  - **Files:** `src/ai/analyst/prompts/analyst.txt`
  - **P0** · 30м

- [ ] **T12.04** — `InsightGenerator` — LLM-инсайты
  - **DoD:** вызывает Sonnet с промптом + данными → `{insights: string[], recommendations: string[], risks: string[]}`; тест (mock LLM)
  - **Files:** `src/ai/analyst/InsightGenerator.ts` + тест
  - **P0** · 40м

- [ ] **T12.05** — Форматирование утреннего отчёта (TG HTML)
  - **DoD:** `DailyReportFormatter.format(stats, anomalies, insights)` → HTML-строка с секциями: Итого, По каналам, Аномалии, Рекомендации; тест
  - **Files:** `src/ai/analyst/DailyReportFormatter.ts` + тест
  - **P0** · 40м

- [ ] **T12.06** — Форматирование недельного отчёта
  - **DoD:** `WeeklyReportFormatter` — добавляет: динамика vs прошлая неделя, топ-5 объявлений, прогноз бюджета на неделю
  - **Files:** `src/ai/analyst/WeeklyReportFormatter.ts` + тест
  - **P1** · 45м

- [ ] **T12.07** — Отправка утреннего отчёта (08:00 МСК)
  - **DoD:** `DailyReportJob.run(clientId)` — агрегирует → детектит аномалии → генерит инсайты → форматирует → отправляет в TG
  - **Files:** `src/jobs/DailyReportJob.ts` + тест
  - **P0** · 35м

- [ ] **T12.08** — Отправка недельного отчёта (пн 09:00 МСК)
  - **DoD:** `WeeklyReportJob.run(clientId)` — 7 дней данных + сравнение + прогноз
  - **Files:** `src/jobs/WeeklyReportJob.ts`
  - **P1** · 30м

- [ ] **T12.09** — Команда `/report` (отчёт по требованию)
  - **DoD:** `/report` → отчёт за вчера; `/report week` → за 7 дней; `/report 2026-08-01` → за конкретный день
  - **Files:** `src/bot/commands/report.ts`
  - **P1** · 30м

- [ ] **T12.10** — Критический алерт (немедленный, не по расписанию)
  - **DoD:** если расход за час > 150% среднечасового — немедленный алерт; если конверсий 0 за 4 часа в рабочее время — алерт
  - **Files:** `src/ai/analyst/CriticalAlerter.ts` + тест
  - **P0** · 40м

- [ ] **T12.11** — Сохранение отчётов в БД
  - **DoD:** таблица `Report{clientId, type, date, data:json, sentAt}` — для истории и повторной отправки
  - **Files:** `prisma/schema.prisma`, миграция, `src/repos/ReportRepository.ts`
  - **P1** · 25м

- [ ] **T12.12** — Прогноз бюджета на 30 дней
  - **DoD:** линейная регрессия на исторических данных + сезонность (день недели); `{daily: number[], total: number, confidence: 0.9}`
  - **Files:** `src/ai/analyst/BudgetForecaster.ts` + тест
  - **P1** · 50м

- [ ] **T12.13** — Тест: полный цикл аналитика (mock данные)
  - **DoD:** генерирует тестовую статистику с искусственной аномалией → отчёт содержит её упоминание
  - **Files:** `tests/e2e/analyst.e2e.test.ts`
  - **P0** · 35м

- [ ] **T12.14** — Метрики аналитика
  - **DoD:** `report_sent_total`, `anomaly_detected_total`, `report_generation_duration_ms`
  - **Files:** `src/ai/analyst/metrics.ts`
  - **P2** · 15м
