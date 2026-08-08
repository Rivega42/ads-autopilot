# E14 — AI-Wordstat (семантическое ядро)

**Цель:** генерация семантики через LLM + Wordstat, кластеризация эмбеддингами, фильтр по конверсионности.

**Зависимости:** E08 (профиль клиента), E05 (Wordstat через Direct API).
**DoD эпика:** по описанию бизнеса система создаёт кластеризованное семантическое ядро на 500+ фраз.

---

## Задачи

- [ ] **T14.01** — LLM-генератор базовых фраз (Sonnet)
  - **DoD:** промпт принимает `{product, usp, audience}` → 100-200 базовых фраз с разметкой intent (commercial/informational/branded/comparison)
  - **Files:** `src/ai/wordstat/prompts/seedGenerator.txt`, `src/ai/wordstat/SeedGenerator.ts` + тест
  - **P0** · 40м

- [ ] **T14.02** — Расширение через Wordstat
  - **DoD:** каждую базовую фразу расширяет через WordstatService (левая колонка) → +5-10 вариантов на фразу; дедуп
  - **Files:** `src/ai/wordstat/PhraseExpander.ts` + тест
  - **P0** · 35м

- [ ] **T14.03** — Embedding через bge-m3 (локально) или OpenAI
  - **DoD:** `src/ai/wordstat/embedder.ts` — принимает фразы, возвращает вектора; локально через `@xenova/transformers` (bge-m3) или fallback OpenAI text-embedding-3-small
  - **Files:** `src/ai/wordstat/embedder.ts` + тест
  - **P0** · 45м

- [ ] **T14.04** — Кластеризация фраз (HDBSCAN)
  - **DoD:** `src/ai/wordstat/clusterer.ts` — Python subprocess (hdbscan lib) или JS-порт; на выходе `{cluster_id, phrases:[], centroid_phrase}`
  - **Files:** `src/ai/wordstat/clusterer.ts`, `scripts/cluster.py`
  - **P0** · 55м

- [ ] **T14.05** — LLM-именование кластеров (Haiku)
  - **DoD:** для каждого кластера — Haiku даёт короткое имя (2-3 слова) и intent
  - **Files:** `src/ai/wordstat/clusterNamer.ts`
  - **P0** · 25м

- [ ] **T14.06** — Оценка конверсионности через прогноз Wordstat
  - **DoD:** для каждой фразы — прогнозируемая цена клика + охват; фразы с прогнозом < 5 показов/мес отсеиваются
  - **Files:** `src/ai/wordstat/conversionScorer.ts` + тест
  - **P0** · 35м

- [ ] **T14.07** — Фильтр стоп-фраз (informational, brand competitors)
  - **DoD:** удаление вопросов "как", "что такое", брендов конкурентов (кроме сравнений)
  - **Files:** `src/ai/wordstat/stopFilter.ts` + тест
  - **P0** · 25м

- [ ] **T14.08** — Автогенерация минус-слов
  - **DoD:** LLM анализирует ядро → предлагает 30-50 минус-слов (бесплатно, скачать, wiki, работа и т.п.)
  - **Files:** `src/ai/wordstat/negativeGenerator.ts` + тест
  - **P0** · 30м

- [ ] **T14.09** — Сохранение семантического ядра
  - **DoD:** таблица `SemanticCore{clientId, clusters:json, phrases:json, negatives:json, generatedAt}`
  - **Files:** `prisma/schema.prisma`, миграция, `src/repos/SemanticCoreRepository.ts`
  - **P0** · 25м

- [ ] **T14.10** — Импорт ядра в кампании
  - **DoD:** `SemanticCoreImporter.import(clientId, campaignId)` — создаёт группы объявлений по кластерам, добавляет ключи через KeywordsService
  - **Files:** `src/ai/wordstat/SemanticCoreImporter.ts` + тест
  - **P0** · 40м

- [ ] **T14.11** — Тест: полный пайплайн (mock LLM + mock Wordstat)
  - **DoD:** входные данные ClientProfile → выход: ядро 100+ фраз, 5+ кластеров
  - **Files:** `tests/e2e/wordstat.e2e.test.ts`
  - **P0** · 40м

- [ ] **T14.12** — Документация
  - **DoD:** `docs/ai-components/wordstat.md` — как работает, стоимость, качество
  - **Files:** `docs/ai-components/wordstat.md`
  - **P1** · 15м
