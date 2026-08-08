# E09 — AI-Креативы

**Цель:** полная автогенерация текстов, изображений, видео для объявлений.

**Зависимости:** E08 (стратегия), E05/E06 (загрузка в рекламные системы).
**DoD эпика:** по утверждённой стратегии AI генерит полный набор креативов и загружает в рекламные системы.

---

## Задачи

- [ ] **T09.01** — Prompt: AI-копирайтер (Sonnet)
  - **DoD:** `src/ai/creatives/prompts/copywriter.txt` — генерит 5 вариантов заголовка (30 симв) + 5 текстов (81 симв) под Директ; учитывает УТП, ЦА, конкурентов; structured output
  - **Files:** `src/ai/creatives/prompts/copywriter.txt`
  - **P0** · 35м

- [ ] **T09.02** — `CopywriterAgent` — генерация текстов
  - **DoD:** принимает `{product, usp, audience, format}`, возвращает `{headlines[], bodies[]}`; тест (mock LLM)
  - **Files:** `src/ai/creatives/CopywriterAgent.ts` + тест
  - **P0** · 45м

- [ ] **T09.03** — Валидация текстов под требования Директа
  - **DoD:** заголовок ≤ 56 симв с учётом шаблонов, текст ≤ 81 симв, нет запрещённых слов (стоп-список); throw если нарушено
  - **Files:** `src/ai/creatives/validators/yandexTextValidator.ts` + тест
  - **P0** · 30м

- [ ] **T09.04** — Валидация текстов под требования VK Ads
  - **DoD:** заголовок ≤ 25 симв, текст ≤ 220 симв, URL обязателен
  - **Files:** `src/ai/creatives/validators/vkTextValidator.ts` + тест
  - **P0** · 20м

- [ ] **T09.05** — Kandinsky 3.1 клиент (изображения)
  - **DoD:** `src/tools/kandinsky.ts` — `generate(prompt, style, w, h)` → base64 PNG; retry при 503; сохранение в `/tmp`
  - **Files:** `src/tools/kandinsky.ts` + тест (mock API)
  - **P0** · 40м

- [ ] **T09.06** — DALL-E 3 клиент (изображения, fallback)
  - **DoD:** аналогично Kandinsky; включается при `IMAGE_PROVIDER=openai`
  - **Files:** `src/tools/dalle.ts` + тест
  - **P1** · 30м

- [ ] **T09.07** — Prompt: AI-дизайнер (генерация промпта для изображения)
  - **DoD:** Haiku принимает `{product, brandStyle, format: banner_240x400|...}` → текстовый промпт для Kandinsky на русском и английском
  - **Files:** `src/ai/creatives/prompts/imagePromptWriter.txt`, `src/ai/creatives/ImagePromptAgent.ts` + тест
  - **P0** · 35м

- [ ] **T09.08** — `ImageGeneratorAgent` — генерация изображений
  - **DoD:** по промпту и brandStyle генерит 3 варианта для каждого формата (240x400, 1080x607, 300x250); выбирает провайдера по env
  - **Files:** `src/ai/creatives/ImageGeneratorAgent.ts` + тест
  - **P0** · 45м

- [ ] **T09.09** — Наложение логотипа и CTA на изображение (Sharp)
  - **DoD:** `src/ai/creatives/imageCompositor.ts` — overlay лого в угол, добавляет кнопку-CTA как текст; sharp
  - **Files:** `src/ai/creatives/imageCompositor.ts` + тест
  - **P1** · 45м

- [ ] **T09.10** — Runway Gen-3 клиент (видео)
  - **DoD:** `src/tools/runway.ts` — `generate(prompt, imageUrl, duration: 5|10)` → mp4 URL; polling до готовности
  - **Files:** `src/tools/runway.ts` + тест (mock)
  - **P1** · 45м

- [ ] **T09.11** — `VideoGeneratorAgent` — генерация видео 15-30 сек
  - **DoD:** берёт сгенерированное изображение → Runway анимирует → добавляет subtitle (текст объявления); сохраняет mp4
  - **Files:** `src/ai/creatives/VideoGeneratorAgent.ts`
  - **P2** · 60м

- [ ] **T09.12** — Загрузка изображений в Яндекс Директ
  - **DoD:** `DirectImageUploader.upload(file)` → imageHash; прикрепляет к объявлению через AdsService
  - **Files:** `src/providers/yandex/DirectImageUploader.ts` + тест
  - **P0** · 35м

- [ ] **T09.13** — Загрузка изображений в VK Ads
  - **DoD:** `VkImageUploader.upload(file, accountId)` → mediaId через MediaService
  - **Files:** `src/providers/vk/VkImageUploader.ts` + тест
  - **P0** · 25м

- [ ] **T09.14** — `CreativesOrchestrator` — главный координатор
  - **DoD:** по clientId и strategyId запускает: тексты → изображения → сборка объявлений → загрузка; логирует всё в ChangeLog
  - **Files:** `src/ai/creatives/CreativesOrchestrator.ts` + тест
  - **P0** · 60м

- [ ] **T09.15** — Отправка примеров клиенту на просмотр
  - **DoD:** в TG отправляет 2-3 лучших варианта (текст + картинка), кнопки [Запустить] [Ещё вариант] [Изменить текст]
  - **Files:** `src/ai/creatives/CreativesOrchestrator.ts`
  - **P0** · 35м

- [ ] **T09.16** — A/B тест по умолчанию
  - **DoD:** загружает минимум 2 варианта объявления в каждую группу; после 7 дней `WinnerSelector` (см. E11) определяет победителя
  - **Files:** `src/ai/creatives/AbTestManager.ts`
  - **P0** · 40м

- [ ] **T09.17** — Хранилище медиа-файлов
  - **DoD:** `src/storage/fileStore.ts` — сохраняет в local `/storage` (dev) или S3-совместимое (prod), возвращает публичный URL
  - **Files:** `src/storage/fileStore.ts` + тест
  - **P0** · 35м

- [ ] **T09.18** — Себестоимость комплекта креативов
  - **DoD:** после генерации логирует стоимость (LLM tokens + API calls), записывает в `AuditLog`, ожидаемый итог ≤ 60₽
  - **Files:** `src/ai/creatives/costTracker.ts`
  - **P1** · 25м

- [ ] **T09.19** — Ре-генерация при отклонении модератором
  - **DoD:** если объявление отклонено и причина связана с kreativom — `CreativesOrchestrator.regenerate(adId, reason)`
  - **Files:** `src/ai/creatives/CreativesOrchestrator.ts`
  - **P0** · 35м

- [ ] **T09.20** — Тест: полный цикл (mock LLM + mock image API)
  - **DoD:** за < 10с создаёт 5 текстов + 3 изображения (mock), собирает объявления
  - **Files:** `tests/e2e/creatives.e2e.test.ts`
  - **P0** · 50м

- [ ] **T09.21** — Документация: промпты и их версии
  - **DoD:** `docs/ai-components/creatives.md` — как работают промпты, как менять стиль, параметры изображений
  - **Files:** `docs/ai-components/creatives.md`
  - **P1** · 25м

- [ ] **T09.22** — Метрики генерации
  - **DoD:** `creative_generation_duration_ms`, `creative_cost_rub`, `creative_approval_rate`
  - **Files:** `src/ai/creatives/metrics.ts`
  - **P2** · 20м
