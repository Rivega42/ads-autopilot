# E11 — AI-Оптимизатор

**Цель:** ML-модель + LLM-агент для управления ставками и бюджетами; approval gate при изменениях > 20%.

**Зависимости:** E05/E06 (ставки), E16 (крон), E04 (апрув).
**DoD эпика:** каждое утро система автоматически корректирует ставки по CPA-цели, крупные изменения уходят на апрув.

---

## Задачи

- [ ] **T11.01** — Загрузка исторической статистики для ML
  - **DoD:** `FeatureExtractor.extract(clientId, days:30)` → массив `{date, hour, cpa, cpc, ctr, impressions, clicks, spend, conversions, keyword, deviceType, regionId}`
  - **Files:** `src/ai/optimizer/FeatureExtractor.ts` + тест
  - **P0** · 35м

- [ ] **T11.02** — Базовые правила оптимизации (fallback без ML)
  - **DoD:** `RuleBasedOptimizer` — CPA > 1.5×target → bid -15%; CPA < 0.7×target AND недокрут > 10% → bid +10%; изменение ≤ 20%/день; тест
  - **Files:** `src/ai/optimizer/RuleBasedOptimizer.ts` + тест
  - **P0** · 45м

- [ ] **T11.03** — LightGBM prediction (через Python subprocess)
  - **DoD:** `src/ai/optimizer/mlPredictor.ts` — запускает `python3 scripts/predict.py` с features JSON, возвращает `{keywordId, suggestedBid, confidence}`; Python-скрипт с заготовкой LightGBM модели
  - **Files:** `src/ai/optimizer/mlPredictor.ts`, `scripts/predict.py`
  - **P1** · 60м

- [ ] **T11.04** — Переобучение модели (offline)
  - **DoD:** `scripts/train.py` — обучает LightGBM на данных из БД (выгрузка CSV → fit → save model.bin); запускается вручную или раз в неделю
  - **Files:** `scripts/train.py`, `scripts/export_training_data.ts`
  - **P1** · 90м

- [ ] **T11.05** — `BidOptimizer` — главный координатор
  - **DoD:** берёт предсказания ML (или правила), формирует `BidChange[]`, фильтрует по approval threshold, применяет
  - **Files:** `src/ai/optimizer/BidOptimizer.ts` + тест
  - **P0** · 50м

- [ ] **T11.06** — Approval gate ±20%
  - **DoD:** изменение бюджета или ставки > 20% → создаёт `PendingApproval{kind:'BID_CHANGE'}`, ждёт; при APPROVED применяет; при EXPIRED через 2ч — откатывает и логирует
  - **Files:** `src/ai/optimizer/BidOptimizer.ts`, `src/bot/callbacks/bidApproval.ts`
  - **P0** · 45м

- [ ] **T11.07** — Массовое отключение (> 10 объектов за раз)
  - **DoD:** если оптимизатор хочет отключить > 10 ключей → всегда на апрув с preview списком
  - **Files:** `src/ai/optimizer/BidOptimizer.ts`
  - **P0** · 25м

- [ ] **T11.08** — Минус-слова: авто-применение (SearchQueryParser)
  - **DoD:** раз в 3 дня — парсит SearchQueryReport Директа, добавляет кандидатов в минус через NegativeKeywordsService; логирует в ChangeLog
  - **Files:** `src/ai/optimizer/NegativeKeywordOptimizer.ts` + тест
  - **P0** · 40м

- [ ] **T11.09** — Паузировка нулевых ключей
  - **DoD:** ключи с impressions < 10 за 30 дней → `suspend`; ключи с CPA > 3×target AND impressions > 500 → `suspend`; всё в ChangeLog
  - **Files:** `src/ai/optimizer/KeywordPauser.ts` + тест
  - **P0** · 35м

- [ ] **T11.10** — A/B winner selector
  - **DoD:** после 7 дней A/B теста — сравнивает CTR и CPA вариантов, паузирует проигравший, расширяет бюджет победителя
  - **Files:** `src/ai/optimizer/AbWinnerSelector.ts` + тест
  - **P0** · 45м

- [ ] **T11.11** — Корректировка ставок по устройствам
  - **DoD:** если CR мобайла < 0.5×desktop → bidModifier для мобайл -20%; update через BidModifiersService
  - **Files:** `src/ai/optimizer/DeviceModifierOptimizer.ts` + тест
  - **P1** · 35м

- [ ] **T11.12** — Корректировка ставок по времени суток
  - **DoD:** analysing hourly stats за 14 дней → часы с CR < 0.3×average → bidModifier -30%; часы с CR > 1.5×average → +15%
  - **Files:** `src/ai/optimizer/TimeModifierOptimizer.ts` + тест
  - **P1** · 40м

- [ ] **T11.13** — Откат (rollback через ChangeLog)
  - **DoD:** `RollbackService.rollback(changeLogId)` — читает prevValue, применяет обратное изменение через API; тест
  - **Files:** `src/services/RollbackService.ts` + тест
  - **P0** · 40м

- [ ] **T11.14** — Лимит суточных изменений (защита от расхождения)
  - **DoD:** не более ±20% суммарного бюджета в день; не более 30% ключей одновременно
  - **Files:** `src/ai/optimizer/BidOptimizer.ts`
  - **P0** · 25м

- [ ] **T11.15** — Prompt: LLM-объяснение решений оптимизатора
  - **DoD:** Haiku генерит 2-3 строки объяснения для каждого изменения ставки в отчёте
  - **Files:** `src/ai/optimizer/explainer.ts`
  - **P1** · 30м

- [ ] **T11.16** — Тест: оптимизация e2e
  - **DoD:** загружает тестовую статистику → оптимизатор → проверяет что правильные ключи паузированы, ставки изменены в правильную сторону
  - **Files:** `tests/e2e/optimizer.e2e.test.ts`
  - **P0** · 50м

- [ ] **T11.17** — Метрики оптимизатора
  - **DoD:** `bid_changes_total`, `approved_changes_ratio`, `rollback_count`, `avg_cpa_delta_pct`
  - **Files:** `src/ai/optimizer/metrics.ts`
  - **P1** · 20м

- [ ] **T11.18** — Документация: логика оптимизации
  - **DoD:** `docs/ai-components/optimizer.md` — правила, ML-модель, как откатить решение
  - **Files:** `docs/ai-components/optimizer.md`
  - **P1** · 25м
