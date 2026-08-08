# E15 — AI-Follow-up лидов

**Цель:** CRM-webhook, AI-квалификация лида в чате, эскалация горячих в TG менеджеру.

**Зависимости:** E04 (TG), E03 (secrets для WA/CRM).
**DoD эпика:** новый лид попадает в бот → AI задаёт 3-5 квалификационных вопросов → горячие уходят Роману/менеджеру за 30 сек.

---

## Задачи

- [ ] **T15.01** — Webhook endpoint для CRM
  - **DoD:** `POST /webhook/lead/:source` (amocrm, bitrix24, generic-json) — валидация HMAC подписи, dedup по externalId, сохранение
  - **Files:** `src/routes/leadWebhook.ts` + тест
  - **P0** · 40м

- [ ] **T15.02** — Модель `Lead` в Prisma
  - **DoD:** id, clientId, externalId, source, contact (json: phone/tg/email/wa), utmSource, utmCampaign, receivedAt, qualifiedAt, temperature (COLD|WARM|HOT), assignedTo
  - **Files:** `prisma/schema.prisma`, миграция
  - **P0** · 20м

- [ ] **T15.03** — WhatsApp клиент (через 360dialog или green-api)
  - **DoD:** `WhatsAppClient.send(phone, text)` + `receiveWebhook`; env `WA_PROVIDER=360dialog|greenapi`; тест (mock)
  - **Files:** `src/providers/whatsapp/WhatsAppClient.ts`
  - **P1** · 50м

- [ ] **T15.04** — Telegram-персональный контакт (через client-side telethon-like)
  - **DoD:** отправка сообщения на @username через MTProto-сессию (только если у клиента есть Telegram); опционально
  - **Files:** `src/providers/telegram-user/tgUserClient.ts`
  - **P2** · 60м

- [ ] **T15.05** — Prompt: AI-квалификатор (Sonnet)
  - **DoD:** ведёт диалог, задаёт 3-5 вопросов (бюджет, срочность, роль лица, интересы); в конце присваивает temperature; structured output
  - **Files:** `src/ai/followup/prompts/qualifier.txt`, `src/ai/followup/QualifierAgent.ts` + тест
  - **P0** · 45м

- [ ] **T15.06** — Conversation-граф follow-up
  - **DoD:** запускает диалог в канале лида (WA/TG), сохраняет историю; при неответе > 4ч — reminder; после 3 попыток — переводит в COLD
  - **Files:** `src/ai/followup/FollowupConversation.ts` + тест
  - **P0** · 55м

- [ ] **T15.07** — Эскалация горячих в TG
  - **DoD:** temperature=HOT → мгновенное сообщение Роману/менеджеру с контактом лида и историей диалога; кнопки [Позвонить] [Написать] [Отметить как closed]
  - **Files:** `src/ai/followup/escalation.ts` + тест
  - **P0** · 35м

- [ ] **T15.08** — Ежедневный digest по лидам
  - **DoD:** 09:00 — сводка вчерашних лидов: сколько, откуда, температура, конверсия
  - **Files:** `src/ai/followup/dailyDigest.ts`
  - **P1** · 25м

- [ ] **T15.09** — UTM-атрибуция
  - **DoD:** сопоставление лидов с кампаниями по utm_source + utm_campaign; сохранение `attribution.campaignId`
  - **Files:** `src/ai/followup/utmMatcher.ts` + тест
  - **P0** · 30м

- [ ] **T15.10** — Обратная связь в оптимизатор (E11)
  - **DoD:** конверсии лидов проксируются в CampaignStat как `conversions` (real not fake) — оптимизатор видит настоящий CPA
  - **Files:** `src/ai/followup/statSync.ts`
  - **P0** · 30м

- [ ] **T15.11** — Rate-limit исходящих сообщений
  - **DoD:** WA лимит: 1 сообщение / 5 сек на номер; TG: 30 msg/sec; очередь через BullMQ
  - **Files:** `src/ai/followup/messageQueue.ts`
  - **P0** · 30м

- [ ] **T15.12** — Стоп-слова и блокировки
  - **DoD:** если лид пишет "стоп", "отписаться", "не пишите" → добавление в blocklist, немедленная остановка
  - **Files:** `src/ai/followup/optOut.ts` + тест
  - **P0** · 20м

- [ ] **T15.13** — Тест: полный сценарий (webhook → квалификация → эскалация)
  - **DoD:** mock CRM webhook → AI-квалификатор с mock ответами → HOT → уведомление менеджеру
  - **Files:** `tests/e2e/followup.e2e.test.ts`
  - **P0** · 45м

- [ ] **T15.14** — Метрики + документация
  - **DoD:** `leads_received`, `qualification_rate`, `hot_conversion_rate`; `docs/ai-components/followup.md`
  - **Files:** `src/ai/followup/metrics.ts`, `docs/ai-components/followup.md`
  - **P1** · 25м
