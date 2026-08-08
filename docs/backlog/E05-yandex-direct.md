# E05 — Yandex Direct API v5

**Цель:** полный клиент Direct API v5 с OAuth, rate-limiter (units), sandbox, все нужные сервисы.

**Зависимости:** E03.
**DoD эпика:** можно создать кампанию в Sandbox, получить статистику, не превысить 5 rps per advertiser.

---

## Задачи

- [ ] **T05.01** — OAuth-flow Яндекса (Authorization Code)
  - **DoD:** `src/providers/yandex/auth.ts` — генерация URL, обмен code→token, сохранение через CredentialService; refresh при 401
  - **Files:** `src/providers/yandex/auth.ts` + тест
  - **P0** · 45м

- [ ] **T05.02** — HTTP-клиент Direct API (Axios + retry)
  - **DoD:** базовый клиент с хостом (sandbox|prod), заголовками `Authorization: Bearer`, `Client-Login`, `Accept-Language: ru`; retry 3 раза при 5xx/timeout; таймаут 30с
  - **Files:** `src/providers/yandex/httpClient.ts`
  - **P0** · 35м

- [ ] **T05.03** — Units rate-limiter
  - **DoD:** читает `Units` из ответных заголовков, блокирует следующий запрос если остаток < 10 (с логом); max 5 concurrent per advertiser через p-limit
  - **Files:** `src/providers/yandex/unitsLimiter.ts` + тест
  - **P0** · 35м

- [ ] **T05.04** — Сервис `CampaignsService`
  - **DoD:** методы `get(clientId, params)`, `add(clientId, campaigns[])`, `update(clientId, campaigns[])`, `suspend(clientId, ids[])`, `resume(clientId, ids[])`; Zod-схемы request/response
  - **Files:** `src/providers/yandex/services/CampaignsService.ts` + тесты (mock http)
  - **P0** · 50м

- [ ] **T05.05** — Сервис `AdGroupsService`
  - **DoD:** `get`, `add`, `update`, `delete` методы; поддержка TextGroup, SmartAdGroup
  - **Files:** `src/providers/yandex/services/AdGroupsService.ts` + тесты
  - **P0** · 40м

- [ ] **T05.06** — Сервис `AdsService`
  - **DoD:** `get`, `add`, `update`, `moderate`, `delete`; маппинг полей TextAd ↔ Prisma Ad
  - **Files:** `src/providers/yandex/services/AdsService.ts` + тесты
  - **P0** · 45м

- [ ] **T05.07** — Сервис `KeywordsService`
  - **DoD:** `get`, `add`, `update`, `delete`, `resume`, `suspend`; поддержка matchType (EXACT|BROAD|...)
  - **Files:** `src/providers/yandex/services/KeywordsService.ts` + тесты
  - **P0** · 40м

- [ ] **T05.08** — Сервис `KeywordBidsService`
  - **DoD:** `get`, `set`; чтение bid + contextBid + coverage; валидация мин. ставки
  - **Files:** `src/providers/yandex/services/KeywordBidsService.ts` + тесты
  - **P0** · 35м

- [ ] **T05.09** — Сервис `BidModifiersService`
  - **DoD:** get/set для мобайл, регион, день недели, пол/возраст, smb-аудитории
  - **Files:** `src/providers/yandex/services/BidModifiersService.ts` + тесты
  - **P1** · 40м

- [ ] **T05.10** — Сервис `NegativeKeywordsService` (единый список)
  - **DoD:** `getSharedSets`, `addToSharedSet`, `deleteFromSharedSet`, `linkToAdGroup`
  - **Files:** `src/providers/yandex/services/NegativeKeywordsService.ts` + тесты
  - **P0** · 35м

- [ ] **T05.11** — Сервис `ReportsService` (офлайн-отчёты)
  - **DoD:** `createReport(params)` — возвращает reportId; `pollReport(reportId)` — ждёт готовности (exponential backoff); `downloadReport(url)` — парсит TSV → объекты
  - **Files:** `src/providers/yandex/services/ReportsService.ts` + тесты
  - **P0** · 60м

- [ ] **T05.12** — Типы и Zod-схемы для всех сервисов
  - **DoD:** `src/providers/yandex/types.ts` — Campaign, AdGroup, Ad, Keyword, BidModifier, Stat; всё типизировано
  - **Files:** `src/providers/yandex/types.ts`
  - **P0** · 40м

- [ ] **T05.13** — `YandexSyncService` — полная синхронизация аккаунта в БД
  - **DoD:** тянет кампании → группы → объявления → ключи, upsert через CampaignRepository; логирует diff (добавлено/обновлено/удалено)
  - **Files:** `src/services/YandexSyncService.ts` + тест
  - **P0** · 60м

- [ ] **T05.14** — `YandexStatCollector` — сбор статистики за вчера
  - **DoD:** запрос ReportsService за вчерашний день, группировка по campaign/adgroup/ad, upsert в CampaignStat
  - **Files:** `src/services/YandexStatCollector.ts` + тест
  - **P0** · 45м

- [ ] **T05.15** — `SearchQueryParser` — извлечение минус-слов
  - **DoD:** ReportsService запрос SearchQueryReport, фильтр CTR < 0.5% AND clicks > 5, возвращает список кандидатов в минус
  - **Files:** `src/services/SearchQueryParser.ts` + тест
  - **P0** · 40м

- [ ] **T05.16** — Sandbox-конфиг и дымовые тесты
  - **DoD:** при `YANDEX_DIRECT_USE_SANDBOX=true` клиент идёт на `api-sandbox.direct.yandex.com`; smoke-test создаёт кампанию → получает её → удаляет
  - **Files:** `src/providers/yandex/httpClient.ts`, `tests/smoke/yandex.smoke.ts`
  - **P0** · 30м

- [ ] **T05.17** — Webhook-заглушка для модерации (polling fallback)
  - **DoD:** так как Direct не шлёт webhooks, `ModerationPoller` каждые 15 мин проверяет статус объявлений, помечает отклонённые
  - **Files:** `src/providers/yandex/ModerationPoller.ts`
  - **P0** · 35м

- [ ] **T05.18** — Error-маппинг Direct → доменные ошибки
  - **DoD:** коды 53 (token expired), 8800-8899 (units), 9000+ (object errors) → типизированные ошибки `YandexDirectError`
  - **Files:** `src/providers/yandex/errors.ts`
  - **P0** · 25м

- [ ] **T05.19** — Сервис `SitelinksService`
  - **DoD:** get/add/update/delete быстрых ссылок и их описаний
  - **Files:** `src/providers/yandex/services/SitelinksService.ts`
  - **P1** · 30м

- [ ] **T05.20** — Фасад `YandexDirectClient`
  - **DoD:** единый класс-фасад, собирающий все сервисы; инициализируется через `create(clientId)`
  - **Files:** `src/providers/yandex/YandexDirectClient.ts`
  - **P0** · 25м

- [ ] **T05.21** — Интеграционный тест (с реальным Sandbox)
  - **DoD:** тест с реальным токеном (из env, пропускается если нет); создаёт → читает → архивирует кампанию
  - **Files:** `tests/integration/yandex.integration.test.ts`
  - **P1** · 45м

- [ ] **T05.22** — Документация провайдера
  - **DoD:** `docs/providers/yandex-direct.md` — как получить токен, лимиты, известные проблемы, примеры вызовов
  - **Files:** `docs/providers/yandex-direct.md`
  - **P1** · 20м
