# E07 — AI-Онбординг клиента

**Цель:** Grammy conversation-граф, 15 вопросов, AI-Interviewer строит портрет клиента и сохраняет в БД.

**Зависимости:** E04 (бот), E02 (БД).
**DoD эпика:** новый клиент за 15 мин отвечает на вопросы → в БД появляется полный ClientProfile, AI-Стратег может его использовать.

---

## Задачи

- [ ] **T07.01** — Модель `ClientProfile` в Prisma
  - **DoD:** clientId, product (string), usp (string), targetAudience (json), geoInclude, geoExclude, competitors (string[]), budget (json), goals (json), existingChannels (string[]), brandStyle (json), rawAnswers (json)
  - **Files:** `prisma/schema.prisma`, миграция
  - **P0** · 20м

- [ ] **T07.02** — Вопросник: список 15 вопросов
  - **DoD:** `src/ai/onboarding/questions.ts` — массив `{id, text, hint, optional, validation}` для каждого вопроса; покрывает: продукт, ЦА, гео, бюджет, цель, конкуренты, бренд
  - **Files:** `src/ai/onboarding/questions.ts`
  - **P0** · 25м

- [ ] **T07.03** — Grammy conversation: линейный граф вопросов
  - **DoD:** `OnboardingConversation` — по очереди задаёт вопросы, принимает текстовые ответы, разрешает `/skip` для опциональных, `/stop` для прерывания
  - **Files:** `src/bot/conversations/onboarding.ts` + тест
  - **P0** · 60м

- [ ] **T07.04** — AI-Interviewer: уточняющие вопросы (LLM)
  - **DoD:** после каждого ответа короткий Claude-вызов (Haiku) проверяет полноту; если ответ слишком расплывчат — задаёт 1 уточняющий вопрос
  - **Files:** `src/ai/onboarding/interviewer.ts` + тест (mock LLM)
  - **P1** · 50м

- [ ] **T07.05** — Парсер и нормализация ответов (Zod + LLM)
  - **DoD:** сырые тексты → структурированный `ClientProfile`; LLM (Haiku) нормализует: "Москва и область" → geoInclude: [{regionId:1, regionId:3}], бюджет "тысяч 100" → {monthly: 100000, currency:"RUB"}
  - **Files:** `src/ai/onboarding/profileBuilder.ts` + тест
  - **P0** · 50м

- [ ] **T07.06** — Сохранение ClientProfile
  - **DoD:** `ClientProfileRepository.upsert(clientId, profile)` — создаёт или обновляет; тест
  - **Files:** `src/repos/ClientProfileRepository.ts` + тест
  - **P0** · 25м

- [ ] **T07.07** — Финальный summary (LLM)
  - **DoD:** после сохранения Haiku генерит 5-строчное саммари на русском ("Итак, вот что я поняла о вашем бизнесе: ..."), бот отправляет клиенту для подтверждения
  - **Files:** `src/ai/onboarding/summarizer.ts` + тест
  - **P0** · 35м

- [ ] **T07.08** — Кнопки «Всё верно» / «Исправить»
  - **DoD:** клиент подтверждает → onboarding завершён; «Исправить» → перезапускает разговор с того вопроса, который хочет изменить
  - **Files:** `src/bot/conversations/onboarding.ts`
  - **P0** · 30м

- [ ] **T07.09** — Обработка паузы (клиент ушёл)
  - **DoD:** если клиент не отвечает 30 мин → напоминание; если 24 часа → conversation сохраняется в draft, продолжается при след. `/start`
  - **Files:** `src/bot/conversations/onboarding.ts`
  - **P1** · 35м

- [ ] **T07.10** — Команда `/profile` — просмотр текущего профиля
  - **DoD:** форматированный вывод ClientProfile, кнопка «Обновить»
  - **Files:** `src/bot/commands/profile.ts`
  - **P1** · 25м

- [ ] **T07.11** — Сохранение brandStyle (лого + цвета)
  - **DoD:** бот просит загрузить лого (опционально) — сохраняет в S3/local, палитру извлекает через `node-vibrant`
  - **Files:** `src/ai/onboarding/brandExtractor.ts`
  - **P2** · 45м

- [ ] **T07.12** — Prompt для AI-Interviewer
  - **DoD:** `src/ai/onboarding/prompts/interviewer.txt` — системный промпт Haiku; тест проверяет что промпт не меняет структуру
  - **Files:** `src/ai/onboarding/prompts/interviewer.txt`
  - **P0** · 20м

- [ ] **T07.13** — Тест: полный onboarding e2e (mock LLM)
  - **DoD:** тест симулирует 15 ответов пользователя, проверяет что ClientProfile создан с правильными полями
  - **Files:** `tests/e2e/onboarding.e2e.test.ts`
  - **P0** · 50м

- [ ] **T07.14** — Метрика: onboarding completion rate
  - **DoD:** запись в `AuditLog` на каждый шаг; Prometheus gauge `onboarding_completion_rate`
  - **Files:** `src/ai/onboarding/metrics.ts`
  - **P2** · 20м
