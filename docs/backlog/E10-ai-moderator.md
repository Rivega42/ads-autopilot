# E10 — AI-Модератор

**Цель:** автоматически обрабатывать отклонённые объявления — читать причину, переписывать, ретраить.

**Зависимости:** E05/E06 (статус модерации), E09 (ре-генерация).
**DoD эпика:** отклонённое объявление за 30 мин получает исправленную версию и отправляется на повторную модерацию без участия человека.

---

## Задачи

- [ ] **T10.01** — База правил модерации (rulebook)
  - **DoD:** `src/ai/moderator/rulebook.ts` — структурированный список 200+ правил Директа и VK; покрывает: медицина, финансы, оружие, кликбейт, сравнения, превосходные степени, контакты в тексте
  - **Files:** `src/ai/moderator/rulebook.ts`
  - **P0** · 60м

- [ ] **T10.02** — Парсер причины отклонения (Директ)
  - **DoD:** из поля `ModerationReasonCode` + текстовых подсказок Директа → структурированная ошибка `{ruleCode, description, affectedPart}`
  - **Files:** `src/ai/moderator/reasonParser.yandex.ts` + тест
  - **P0** · 35м

- [ ] **T10.03** — Парсер причины отклонения (VK)
  - **DoD:** из VK moderation_reason → аналогичная структура
  - **Files:** `src/ai/moderator/reasonParser.vk.ts` + тест
  - **P0** · 25м

- [ ] **T10.04** — Prompt: AI-редактор
  - **DoD:** `src/ai/moderator/prompts/editor.txt` — Sonnet принимает {originalText, rejectionReason, rulebook_excerpt} → исправленный вариант; строго запрещено менять смысл и УТП; structured output
  - **Files:** `src/ai/moderator/prompts/editor.txt`
  - **P0** · 40м

- [ ] **T10.05** — `EditorAgent` — переписывание объявления
  - **DoD:** max 3 попытки; если после 3 попыток не проходит правила — escalate в TG; тест (mock LLM)
  - **Files:** `src/ai/moderator/EditorAgent.ts` + тест
  - **P0** · 50м

- [ ] **T10.06** — Предварительная проверка перед отправкой
  - **DoD:** `PreModerationChecker.check(ad)` — прогоняет rulebook локально (без LLM), ловит 80% типовых нарушений; score risk 0-1
  - **Files:** `src/ai/moderator/PreModerationChecker.ts` + тест
  - **P0** · 45м

- [ ] **T10.07** — Цикл ретрая
  - **DoD:** `ModerationRetryLoop` — при REJECTED: parseReason → edit → validate → resubmit; max 3 цикла; каждый цикл в ChangeLog
  - **Files:** `src/ai/moderator/ModerationRetryLoop.ts` + тест
  - **P0** · 50м

- [ ] **T10.08** — Эскалация в TG (после 3 неудачных попыток)
  - **DoD:** сообщение с кнопками [Написать самому] [Архивировать объявление] [Попросить ещё раз]
  - **Files:** `src/ai/moderator/escalation.ts`
  - **P0** · 25м

- [ ] **T10.09** — Стоп-список ниш (автоматический отказ без ретрая)
  - **DoD:** ниши (медицинские препараты, казино, финансовые пирамиды) → сразу эскалация с объяснением
  - **Files:** `src/ai/moderator/nicheFilter.ts`
  - **P1** · 20м

- [ ] **T10.10** — История модерации
  - **DoD:** каждая попытка пишется в `ChangeLog{action:'moderation_retry'}`; можно смотреть историю через `/history adId`
  - **Files:** `src/ai/moderator/ModerationRetryLoop.ts`
  - **P0** · 20м

- [ ] **T10.11** — Тест: полный цикл отклонение → исправление
  - **DoD:** тест симулирует REJECTED + причину → проверяет что EditorAgent исправляет нарушение
  - **Files:** `tests/e2e/moderator.e2e.test.ts`
  - **P0** · 40м

- [ ] **T10.12** — Статистика эффективности модератора
  - **DoD:** процент успешных ретраев с 1-й/2-й/3-й попытки; логируется в AuditLog
  - **Files:** `src/ai/moderator/metrics.ts`
  - **P2** · 20м

- [ ] **T10.13** — Обновление rulebook из официальной документации
  - **DoD:** `scripts/updateRulebook.ts` — скрипт парсит страницы справки Директа, обновляет `rulebook.ts` (ручной запуск)
  - **Files:** `scripts/updateRulebook.ts`
  - **P2** · 60м

- [ ] **T10.14** — Документация: правила модерации
  - **DoD:** `docs/ai-components/moderator.md` — как работает, примеры ошибок, что нельзя автоматически исправить
  - **Files:** `docs/ai-components/moderator.md`
  - **P1** · 20м
