# E06 — VK Реклама API

**Цель:** клиент VK Ads API (ads.vk.ru) с OAuth 3 схемы, авто-refresh токена, все операции.

**Зависимости:** E03.
**DoD эпика:** можно создать план → группу → баннер, получить статистику за неделю, токен автоматически обновляется.

---

## Задачи

- [ ] **T06.01** — OAuth Client Credentials flow
  - **DoD:** `src/providers/vk/auth.ts` — `getClientToken(clientId, clientSecret)` → access_token (TTL 24h); кешируется в Redis
  - **Files:** `src/providers/vk/auth.ts` + тест
  - **P0** · 35м

- [ ] **T06.02** — OAuth Authorization Code flow (для управления кабинетами пользователей)
  - **DoD:** `getAuthUrl(state)`, `exchangeCode(code)` → access_token + refresh_token (TTL 30 дней)
  - **Files:** `src/providers/vk/auth.ts` (расширить)
  - **P0** · 30м

- [ ] **T06.03** — Token auto-refresh cron
  - **DoD:** BullMQ job каждые 20 часов проверяет токены с `expires_in < 4h`, запускает refresh; при ошибке — алерт в TG
  - **Files:** `src/providers/vk/tokenRefresher.ts` + тест
  - **P0** · 35м

- [ ] **T06.04** — HTTP-клиент VK Ads API
  - **DoD:** базовый клиент с базовым URL `https://ads.vk.com/api/v3/`, заголовком `Authorization: Bearer`, retry 3 при 5xx; парсинг `{data, error}` envelope
  - **Files:** `src/providers/vk/httpClient.ts`
  - **P0** · 30м

- [ ] **T06.05** — Сервис `PlansService` (AdPlan = кампания)
  - **DoD:** `list(accountId)`, `create(params)`, `update(id, params)`, `delete(id)`, `getStatuses`
  - **Files:** `src/providers/vk/services/PlansService.ts` + тесты (mock)
  - **P0** · 40м

- [ ] **T06.06** — Сервис `GroupsService` (AdGroup)
  - **DoD:** `list(planId)`, `create(params)`, `update`, `delete`; поддержка targeting JSON (гео, демография, интересы)
  - **Files:** `src/providers/vk/services/GroupsService.ts` + тесты
  - **P0** · 40м

- [ ] **T06.07** — Сервис `BannersService` (объявления)
  - **DoD:** `list(groupId)`, `create(params)`, `update`, `delete`; форматы: text, image, video, carousel
  - **Files:** `src/providers/vk/services/BannersService.ts` + тесты
  - **P0** · 45м

- [ ] **T06.08** — Загрузка медиа (изображения, видео)
  - **DoD:** `uploadImage(file, accountId)` → mediaId; `uploadVideo(file, accountId)` → mediaId; лимиты размеров
  - **Files:** `src/providers/vk/services/MediaService.ts` + тест
  - **P0** · 40м

- [ ] **T06.09** — Сервис статистики
  - **DoD:** `getStats(ids[], dateFrom, dateTo, granularity: day|summary)` → массив `{id, date, impressions, clicks, spend, ...}`
  - **Files:** `src/providers/vk/services/StatsService.ts` + тесты
  - **P0** · 40м

- [ ] **T06.10** — ORD-маркировка (обязательно для РФ)
  - **DoD:** `ORDService.markBanner(bannerId, erid)` — проставляет erid в баннер; автоматически вызывается при создании баннера; документация что такое ERID и где брать
  - **Files:** `src/providers/vk/services/ORDService.ts`, `docs/providers/vk-ord.md`
  - **P0** · 35м

- [ ] **T06.11** — Сервис аудиторий (Look-alike)
  - **DoD:** `uploadRetargetingList(clientIds[])`, `createLookalike(listId, reach: small|medium|large)`, `getListStatus`
  - **Files:** `src/providers/vk/services/AudienceService.ts`
  - **P1** · 40м

- [ ] **T06.12** — Типы и Zod-схемы VK Ads
  - **DoD:** `src/providers/vk/types.ts` — Plan, Group, Banner, Stat, Targeting, MediaItem; полная типизация
  - **Files:** `src/providers/vk/types.ts`
  - **P0** · 35м

- [ ] **T06.13** — Error-маппинг VK → доменные ошибки
  - **DoD:** `{error.code, error.message}` → типизированные `VkAdsError`; коды: 100 (invalid token), 600 (limit exceeded), 900+ (moderation)
  - **Files:** `src/providers/vk/errors.ts`
  - **P0** · 20м

- [ ] **T06.14** — `VkSyncService` — синхронизация аккаунта в БД
  - **DoD:** тянет plans → groups → banners, upsert через repos; логирует diff
  - **Files:** `src/services/VkSyncService.ts` + тест
  - **P0** · 50м

- [ ] **T06.15** — `VkStatCollector` — сбор статистики за вчера
  - **DoD:** StatsService за вчера по всем planId клиента, upsert в CampaignStat
  - **Files:** `src/services/VkStatCollector.ts` + тест
  - **P0** · 35м

- [ ] **T06.16** — `VkModerationPoller` — polling статуса объявлений
  - **DoD:** каждые 15 мин проверяет статус баннеров (PENDING_MODERATION|REJECTED|ACTIVE), помечает в БД
  - **Files:** `src/providers/vk/ModerationPoller.ts`
  - **P0** · 30м

- [ ] **T06.17** — Фасад `VkAdsClient`
  - **DoD:** единый класс-фасад со всеми сервисами; `create(clientId)`
  - **Files:** `src/providers/vk/VkAdsClient.ts`
  - **P0** · 20м

- [ ] **T06.18** — Интеграционный тест
  - **DoD:** smoke-test с реальным токеном (из env, skip если нет): list plans → get stats
  - **Files:** `tests/integration/vk.integration.test.ts`
  - **P1** · 35м

- [ ] **T06.19** — Rate-limit VK API (нет официальных единиц — эмпирический)
  - **DoD:** 3 rps per account-id через p-limit; при 429 — backoff 60с
  - **Files:** `src/providers/vk/rateLimiter.ts`
  - **P0** · 25м

- [ ] **T06.20** — Документация провайдера
  - **DoD:** `docs/providers/vk-ads.md` — OAuth схемы, ORD, лимиты, примеры
  - **Files:** `docs/providers/vk-ads.md`
  - **P1** · 20м
