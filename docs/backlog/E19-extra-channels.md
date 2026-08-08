# E19 — Доп. каналы

**Цель:** адаптеры TikTok, LinkedIn, Meta, Google Ads, Telegram Ads.

**Зависимости:** E03 (credentials), E11 (оптимизатор), E12 (аналитик).
**DoD эпика:** каждый канал: OAuth + Sync + Stats + минимальный набор операций.

---

## TikTok Marketing API

- [ ] **T19.01** — TikTok OAuth (Long-term token)
  - **DoD:** `src/providers/tiktok/auth.ts` — обмен code → access_token (не истекает); хранение через CredentialService
  - **Files:** `src/providers/tiktok/auth.ts` + тест
  - **P1** · 40м

- [ ] **T19.02** — TikTok HTTP client
  - **DoD:** базовый URL `https://business-api.tiktok.com/open_api/v1.3/`, заголовок `Access-Token`, retry
  - **Files:** `src/providers/tiktok/httpClient.ts`
  - **P1** · 25м

- [ ] **T19.03** — TikTok CampaignsService
  - **DoD:** get/create/update/delete + adgroups/ads (Smart+ API)
  - **Files:** `src/providers/tiktok/services/CampaignsService.ts` + тест
  - **P1** · 50м

- [ ] **T19.04** — TikTok StatsService
  - **DoD:** синхронный /reports/integrated/get/, granularity day/hour
  - **Files:** `src/providers/tiktok/services/StatsService.ts` + тест
  - **P1** · 35м

- [ ] **T19.05** — TikTok Sync + StatCollector
  - **DoD:** аналогично Яндексу и VK — синхронизация структуры + сбор статистики в CampaignStat
  - **Files:** `src/services/TikTokSyncService.ts`, `src/services/TikTokStatCollector.ts`
  - **P1** · 40м

## LinkedIn Marketing API

- [ ] **T19.06** — LinkedIn OAuth 2.0 (3-legged)
  - **DoD:** scopes `r_ads`, `rw_ads`, `r_ads_reporting`; хранение
  - **Files:** `src/providers/linkedin/auth.ts` + тест
  - **P2** · 40м

- [ ] **T19.07** — LinkedIn HTTP client
  - **DoD:** `https://api.linkedin.com/rest/`, версионирование через заголовок `LinkedIn-Version`
  - **Files:** `src/providers/linkedin/httpClient.ts`
  - **P2** · 25м

- [ ] **T19.08** — LinkedIn Campaigns/Creatives services
  - **DoD:** get/create для Campaign, CampaignGroup, Creative
  - **Files:** `src/providers/linkedin/services/*.ts` + тесты
  - **P2** · 60м

- [ ] **T19.09** — LinkedIn Reports (Ad Analytics)
  - **DoD:** finder=analytical, granularity DAILY
  - **Files:** `src/providers/linkedin/services/AnalyticsService.ts` + тест
  - **P2** · 40м

- [ ] **T19.10** — LinkedIn Sync + StatCollector
  - **DoD:** синхронизация + сбор
  - **Files:** `src/services/LinkedInSyncService.ts`, `src/services/LinkedInStatCollector.ts`
  - **P2** · 35м

## Meta Marketing API

- [ ] **T19.11** — Meta OAuth (System User token, долгоживущий)
  - **DoD:** через Business Manager; scopes `ads_management`, `ads_read`
  - **Files:** `src/providers/meta/auth.ts` + тест
  - **P2** · 40м

- [ ] **T19.12** — Meta HTTP client (Graph API v20)
  - **DoD:** `https://graph.facebook.com/v20.0/`, retry, batch requests
  - **Files:** `src/providers/meta/httpClient.ts`
  - **P2** · 30м

- [ ] **T19.13** — Meta Campaigns/AdSets/Ads services
  - **DoD:** CRUD; поддержка формата carousel, video, image
  - **Files:** `src/providers/meta/services/*.ts` + тесты
  - **P2** · 60м

- [ ] **T19.14** — Meta Insights (stats)
  - **DoD:** `/insights` endpoint, breakdowns по устройствам, гео
  - **Files:** `src/providers/meta/services/InsightsService.ts`
  - **P2** · 40м

- [ ] **T19.15** — Meta Sync + StatCollector
  - **DoD:** аналогично
  - **Files:** `src/services/MetaSyncService.ts`, `src/services/MetaStatCollector.ts`
  - **P2** · 35м

## Google Ads API

- [ ] **T19.16** — Google Ads OAuth + Developer Token
  - **DoD:** OAuth2 + developer_token; `login-customer-id` для MCC
  - **Files:** `src/providers/google/auth.ts` + тест
  - **P2** · 45м

- [ ] **T19.17** — Google Ads gRPC/REST client
  - **DoD:** через `google-ads-api` npm-package
  - **Files:** `src/providers/google/client.ts`
  - **P2** · 30м

- [ ] **T19.18** — Google Ads Campaigns/AdGroups/Ads
  - **DoD:** CRUD через GAQL + mutate
  - **Files:** `src/providers/google/services/*.ts` + тесты
  - **P2** · 60м

- [ ] **T19.19** — Google Ads Reports
  - **DoD:** GAQL queries для statistics
  - **Files:** `src/providers/google/services/ReportService.ts`
  - **P2** · 40м

- [ ] **T19.20** — Google Ads Sync + StatCollector
  - **DoD:** аналогично
  - **Files:** `src/services/GoogleSyncService.ts`, `src/services/GoogleStatCollector.ts`
  - **P2** · 35м

## Telegram Ads (партнёрство с Elama/Aitarget)

- [ ] **T19.21** — Telegram Ads: партнёрское API исследование
  - **DoD:** документ `docs/providers/telegram-ads.md` — что доступно у Elama/Aitarget через API, как получить доступ
  - **Files:** `docs/providers/telegram-ads.md`
  - **P2** · 30м

- [ ] **T19.22** — Elama API adapter (если есть)
  - **DoD:** обёртка над Elama API для Telegram Ads
  - **Files:** `src/providers/elama/*` + тесты
  - **P2** · 60м

## Общая инфраструктура

- [ ] **T19.23** — Абстракция `AdChannel` interface
  - **DoD:** `src/providers/AdChannel.ts` — единый интерфейс: sync(), collectStats(), pauseCampaign(), updateBid()...; все провайдеры implement
  - **Files:** `src/providers/AdChannel.ts`
  - **P1** · 35м

- [ ] **T19.24** — Registry провайдеров
  - **DoD:** `ChannelRegistry.get(provider) => AdChannel`; используется в оптимизаторе/аналитике для итерации по всем каналам клиента
  - **Files:** `src/providers/ChannelRegistry.ts` + тест
  - **P1** · 25м

- [ ] **T19.25** — Feature flags для каналов
  - **DoD:** env `ENABLED_CHANNELS=yandex,vk,tiktok` — включает/выключает провайдеров при старте
  - **Files:** `src/config/features.ts`
  - **P1** · 20м

- [ ] **T19.26** — Общий OAuth callback роутер
  - **DoD:** `/oauth/:provider/callback` диспатчит на нужный adapter
  - **Files:** `src/routes/oauthCallback.ts` (расширить из E04)
  - **P0** · 25м

- [ ] **T19.27** — Документация: получение доступов
  - **DoD:** `docs/providers/getting-access.md` — по каждому каналу: где регистрироваться, сколько ждёт одобрение, требования
  - **Files:** `docs/providers/getting-access.md`
  - **P1** · 40м

- [ ] **T19.28** — Валидация валют / билинга
  - **DoD:** предупреждение если у клиента RUB-баланс, но канал требует USD/EUR (Meta/Google/LinkedIn)
  - **Files:** `src/providers/currencyChecker.ts`
  - **P1** · 25м

- [ ] **T19.29** — Интеграция с оптимизатором E11
  - **DoD:** оптимизатор использует `ChannelRegistry`, работает с любым каналом единообразно
  - **Files:** `src/ai/optimizer/BidOptimizer.ts` (рефакторинг)
  - **P1** · 40м

- [ ] **T19.30** — Health-check по каналам
  - **DoD:** `/health/channels` — статус auth токенов, доступность API каждого канала
  - **Files:** `src/routes/healthChannels.ts`
  - **P1** · 25м
