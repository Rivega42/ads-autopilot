# ТЗ: ads-autopilot — сервис автоматизации рекламы (Яндекс Директ + VK Реклама)

**Заказчик:** Роман Гудков (@Rivega42)
**Исполнитель:** Claude (Sonnet/Opus 4.7)
**Дата:** 2026-08-08
**Целевая площадка запуска:** каталог из `DEPLOY_PATH`
**Основное применение:** GrandHub Private (multi-tenant), позже — внешние клиенты

---

## 1. Цель проекта

Построить сервис, который автоматизирует до 90% рутинной работы по управлению рекламными кампаниями в **Яндекс Директ** и **VK Реклама** (новый кабинет `ads.vk.ru`):

- Создание кампаний, объявлений, ключевых слов, аудиторий
- Ежедневная оптимизация ставок и бюджетов по CPA/ROMI
- Автоматическое отключение неэффективных сущностей
- Генерация текстов объявлений LLM (Claude/DeepSeek)
- Сбор статистики, ежедневные отчёты в Telegram
- Human-in-the-loop: критичные изменения — через approval-кнопку в Telegram-боте

**Не в скоупе MVP:**
- Google Ads, myTarget legacy, Facebook Ads
- Автопрохождение модерации (только ретрай с изменением текста)
- Автоматическая генерация видеокреативов

---

## 2. Ключевые факты по API (проверено 2026-08-08)

### 2.1. Яндекс Директ API v5

| Параметр | Значение |
|---|---|
| Стоимость | Бесплатно |
| Протокол | HTTPS POST, JSON или SOAP (использовать JSON) |
| Base URL | `https://api.direct.yandex.com/json/v5/` |
| Sandbox | Есть: `https://api-sandbox.direct.yandex.com/json/v5/` |
| Авторизация | OAuth 2.0 через Яндекс ID (`Authorization: Bearer <token>`) |
| Параллельные запросы | Максимум **5** одновременных на рекламодателя |
| Rate limit | Points (units) с суточной квотой + top-up 1/24 в час |
| Лимит батча | Обычно **10 000** объектов на запрос (у Reports другой лимит) |
| Единица правки | JSON body с массивом объектов |

**Заголовки запроса:**
- `Authorization: Bearer <OAuth-token>`
- `Client-Login: <логин клиента>` — только для агентов
- `Accept-Language: ru | en`
- `Use-Operator-Units: true` — тратить units агентства, не клиента

**Заголовки ответа:**
- `Units: <spent>/<remaining>/<daily-limit>` — контроль квоты
- `RequestId` — для тикетов в поддержку

**Формат ошибок:**
```json
{"error": {"error_code": 152, "error_string": "Некорректный формат запроса", "error_detail": "..."}}
```

**Система points (units):**
- Каждый рекламодатель получает индивидуальный суточный лимит на основе активности кампаний (показы, клики, расход)
- 1/24 лимита начисляется каждый час + всё, что не потрачено за последние 23 часа
- Ошибки стоят фиксированные **20 pts** за метод
- Успешные вызовы: от 1 pt (`Dictionaries.get`, `Leads.get`) до 40 pts (`Ads.unarchive`)
- Массовые операции: `KeywordBids.set` — 2 pts за keyword, `Campaigns.add` — 3-5 pts за кампанию
- Отчёты (`Reports`) — отдельная логика (async, до 5 отчётов в очереди)
- **Правило:** первый месяц лимит скромный, растёт с активностью аккаунта. Для нового кабинета GrandHub закладываем 5000-15000 units/сут.

**Основные сервисы (~25 штук):**
- **Campaigns** — управление кампаниями (add/get/update/delete/suspend/resume/archive/unarchive)
- **AdGroups** — группы объявлений
- **Ads** — объявления (тексты, картинки)
- **AdVideos** — видеоролики для видеокампаний
- **AdImages** — картинки для объявлений
- **Keywords** — ключевые фразы
- **KeywordBids** — ставки по ключам (get/set)
- **KeywordsResearch** — прогноз/подбор (аналог Wordstat)
- **BidModifiers** — корректировки ставок (пол, возраст, регион, устройство, погода)
- **Sitelinks** — быстрые ссылки
- **Vcards** — виртуальные визитки
- **AdExtensions** — уточнения к объявлениям
- **Feeds** — фиды для динамических объявлений / смарт-баннеров
- **DynamicTextAdTargets** — условия для динамики
- **RetargetingLists** — списки ретаргетинга
- **AudienceTargets** — таргетинг на сегменты Аудиторий
- **BusinessAccounts** — Яндекс Бизнес (для локальных кампаний)
- **Clients** — клиенты агентства
- **AgencyClients** — управление кабинетами клиентов
- **Changes** — что изменилось с определённой даты (polling)
- **Dictionaries** — справочники (регионы, часовые пояса, статусы)
- **Leads** — заявки из турбо-страниц и лид-форм
- **Reports** — асинхронные отчёты (TSV)
- **Sandbox** — управление тестовой средой

**Типы кампаний:**
- `TEXT_CAMPAIGN` — текстово-графические (основной формат)
- `DYNAMIC_TEXT_CAMPAIGN` — динамические на основе фида
- `SMART_CAMPAIGN` — смарт-баннеры (retargeting по фиду)
- `MOBILE_APP_CAMPAIGN` — реклама мобильных приложений
- `CPM_BANNER_CAMPAIGN` / `CPM_VIDEO_CAMPAIGN` — медийные
- `CPM_DEALS_CAMPAIGN` — сделки в РСЯ
- `UNIFIED_CAMPAIGN` — единая перф-кампания

**Стратегии ставок (в объекте Campaign):**
- `HIGHEST_POSITION` — макс. позиция
- `WB_MAXIMUM_CLICKS` / `WB_MAXIMUM_CONVERSION_RATE` — авто-клики/конверсии на поиске
- `NETWORK_DEFAULT` — стандарт в РСЯ
- `AVERAGE_CPA` / `AVERAGE_CPC` / `AVERAGE_ROI` — целевые
- `WEEKLY_CLICK_PACKAGE` — недельный пакет кликов
- `SERVING_OFF` — показы выключены

**Отчёты:**
- Асинхронные, ставим в очередь → ждём готовности → скачиваем TSV
- Формат запроса: JSON с `SelectionCriteria`, `FieldNames`, `ReportType`, `DateRangeType`, `Format`, `IncludeVAT`
- Типы отчётов: `AD_PERFORMANCE_REPORT`, `CAMPAIGN_PERFORMANCE_REPORT`, `SEARCH_QUERY_PERFORMANCE_REPORT`, `CUSTOM_REPORT` и др.
- Основные метрики: `Impressions`, `Clicks`, `Cost`, `Ctr`, `AvgCpc`, `AvgImpressionPosition`, `Conversions`, `CostPerConversion`, `Revenue`, `ProfitBid`, `Bounces`, `AvgPageviews`, `SessionDepth`
- Срезы: `CampaignId`, `AdGroupId`, `AdId`, `Keyword`, `Criterion`, `Date`, `Device`, `Age`, `Gender`, `RegionId`, `CarrierType`, `Hour`, `Position`
- Задержка данных: 3-4 часа для полноты
- **Задержка на конверсии из Метрики: до 21 дня.** Использовать `AttributionModel: LSC` (last significant click)

**Модерация:**
- Статусы объявлений: `DRAFT`, `MODERATION`, `PREACCEPTED`, `ACCEPTED`, `REJECTED`
- Поле `StatusClarification` содержит причину отклонения
- Автоматический ретрай: изменить текст → `Ads.update` → повторная модерация

**Sandbox:**
- Есть, полностью функциональный
- Кампании в песочнице не показываются реальным пользователям
- Все методы работают, units не тратятся
- Использовать для отладки перед прод-релизом

### 2.2. VK Реклама API (ads.vk.ru — новый кабинет)

⚠️ **Важно не путать!** У VK три разных API:
- `api.vk.com/method/ads.*` — СТАРЫЙ кабинет vk.com/ads (deprecated, работает по инерции)
- `ads.vk.ru/api/v2/*` — **НОВЫЙ кабинет** ads.vk.ru (используем этот)
- `target.my.com` — myTarget legacy (в процессе миграции в ads.vk.ru)

| Параметр | Значение |
|---|---|
| Стоимость | Бесплатно |
| Base URL | `https://ads.vk.ru/api/v2/` |
| Sandbox | **Нет** — тестируем на боевом с минимальным бюджетом |
| Авторизация | OAuth 2.0, 3 схемы (см. ниже) |
| Access token TTL | 24 часа (86400 сек) |
| Refresh token TTL | 30 дней (после неиспользования удаляется) |
| Одновременных токенов | Максимум **5** на пару `client_id + user` |
| Требования к клиенту | Заполненные и промодерированные реквизиты (юрлицо/ИП/самозанятый/физлицо) |

**Три схемы OAuth:**

1. **Client Credentials Grant** — свой кабинет, простейшая
   ```
   POST /api/v2/oauth2/token.json
   grant_type=client_credentials&client_id=...&client_secret=...
   ```

2. **Agency Client Credentials Grant** — агентство → клиент из своего списка
   ```
   grant_type=agency_client_credentials&client_id=...&client_secret=...&agency_client_name=<user_id>
   ```

3. **Authorization Code Grant** — доступ к чужим кабинетам (нужно отдельное одобрение VK)
   - Redirect user → `/api/v2/oauth2/authorize.json?client_id=...&redirect_uri=...&scope=...`
   - Получить `code` → обменять на token

**Права (scope):**
- `read_ads` — чтение статистики и настроек кампаний
- `read_payments` — баланс и транзакции
- `create_ads` — создание/редактирование кампаний, баннеров, аудиторий

⚠️ **client_secret показывается ОДИН РАЗ на 10 минут при выдаче.** Потерял — запрашивать заново.

**Основные объекты и endpoints:**

| Объект | Endpoint | Назначение |
|---|---|---|
| **AdPlan** | `/api/v2/ad_plans` | «Кампания» в терминологии VK (верхний уровень) |
| **AdGroup** | `/api/v2/ad_groups` | Группа объявлений (таргетинг + ставка) |
| **Banner** | `/api/v2/banners` | Собственно креатив (текст + медиа + кнопка) |
| **Content** | `/api/v2/content/*` | Загрузка изображений/видео/аудио |
| **User (Segment)** | `/api/v2/remarketing/users_lists` | Загрузка списков контактов (email/phone SHA-256) |
| **Segments** | `/api/v2/remarketing/segments` | Сегменты аудиторий (LAL, ретаргетинг, интересы) |
| **RemarketingCounters** | `/api/v2/remarketing/counters` | VK Пиксель |
| **Goals** | `/api/v2/remarketing/goals` | Цели пикселя для конверсий |
| **LookalikeAudience** | `/api/v2/remarketing/lookalike_audiences` | LAL из готовых аудиторий |
| **LeadForm** | `/api/v2/lead_forms` | Лид-формы |
| **Statistics** | `/api/v2/statistics/*` | Статистика (см. ниже) |
| **Transaction** | `/api/v2/transactions` | Финансы |
| **AgencyClients** | `/api/v2/agency/clients` | Клиенты агентства |
| **Region** | `/api/v2/regions` | Справочник гео |
| **OrdPartnerPad** | `/api/v2/ord/*` | Маркировка рекламы (обязательно для РФ) |

**Иерархия:** `AdPlan (кампания) → AdGroup (группа) → Banner (объявление)`

**Форматы объявлений:**
- Универсальная запись (текст + картинка/карусель/видео)
- Реклама сайта / приложения / VK-сообщества
- Лид-формы (без ухода из VK)
- Каталог товаров (динамика по фиду)
- Промо-посты (Boosted Posts)
- Видеореклама / OLV

**Модели оплаты:**
- CPM (за 1000 показов)
- CPC (за клик)
- oCPM (оптимизированный CPM под целевое действие)
- Автоставка (bid_strategy: `auto_bid` / `min_price`)

**Статистика:**
- Endpoint: `/api/v2/statistics/{object_type}/{id}/{granularity}.json`
- `object_type`: `ad_plans`, `ad_groups`, `banners`
- `granularity`: `day`, `summary`
- Метрики: `shows`, `clicks`, `spent`, `conversions`, `goals`, `ctr`, `cpm`, `cpc`, `cpa`, `video_started`, `video_played_25/50/75/100`
- Срезы: пол, возраст, гео, площадки, устройства, время суток
- Задержка данных: 1-3 часа (базовые), до суток (полная конверсионная воронка)
- Батч: до 200 объектов в одном запросе

**Модерация:**
- Статусы баннеров: `active`, `deleted`, `blocked`, `pending_moderation`, `rejected`
- Поле `moderation_status` + `moderation_reason_type`
- Ретрай — только через удаление и создание заново (в отличие от Директа)

**Rate limits:**
- Официально: **5 req/sec** на access_token
- 429 → exponential backoff (2^n сек)
- Batch-операции предпочтительнее одиночных

**Маркировка (ОРД) — обязательна для РФ с 01.09.2022:**
- Все креативы должны иметь маркировку через ЕРИР
- В API есть методы `OrdPartnerPad/ActStat` для передачи данных ОРД
- Для GrandHub Private — прописать в MVP как обязательный шаг

### 2.3. Яндекс Метрика API (для конверсий)

- **Reporting API:** `https://api-metrika.yandex.net/stat/v1/data`
- OAuth 2.0 через Яндекс ID (тот же токен, что для Директа, с scope Metrika)
- Основной кейс: получение конверсий по целям для attribution в Директе
- Rate limit: 5000 запросов/сут для базового аккаунта

### 2.4. VK Пиксель (для конверсий)

- Устанавливается на сайт клиента (JS)
- Цели создаются в кабинете ads.vk.ru
- В API доступны через `remarketing/goals`
- События автоматически подтягиваются в статистику

---

## 3. Архитектура сервиса

### 3.1. Общая схема

```
┌─────────────────────────────────────────────────────────┐
│  Telegram Bot (approval + отчёты)                      │
│  ↑                              ↓                       │
│  Node.js / Grammy                                       │
└─────────────────────────────────────────────────────────┘
              │                              │
              │ approvals                    │ notifications
              ↓                              ↑
┌─────────────────────────────────────────────────────────┐
│  ads-autopilot core (Node.js + TypeScript)             │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │Yandex    │ │VK        │ │LLM       │ │Optimizer │  │
│  │Direct    │ │Ads       │ │(Claude/  │ │(rules +  │  │
│  │Client    │ │Client    │ │DeepSeek) │ │ML)       │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
│         │           │           │            │          │
│         └───────────┴───────────┴────────────┘          │
│                        │                                │
└────────────────────────┼────────────────────────────────┘
                         │
                         ↓
                  ┌──────────────┐
                  │ PostgreSQL   │
                  │  + BullMQ    │
                  │  (Redis)     │
                  └──────────────┘
                         │
                         ↓
                  ┌──────────────┐
                  │ Next.js UI   │
                  │ dashboard    │
                  └──────────────┘
```

### 3.2. Компоненты

| Модуль | Ответственность | Файлы |
|---|---|---|
| `clients/yandex-direct` | HTTP-клиент, retry, units budget, Sandbox mode | `clients/yandex/*.ts` |
| `clients/vk-ads` | HTTP-клиент, refresh_token, batch | `clients/vk/*.ts` |
| `clients/metrika` | Получение конверсий по целям | `clients/metrika.ts` |
| `campaigns` | CRUD кампаний, версионирование настроек | `campaigns/*.ts` |
| `creatives` | Генерация текстов через LLM, вариации A/B | `creatives/*.ts` |
| `keywords` | Подбор через Wordstat/KeywordsResearch, минус-слова | `keywords/*.ts` |
| `optimizer` | Правила: CPA > target → pause, ROMI < 0.5 → cut bid | `optimizer/*.ts` |
| `reporter` | Ежедневный отчёт в Telegram, дашборд | `reporter/*.ts` |
| `moderation` | Отслеживание статусов, авто-ретрай | `moderation/*.ts` |
| `approval` | Human-in-the-loop через TG-бота | `approval/*.ts` |
| `scheduler` | Крон-задачи через BullMQ | `scheduler/*.ts` |
| `db` | Prisma схема, миграции | `prisma/*` |
| `web` | Next.js дашборд | `web/*` |

### 3.3. Схема БД (PostgreSQL, Prisma)

```prisma
model Client {
  id              String   @id @default(cuid())
  name            String
  yandexLogin     String?
  yandexToken     String?  @db.Text // encrypted
  vkClientId      String?
  vkClientSecret  String?  @db.Text // encrypted
  vkAccessToken   String?  @db.Text // encrypted
  vkRefreshToken  String?  @db.Text // encrypted
  vkAccountId     String?
  metrikaCounter  Int?
  targetCPA       Decimal? // основная цель оптимизации
  targetROMI      Decimal?
  dailyBudget     Decimal
  approvalChatId  String   // Telegram chat_id для апрувов
  createdAt       DateTime @default(now())
  campaigns       Campaign[]
}

model Campaign {
  id              String   @id @default(cuid())
  clientId        String
  client          Client   @relation(fields: [clientId], references: [id])
  channel         Channel  // YANDEX_DIRECT | VK_ADS
  externalId      String   // ID в API рекламной системы
  name            String
  type            String   // TEXT_CAMPAIGN, SMART_CAMPAIGN, etc.
  status          String
  strategy        Json
  dailyBudget     Decimal
  meta            Json     // произвольные настройки
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  adGroups        AdGroup[]
  stats           CampaignStat[]
  changes         ChangeLog[]
}

model AdGroup {
  id              String   @id @default(cuid())
  campaignId      String
  campaign        Campaign @relation(fields: [campaignId], references: [id])
  externalId      String
  name            String
  targeting       Json
  ads             Ad[]
  keywords        Keyword[]
}

model Ad {
  id              String   @id @default(cuid())
  adGroupId       String
  adGroup         AdGroup  @relation(fields: [adGroupId], references: [id])
  externalId      String
  title           String
  text            String
  imageUrl        String?
  moderationStatus String
  moderationReason String?
  llmVariant      String?  // для A/B
  createdAt       DateTime @default(now())
}

model Keyword {
  id              String   @id @default(cuid())
  adGroupId       String
  adGroup         AdGroup  @relation(fields: [adGroupId], references: [id])
  externalId      String
  phrase          String
  bid             Decimal
  status          String
}

model CampaignStat {
  id              String   @id @default(cuid())
  campaignId      String
  campaign        Campaign @relation(fields: [campaignId], references: [id])
  date            DateTime
  impressions     Int
  clicks          Int
  cost            Decimal
  conversions     Int
  cpa             Decimal?
  ctr             Decimal?
  @@unique([campaignId, date])
}

model ChangeLog {
  id              String   @id @default(cuid())
  campaignId      String?
  campaign        Campaign? @relation(fields: [campaignId], references: [id])
  action          String   // pause, resume, bid_change, budget_change, ...
  before          Json
  after           Json
  reason          String
  approvedBy      String?  // Telegram username или "auto"
  createdAt       DateTime @default(now())
}

model PendingApproval {
  id              String   @id @default(cuid())
  clientId        String
  action          String
  payload         Json
  chatId          String
  messageId       String?
  status          String   // pending | approved | rejected | expired
  createdAt       DateTime @default(now())
  respondedAt     DateTime?
}

enum Channel { YANDEX_DIRECT VK_ADS }
```

### 3.4. Расписание задач (BullMQ)

| Задача | Периодичность | Что делает |
|---|---|---|
| `fetch-stats-hourly` | каждый час | Забирает свежую статистику по всем клиентам, пишет в `CampaignStat` |
| `check-moderation` | каждые 30 мин | Опрашивает статусы объявлений на модерации, ретраит отклонённые |
| `optimize-bids` | раз в сутки, 08:00 МСК | Применяет правила оптимизации, изменения >20% через approval |
| `pause-losers` | раз в сутки, 03:00 МСК | Ставит на паузу ключи/объявления с CPA > 3× target и impressions > 500 |
| `wordstat-mine` | раз в 3 дня | Тянет search queries, добавляет минус-слова автоматом |
| `daily-report` | ежедневно, 08:30 МСК | Отчёт в Telegram: расход, лиды, CPA по кампаниям, топ проблем |
| `refresh-vk-tokens` | каждые 20 часов | Обновляет VK access_token через refresh_token |

### 3.5. Правила оптимизации (MVP)

**Автоматически (без апрува):**
- Пауза ключа/объявления, если `impressions > 500` И `CPA > 3 × target` за последние 7 дней
- Снижение ставки на 15%, если `CPA > 1.5 × target` И `impressions > 200`
- Повышение ставки на 10%, если `CPA < 0.7 × target` И `daily_cost < daily_budget × 0.5`
- Добавление минус-слов из search queries, где `CTR < 0.5%` И `clicks > 5`

**Через approval в Telegram:**
- Создание новой кампании
- Изменение дневного бюджета >20%
- Массовое отключение (>10 сущностей)
- Изменение стратегии кампании
- Загрузка новых креативов, сгенерированных LLM

**Формат апрув-запроса в TG:**
```
🔔 Апрув требуется: <клиент>
Действие: Снизить бюджет кампании "SEO услуги" с 5000 до 3000 ₽/сут
Причина: CPA 850 ₽ vs целевой 500 ₽ (7 дней)

[✅ Одобрить] [❌ Отклонить] [ℹ️ Детали]
```

### 3.6. Обработка ошибок

**Яндекс Директ:**
- `error_code: 152` (Bad Request) → лог + skip
- `error_code: 53` (concurrent limit) → wait 1 sec, retry (макс. 3 раза)
- `error_code: 52` (out of units) → отложить задачу на 1 час
- HTTP 5xx → exponential backoff (2^n сек, макс 3 попытки)
- HTTP 401 → инвалидировать токен, отправить алерт в TG

**VK Реклама:**
- HTTP 429 → exponential backoff
- HTTP 401 → попытка refresh_token, если провал — алерт
- Ошибки валидации → лог с телом ответа, skip

**Общее:**
- Все ошибки в таблицу `ErrorLog` с полным контекстом
- >10 ошибок за 5 минут → алерт в TG
- Идемпотентность: любая операция должна выдерживать повторный запуск

---

## 4. Технологический стек

| Слой | Технология | Обоснование |
|---|---|---|
| Язык core | **TypeScript + Node.js 22** | Совпадает со стеком GrandHub, легко переиспользовать модули |
| Веб-фреймворк API | **Fastify** | Быстрый, TS-friendly |
| Дашборд | **Next.js 14** | Тот же стек, что и GrandHub |
| БД | **PostgreSQL 16** | Уже развёрнут |
| ORM | **Prisma** | Уже в проектах Романа |
| Очереди | **BullMQ + Redis** | Уже развёрнут |
| Telegram | **Grammy** | Уже используется в GrandHub |
| Тесты | **Vitest** | Уже в стеке |
| LLM | Claude Sonnet 4.6 (тексты) / DeepSeek (массово) | Через OpenClaw gateway или напрямую |
| Секреты | `.env` + шифрование в БД (AES-256-GCM) | Для токенов клиентов |
| Мониторинг | Логи в файл + алерты в TG | MVP без Grafana |

**Пакеты:**
- `axios` — HTTP-клиент с interceptors для units-budget
- `zod` — валидация схем ответов API
- `date-fns` + `date-fns-tz` — работа с МСК
- `p-queue` — лимит параллелизма
- `pino` — структурированные логи

---

## 5. Этапы разработки

### Milestone 1 — Фундамент (день 1-2)
- [ ] Инициализация проекта: `pnpm init`, TS, ESLint, Prettier
- [ ] Prisma-схема + миграции
- [ ] Docker Compose (Postgres + Redis)
- [ ] `.env.example`, конфиг через `zod`
- [ ] Каркас Fastify + Grammy бот
- [ ] Первый Client в БД (тест на кабинете Романа)

### Milestone 2 — Yandex Direct клиент (день 3-4)
- [ ] OAuth (получение токена через oauth.yandex.ru)
- [ ] HTTP-клиент с units budget, retry, Sandbox mode
- [ ] `Campaigns.get`, `AdGroups.get`, `Ads.get`, `Keywords.get`
- [ ] `Reports.request` — асинхронные отчёты, парсинг TSV
- [ ] Sync-задача: тянуть все сущности клиента в БД
- [ ] Sandbox-тест: создание кампании через `Campaigns.add`

### Milestone 3 — VK Ads клиент (день 5-6)
- [ ] OAuth Client Credentials
- [ ] Refresh-токен job
- [ ] CRUD AdPlan / AdGroup / Banner
- [ ] Загрузка креативов (`content/upload`)
- [ ] Statistics endpoint + сохранение в БД
- [ ] Тест на реальном кабинете с бюджетом 100 ₽

### Milestone 4 — Оптимизатор (день 7-8)
- [ ] Правила из раздела 3.5, покрытые тестами
- [ ] Cron `optimize-bids`, `pause-losers` через BullMQ
- [ ] `ChangeLog` записи со всеми изменениями
- [ ] Rollback: возможность отменить последнее изменение

### Milestone 5 — Approval flow (день 9)
- [ ] TG-бот с inline-кнопками
- [ ] `PendingApproval` со сроком жизни (default 2 часа)
- [ ] Хендлер callback_data → apply / reject
- [ ] Уведомления в TG об истечении

### Milestone 6 — Отчёты и дашборд (день 10-12)
- [ ] Ежедневный отчёт-скрипт (текст + inline график из `quickchart.io`)
- [ ] Next.js: список клиентов, список кампаний, графики метрик за 30 дней
- [ ] Фильтры по каналу, датам, статусу
- [ ] Экспорт отчёта в PDF/CSV

### Milestone 7 — Модерация и креативы (день 13-14)
- [ ] Polling статусов, ретрай отклонённых
- [ ] LLM-генератор заголовков и текстов
- [ ] A/B-тестирование: 3 варианта → выбор лучшего по CTR

### Milestone 8 — Прод и мониторинг (день 15)
- [ ] Docker образ + деплой на прод-сервер (хост — в `DEPLOY_HOST`)
- [ ] Systemd unit / docker-compose
- [ ] Nginx reverse-proxy для дашборда (auth через Cloudflare или basic)
- [ ] Алерты в TG на 5xx, 401, out of units

**Итого: ~15 рабочих дней при full-time. При работе по часу-два в день — 3-4 недели.**

---

## 6. Что нужно от Романа

**До старта:**
1. Активный аккаунт в Яндекс Директ с открученным бюджетом (хотя бы 1-2 тыс ₽)
2. Активный аккаунт в VK Реклама (ads.vk.ru) с заполненными реквизитами (можно через ПДБГ или ИП)
3. Счётчик Яндекс Метрики с настроенными целями
4. VK Пиксель на сайтах, где мерим конверсии
5. Целевой CPA / ROMI по каждому направлению
6. Портрет ЦА, гео, УТП, минус-города

**В процессе — запросы на доступ:**
1. Регистрация приложения на https://oauth.yandex.ru/client/new (5 мин)
2. Запрос доступа к Direct API: Настройки → API → «Запросить доступ» (одобрение 1-5 дней)
3. Запрос доступа к VK Реклама API: Настройки → «Доступ к API» → «Запросить доступ» (одобрение по опыту 1-3 дня)
4. Создать сервисный аккаунт Яндекс Метрики с правом «Гость» на счётчик

**Пароли/токены после выдачи:**
- Сохранять в `/root/.credentials/ads-tokens.md` (chmod 600, вне git)
- Дублировать в переменные окружения `ads-autopilot`
- Ротация: раз в 3 месяца проверять срок жизни

---

## 7. Риски и митигация

| Риск | Вероятность | Митигация |
|---|---|---|
| Отказ в доступе к API (пустой кабинет) | Средняя | Сначала руками запустить кампанию на 1-2 тыс ₽, потом подавать заявку |
| Модерация режет объявления | Высокая | LLM генерит 3 варианта, ретрай с вариантом B при reject |
| Алгоритм Яндекса ломается от резких изменений ставок | Средняя | Ограничить шаг изменения ставки 20% в сутки |
| Слив бюджета из-за бага в оптимизаторе | Высокая (если без тестов) | Все правила покрыть unit-тестами, dry-run режим для новых правил, hard limit на суточный расход |
| Утечка токена клиента | Средняя | Шифрование в БД (AES-256), доступ только у сервиса, аудит-лог обращений |
| VK меняет API без уведомлений | Средняя | Мониторить changelog, все ответы валидировать через zod, при mismatch — алерт |
| Ошибка 52 (out of units) в Директе | Высокая | Кеш ответов на 1-5 мин, батчинг, приоритизация задач |
| Двойное списание бюджета из-за retry | Средняя | Идемпотентность: dedup по `Idempotency-Key` в БД |

---

## 8. Что НЕ делаем в MVP (постпродакшн)

- Мобильное приложение
- Интеграция с CRM клиента (Bitrix, amoCRM) — только через выгрузку CSV
- White-label дашборд для клиентов агентства
- Программатик-биддинг DSP уровня Adfox
- Атрибуция post-view / cross-device

**В MVP входят все каналы из раздела 12 (Директ, VK, TikTok, LinkedIn, Meta, Google, Telegram Ads) и весь Full-AI стек из раздела 13.**

---

## 9. Приёмка

**MVP считается готовым, если:**
1. По команде «запусти» кампания создаётся в песочнице Яндекс Директ через API
2. Отчёт за вчера приходит в TG в 8:30 МСК
3. Оптимизатор в ручном режиме (`--dry-run`) показывает список рекомендаций
4. Апрув в TG работает end-to-end: нажатие → изменение в кабинете
5. Дашборд отображает 30 дней истории и текущий CPA по каждой кампании
6. Пройдено 3 полных цикла ежедневной оптимизации без ручного вмешательства
7. Все токены зашифрованы, .env не в git, доступы к БД ограничены

---

## 10. Источники

**Яндекс Директ:**
- [Обзор API v5](https://yandex.ru/dev/direct/doc/ru/concepts/overview)
- [OAuth и токены](https://yandex.ru/dev/direct/doc/ru/concepts/auth-token)
- [Ограничения (units)](https://yandex.ru/dev/direct/doc/en/concepts/units)
- [Reports Spec](https://yandex.ru/dev/direct/doc/en/reports/spec)
- [Оптимальное использование](https://yandex.ru/dev/direct/doc/en/optimize)
- [Sandbox](https://yandex.ru/dev/direct/doc/en/concepts/sandbox)

**VK Реклама:**
- [Документация API](https://ads.vk.ru/doc/api/)
- [Авторизация](https://ads.vk.ru/doc/api/info/Авторизация%20в%20API)
- [Инструкция получения доступа](https://ads.vk.ru/help/features/help_api)
- [Быстрый старт](https://ads.vk.ru/doc/api/info/Быстрый%20старт)

**Яндекс Метрика:**
- [Reporting API](https://yandex.ru/dev/metrika/doc/api2/api_v1/intro.html)

---

## 11. Быстрый старт для Claude

При старте работы над проектом Claude должен:

1. `cd /root/projects/ads-autopilot`
2. Прочитать этот TZ.md полностью
3. Проверить наличие `.env` (если нет — попросить у Романа токены)
4. Создать структуру папок из раздела 3.2
5. Начать с Milestone 1
6. Каждый milestone завершать коммитом с осмысленным описанием
7. Тесты писать ДО реализации (Vitest)
8. Все внешние API-вызовы обернуть в модуль с retry/logging
9. Ошибки не глотать — либо обработать, либо пробросить с контекстом
10. Все секреты — только через переменные окружения, никаких хардкодов

При сомнениях — спросить Романа через `sessions_send`.

---

**Файл поддерживается:** Вика (agent:main)
**Последнее обновление:** 2026-08-08

---

## 12. Дополнительные рекламные каналы

Помимо Яндекс Директ и VK Реклама, MVP покрывает следующие каналы. Все они работают по OAuth 2.0, интегрируются одним и тем же паттерном (адаптер + очередь задач).

### 12.1. TikTok Marketing API

**Статус:** доступен из РФ с оговорками (аккаунт лучше на международное юрлицо).

**Особенности:**
- Base URL: `https://business-api.tiktok.com/open_api/v1.3/`
- Авторизация: OAuth 2.0 через TikTok Developer Portal
- Требуется зарегистрировать app → sandbox → app review → production
- Business Center онбординг + верификация бизнеса
- Data-security compliance audit для высоких лимитов
- На 2026: **Upgraded Smart+ API** — единая замена legacy campaign endpoints, объединяет ручное управление и авто-оптимизацию
- Rate limit: 10 req/sec на access_token
- VAT 20% для рекламодателей из РФ

**Возможности через API:**
- Campaigns / Ad Groups / Ads / Creatives
- Audiences (Custom, Lookalike, Interests)
- Video upload (до 500 МБ, .mp4/.mov)
- Statistics: показы, клики, CPM, CPC, CTR, video views (25/50/75/100%), engagement
- Продвинутый таргетинг: интересы, поведение, look-alike по CRM
- Smart+ campaigns — ИИ-оптимизация всего внутри TikTok

**Как получать доступ:**
1. Регистрация на developers.tiktok.com
2. Создать app → выбрать Marketing API
3. Sandbox → тесты
4. Заявка на production (обычно 1-2 недели)

### 12.2. LinkedIn Marketing API

**Статус:** доступен глобально, для РФ клиентов — через международную карту.

**Особенности:**
- Base URL: `https://api.linkedin.com/rest/`
- Авторизация: OAuth 2.0
- Access tiers: Development (до 5 аккаунтов), Standard (unlimited)
- Одобрение доступа: **4-8 недель на fast path, 3-4 месяца в среднем**
- Требует: privacy policy URL, демо интеграции, чёткий use case
- Права: `r_ads` (чтение) или `rw_ads` (запись)
- Роли в аккаунте: ACCOUNT_MANAGER, CAMPAIGN_MANAGER, CREATIVE_MANAGER

**Возможности:**
- Campaign Groups / Campaigns / Creatives / Ads
- Матерые B2B форматы: Sponsored Content, Message Ads, Dynamic Ads, Text Ads, Lead Gen Forms
- Аудитории: Matched Audiences (upload email/company list), Lookalike, Interest, Job Title, Skills, Company Size
- Statistics: impressions, clicks, spend, conversions, leads, video views
- Lead Gen Forms — сразу тянем лиды в CRM
- Optimization targets: с версии 202602 доступны qualified leads

**Как получать доступ:**
1. developer.linkedin.com → создать app
2. My Apps → Products → Advertising API → Request access
3. Заполнить форму с use case + privacy policy
4. Ждать 4-16 недель

### 12.3. Meta Ads (Facebook / Instagram) — опционально

**Статус:** для РФ заблокирован официально с 2022. **Работает только через нероссийское юрлицо + иностранную карту + VPN у серверов.** Использовать на свой риск.

**Особенности:**
- Marketing API (Graph API v20.0+)
- Base URL: `https://graph.facebook.com/v20.0/`
- OAuth 2.0 через Meta for Developers
- Business Manager + Ad Account + верификация юрлица
- Rate limit: dynamic (по impressions последних 24ч)

**Возможности:**
- Campaigns / Ad Sets / Ads / Creatives (Insights, Audiences, Custom Conversions)
- Lookalike, Custom Audiences (upload email/phone hash)
- Statistics: полный набор метрик, брейкдауны
- Advantage+ Shopping / Advantage+ App — AI-кампании внутри Meta
- Instagram Ads — через тот же API

### 12.4. Google Ads API — опционально

**Статус:** для РФ платёжки отключены с 2022. Работает через **нероссийскую платёжку + иностранное юрлицо + VPN у прокси-сервера**.

**Особенности:**
- Base URL: `https://googleads.googleapis.com/v17/`
- gRPC + REST, официальные SDK (Python, Node.js, Java)
- OAuth 2.0 через Google Cloud Console + developer token
- Approval: 1-3 недели на developer token
- MCC (My Client Center) — для агентств

**Возможности:**
- Search / Display / Shopping / Video / Discovery / Performance Max
- Все объекты через GAQL (Google Ads Query Language)
- Recommendations API — предложения оптимизации от Google
- Автоматизированные стратегии: Target CPA, Target ROAS, Maximize Conversions

### 12.5. Telegram Ads — через партнёрскую платформу

**Статус:** прямого публичного API у Telegram Ads нет. Есть варианты:
- **Через Telegram Ads Platform (Portal + Elama)** — минимальный порог 1500€, есть кабинет с полу-API
- **Через партнёров (T-Ads, Yepoda)** — API через реселлеров, ~10-15% комиссия
- **Через каналы напрямую** (buy posts) — не через API, но можно автоматизировать поиск/анализ каналов (TGStat API)

**Что реалистично сделать:**
- Мониторинг статистики через TGStat API (`https://api.tgstat.ru/`)
- Автоподбор каналов по нише через TGStat
- Ручной запуск через партнёров, но с автосбором отчётов

### 12.6. myTarget — устаревает, но пока живой

- API: `https://target.my.com/api/v2/`
- В 2025 продолжается миграция всех кабинетов в ads.vk.ru
- Для новых клиентов НЕ подключать — сразу ads.vk.ru
- Для существующих кабинетов — поддерживаем чтение статистики до полного deprecation

### 12.7. Сводная таблица каналов

| Канал | API | Из РФ | Одобрение | Приоритет MVP |
|---|---|---|---|---|
| Яндекс Директ | v5 | ✅ | 1-5 дней | 🔥 1 |
| VK Реклама | v2 | ✅ | 1-3 дня | 🔥 1 |
| TikTok Marketing | v1.3 | ⚠️ (VAT 20%) | 1-2 недели | 🟡 2 |
| LinkedIn Marketing | REST | ✅ (за инвалюту) | 4-16 недель | 🟡 3 |
| Meta (FB/IG) | Graph v20 | ❌ (нужен VPN + инвалюта) | 1-4 недели | 🔴 4 (опц.) |
| Google Ads | v17 | ❌ (нужна инвалюта) | 1-3 недели | 🔴 4 (опц.) |
| Telegram Ads | нет офиц. | ⚠️ (через партнёров) | сразу | 🟢 5 (доп.) |
| myTarget | v2 | ✅ | не нужно | ⚪ deprecated |

**MVP приоритет:** Директ + VK (🔥) → TikTok (когда клиент попросит) → LinkedIn (только B2B). Meta/Google — только если у клиента уже есть работающий кабинет.

---

## 13. Full-AI режим (переработка раздела 3.5)

Ключевое изменение относительно v1: **всё, что можно делегировать AI-агенту, делегируется.** Человек участвует только в трёх точках: постановка целей, апрув крупных трат, стратегический разбор раз в месяц.

### 13.1. AI-Онбординг клиента

**Раньше руками:** портрет ЦА, УТП, минус-города, целевые действия.
**Теперь:** AI-агент проводит структурированное интервью в TG-боте (15-20 вопросов адаптивно) → на выходе полностью заполненный `ClientBrief` в БД.

Модель: Claude Sonnet 4.6 (умение вести диалог).

Пример потока:
```
Bot: Привет! Я — AI-медиабайер. Задам 15 вопросов, потом запущу твою рекламу.
Bot: Что продаём? Одним предложением.
User: Курсы английского для айтишников
Bot: Классно. Кто твой клиент? Возраст, доход, где живёт?
...
Bot: Есть аналитика конкурентов? Если нет — я сам соберу за 10 минут.
Bot: Готово. Собрал 47 фактов о нише. Целевой CPA какой ставим?
User: 2000 ₽
Bot: OK. Дневной бюджет?
User: 5000 ₽ на канал
Bot: Могу стартовать? [Да] [Хочу поменять]
```

### 13.2. AI-Стратег: план кампании

**Модель:** Claude Opus 4.7 или GPT-4o (сложные reasoning-задачи).

**Что делает:**
1. Анализирует нишу через SerpAPI / Яндекс XML / Wordstat API
2. Парсит топ-10 конкурентов в поисковой выдаче
3. Скачивает их лендинги, анализирует УТП, ценообразование, оферы
4. Смотрит платные позиции конкурентов в Директе (через сервисы типа Advse, spywords) — если есть API
5. Формирует план: какие форматы, какие сегменты, какие бюджеты
6. Отдаёт на апрув в TG (одним нажатием)

**Пример вывода:**
```
📊 План кампании: Курсы английского для IT

Рекомендую разбить бюджет 15000 ₽/сут:
• Директ Поиск (60%): бренд + горячие запросы «курсы английского для программистов»
• Директ РСЯ (25%): retarget посетителей сайта
• VK Реклама (15%): look-alike по CRM + интересы «IT-специалисты»

Целевой CPA 2000 ₽ достижим при CR лендинга ≥ 5%.
Прогноз: 7-10 лидов/день, окупаемость через 30 дней.

[✅ Запустить] [🔧 Настроить] [❌ Пересчитать]
```

### 13.3. AI-Креативы (тексты + изображения + видео)

**Полностью автоматизировано.**

**Тексты:**
- Модель: Claude Sonnet 4.6
- Пишет 5-10 вариантов заголовков + описаний под каждый сегмент
- A/B тест на 500 показов → лучший идёт в продакшн
- Знает правила Директа (33 символа заголовок, 81 текст) и VK (форматы)

**Изображения:**
- Модель: DALL-E 3 (для Meta/TikTok/международных) или **Kandinsky 3.1 / YandexART** (для РФ-кабинетов)
- Генерит баннеры под все форматы (300×250, 1080×1080, 1200×628, 9:16 для сторис)
- Использует фирменную палитру + лого клиента (клиент загружает 1 раз)
- 3-5 вариантов на объявление, автоматический выбор победителя по CTR

**Видео:**
- Runway Gen-3 / Sora / Kling AI / **Sber Kandinsky Video** (для РФ)
- 15-30 секундные ролики для VK, TikTok, YouTube Shorts
- Из статичных картинок → анимация, либо text2video
- Автоматическое озвучание через ElevenLabs / SberTTS
- Автоматические субтитры (Whisper API)

**Стоимость на 1 объявление:**
- Тексты: ~$0.05
- 3 изображения: ~$0.15
- 1 видео 15 сек: ~$0.50
- **Итого:** ~$0.70 (60 руб) на полный набор креативов

### 13.4. AI-Модератор

**Раньше:** ретрай отклонённых объявлений с человеком.
**Теперь:** AI-агент сам:
1. Читает `moderation_reason` от Директа/VK
2. Классифицирует запрет (медицина / финансы / «лучший» / шокирующий контент / etc.)
3. Из базы 200+ правил формирует safe-версию текста
4. Отправляет заново
5. При повторном отклонении — пробует другой вариант из очереди
6. После 3 неудач — эскалирует человеку с подробным разбором

Правила модерации ведутся как knowledge base — LLM подтягивает актуальные при генерации.

### 13.5. AI-Оптимизатор ставок (заменяет rule-based)

**Раньше:** статичные пороги (CPA > 1.5× → снизить на 15%).
**Теперь:** ML-модель + LLM-агент.

**Стек:**
- Базовый уровень: rule-based (быстрые правила безопасности)
- ML: LightGBM модель, обучается на исторических данных клиента
- Верхний уровень: LLM-агент читает контекст (weekly ROMI, сезонность, тренды) и принимает решение

**Ограничения безопасности:**
- Изменение ставки за сутки ≤ 30% (было 20%)
- Дневной бюджет hard limit = целевой + 20%
- Ежесекундный лимит расхода (защита от рантайм-ошибки)

### 13.6. AI-Аналитик (стратегический)

**Раз в неделю** LLM-агент:
1. Смотрит все метрики за 7 дней
2. Сравнивает с предыдущей неделей
3. Ищет аномалии (провалы, всплески)
4. Читает контекст: новости ниши, сезонность, действия конкурентов
5. Пишет отчёт-разбор в TG: что произошло, почему, что делать

Пример:
```
📈 Недельный разбор (01.08 — 07.08)

Расход: 87 200 ₽ (+12% к прошлой)
Лиды: 47 (+30%)
CPA: 1855 ₽ (было 2412 ₽) — 🎉 достигли цели

Что сработало:
✅ Новая связка «TypeScript курсы» в РСЯ дала CPA 1200 ₽
✅ Look-alike по CRM в VK стрельнул — 12 лидов по 1600 ₽

Что проседает:
⚠️ Поисковая кампания «английский с нуля» — CPA 3800 ₽, много нецелевых кликов
   → Предлагаю переработать семантику. [Начать пересборку]

Планы на след. неделю:
1. Масштабировать успешную РСЯ-связку ×2 бюджета
2. Пересобрать поисковую кампанию через AI-Wordstat
3. Тест новых креативов (DALL-E сгенерил 6 вариантов) [Посмотреть]
```

### 13.7. AI-Конкурентная разведка (weekly)

Модель: GPT-4o / Claude Opus 4.7 + tools (WebSearch, WebFetch).

**Что делает:**
- Раз в неделю парсит топ-10 конкурентов в Директе / VK / TikTok
- Скачивает их объявления (через SpyWords API, VK Ad Preview, TikTok Creative Center)
- LLM анализирует: какие оферы, какие креативы, какие УТП
- Пишет summary: что нового появилось, что уходит с рынка, какие тренды
- Если находит успешный ход — предлагает адаптировать (не копировать!)

### 13.8. AI-Wordstat (семантическое ядро)

Заменяет ручной подбор ключей.

**Как работает:**
1. Есть seed-фраза от AI-Онбординга («курсы английского»)
2. LLM генерит 200 семантически близких формулировок (включая long-tail)
3. Проверяет частоты через Wordstat API
4. Кластеризует через embedding-модель (bge-m3)
5. Отбирает конверсионные (по историческим данным CTR/CR)
6. Пишет минус-слова заранее

Раз в неделю обновляет ядро с учётом новой статы.

### 13.9. AI-Follow-up для лидов (для B2B)

- Клиент оставил заявку через LinkedIn Lead Form / VK Лид-форму / Директ Лид-форму
- AI-агент через 5 минут пишет персональное сообщение в мессенджер (WhatsApp/Telegram)
- Отвечает на первичные вопросы, назначает встречу
- В CRM (или гугл-таблицу) сохраняет transcript
- Эскалирует человеку только реально готовых к покупке

### 13.10. AI-Мониторинг новостей и трендов

Модель: Claude Sonnet + RSS/WebSearch.

**Что делает:**
- Мониторит новостной фон по ключевым темам ниши
- Если конкурент запускает акцию → уведомляет в TG
- Если появляется новый тренд (например, «онлайн-курсы по AI» стрельнули) → предлагает воспользоваться
- Отслеживает изменения в правилах рекламных площадок (Директ обновил модерацию → сразу видим)

### 13.11. Что остаётся человеку

**Только три точки контакта:**

1. **Первичный онбординг (15 мин)** — ответить на вопросы AI-интервьюера
2. **Апрув крупных изменений (2-3 мин/раз в 2-3 дня)** — нажать ✅/❌ в TG
3. **Стратегический разбор (30 мин/месяц)** — обсудить с AI куда двигаемся

Всё остальное — AI сам.

### 13.12. Обновлённая экономика

- **Раньше** (v1): медиабайер экономил 30-50к/мес
- **Теперь** (Full-AI): полный автономный агент, клиенту нужно 30 мин/месяц + подписка 15-30к/мес
- Для тебя: маржа + возможность вести 20-50 клиентов одним сервисом без наёма людей

### 13.13. Новые milestones (дополнение к разделу 5)

**Milestone 9 — AI-Онбординг (день 16-17)**
- TG-бот с диалоговым интервью
- Prompt engineering для сбора ClientBrief
- Валидация ответов через structured output

**Milestone 10 — AI-Креативы (день 18-20)**
- Интеграция с Kandinsky / YandexART / DALL-E 3
- Интеграция с Runway / Kandinsky Video
- Пайплайн: brief → 5 текстов → 5 картинок → 2 видео → A/B тест

**Milestone 11 — AI-Модератор (день 21-22)**
- Knowledge base правил модерации
- Классификатор причин отклонения
- Автогенерация safe-версий

**Milestone 12 — AI-Стратег (день 23-25)**
- Интеграция с SerpAPI / Яндекс XML / SpyWords
- Парсинг конкурентов
- Генерация плана кампании

**Milestone 13 — AI-Аналитик и отчёты (день 26-27)**
- Weekly LLM-разбор
- Аномалии в статистике
- Предложения по оптимизации

**Milestone 14 — Multi-channel адаптеры (день 28-32)**
- TikTok Marketing API
- LinkedIn Marketing API
- Google Ads (для клиентов с инвалютой)
- Meta Marketing API (для клиентов с VPN-инфрой)
- TGStat + Telegram Ads (через партнёров)

**Итого Full-AI MVP: ~32 рабочих дня (6-7 недель full-time).**

---

## 15. Импорт существующих кампаний

> **Ключевое требование:** система обязана подхватывать уже запущенные кампании без остановки открутки и потери накопленной статистики.

### 15.1. Принцип «не навреди»

При подключении нового клиента, у которого уже есть активные кампании, система действует в **режиме наблюдателя (read-only)** минимум 72 часа:

- Только читает данные, ничего не меняет
- Накапливает baseline: CTR, CPA, расход, конверсии за каждый день
- Строит карту зависимостей (кампании → группы → объявления → ключи)
- AI-аналитик составляет «портрет текущего состояния» (что работает, что нет)
- На 4-й день предлагает план первых изменений — клиент одобряет или отклоняет

### 15.2. Процесс онбординга существующего аккаунта

```
Клиент подключает OAuth-токен
        ↓
[IMPORT] Обнаружение и загрузка структуры
        ↓
[ANALYZE] 72-часовое наблюдение (read-only)
        ↓
[AUDIT] AI-аудит: что менять, что не трогать
        ↓
[APPROVE] Клиент одобряет план
        ↓
[HANDOVER] Система берёт управление
```

### 15.3. Модуль обнаружения (Campaign Discovery)

#### Яндекс Директ

```typescript
// Порядок загрузки через Direct API v5
1. Campaigns.get()     — все кампании (ACTIVE, SUSPENDED, PAUSED)
2. AdGroups.get()      — группы объявлений для каждой кампании
3. Ads.get()           — объявления (тексты, изображения, ссылки)
4. Keywords.get()      — ключевые фразы
5. BidModifiers.get()  — корректировки ставок
6. KeywordBids.get()   — текущие ставки
7. Sitelinks.get()     — быстрые ссылки
8. AdExtensions.get()  — уточнения, промоакции
// Итого: ~8 API-запросов на аккаунт
```

#### VK Реклама

```typescript
// Порядок загрузки через VK Ads API
1. GET /api/v3/plans/         — рекламные планы (аналог кампаний)
2. GET /api/v3/groups/        — группы объявлений
3. GET /api/v3/banners/       — баннеры (объявления)
4. GET /api/v3/statistics/    — статистика за последние 30 дней
// Параметр include_archived=false — только активные
```

### 15.4. Схема данных импорта

Дополнение к Prisma-схеме (добавить поле `externalId` и `importedAt`):

```prisma
model Campaign {
  // ... существующие поля ...
  externalId    String?   // ID кампании в рекламной системе
  importedAt    DateTime? // когда импортировали
  importSource  String?   // "yandex_direct" | "vk_ads" | "tiktok"
  baselineData  Json?     // snapshot статистики на момент импорта
  auditResult   Json?     // результат AI-аудита
  handoverAt    DateTime? // когда система взяла управление
  handoverMode  String    @default("observer") // "observer" | "managed"
  
  @@unique([externalId, importSource, clientId])
}
```

### 15.5. AI-аудит существующих кампаний

После 72 часов наблюдения AI-Стратег (Claude Opus 4.7) получает контекст:

```
Системный промпт: ты опытный медиабайер, проводишь аудит рекламного аккаунта.
Не предлагай революционных изменений — только то, что даст результат 
за 2-4 недели без риска сломать обучение алгоритмов.

Данные для анализа:
- Статистика за 30 дней по каждой кампании (CTR, CPC, CPA, конверсии)
- Текущие ставки vs рекомендованные Яндексом
- Поисковые запросы, приносящие расход без конверсий
- Ключи с показами < 10 за 30 дней (кандидаты на архив)
- Объявления без кликов > 14 дней
- Часы/дни с нулевой конверсией (для корректировки расписания)
```

**Выходной документ аудита (JSON):**
```json
{
  "summary": "3 кампании в норме, 1 требует внимания",
  "campaignHealth": [
    {
      "id": "...",
      "name": "Кампания ПС — брендовые",
      "status": "healthy",
      "cpa_vs_target": 0.87,
      "recommendation": "не трогать 2 недели"
    },
    {
      "id": "...",
      "name": "РСЯ общие запросы",
      "status": "attention",
      "issues": ["CPA в 2.1× выше цели", "87 ключей без конверсий за 30 дней"],
      "quick_wins": [
        "отключить 87 нулевых ключей — сохранит ~8000 руб/нед",
        "добавить 23 минус-слова из поисковых запросов",
        "снизить ставку на мобайл на 20% (CR мобайла в 3× хуже)"
      ],
      "estimated_cpa_improvement": "−35%"
    }
  ],
  "firstWeekPlan": [
    "День 1: добавить минус-слова (безопасно, не ломает обучение)",
    "День 3: отключить нулевые ключи",
    "День 7: корректировка ставок по устройствам"
  ]
}
```

### 15.6. Уведомление клиента после аудита

В Telegram отправляется структурированный отчёт с кнопками:

```
📊 Аудит завершён — [Название компании]

Проанализировано: 4 кампании, 234 объявления, 1847 ключей
Период наблюдения: 72 часа (без изменений)

🟢 Работает хорошо (2):
  • Кампания ПС — брендовые: CPA 450₽ при цели 500₽
  • РСЯ — ретаргет: конверсия 8.2%

🟡 Требует внимания (1):
  • РСЯ общие запросы: CPA 1050₽ при цели 500₽
    → Предлагаю: 3 быстрых шага, −35% к CPA
    → Риск: минимальный

🔴 Проблема (1):
  • Кампания ПС — конкуренты: 0 конверсий за 30 дней
    → Предлагаю: перевести на паузу, перераспределить бюджет

💰 Потенциальная экономия в первый месяц: ~24 000 ₽

[✅ Одобрить план] [📋 Подробный отчёт] [❌ Пока не трогать]
```

### 15.7. Режим «Handover» (передача управления)

После одобрения плана:

1. **Неделя 1 — хирургия (минимальный риск):**
   - Только добавление минус-слов
   - Отключение объявлений с нулевым CTR за 30 дней
   - Без изменений ставок и бюджетов

2. **Неделя 2 — оптимизация ставок:**
   - Корректировки по устройствам, времени, гео
   - Изменения не более ±15% от текущих значений
   - Каждое изменение логируется с обоснованием

3. **Неделя 3 — полное управление:**
   - Система работает в штатном режиме автопилота
   - Все события в ChangeLog, откат доступен за 1 клик

### 15.8. Обнаружение конфликтов

Перед импортом проверяем:

| Ситуация | Действие |
|---|---|
| Аккаунт уже подключён к другой системе | Предупреждение: «Обнаружены внешние изменения» |
| Кампании с автоматическими стратегиями Яндекса | Не трогаем ставки, только минус-слова и объявления |
| Активные A/B тесты (Яндекс Эксперименты) | Не вмешиваемся до завершения теста |
| Кампании с непрошедшей модерацией | Помечаем, AI-Модератор берёт в работу |
| Нулевой бюджет / кампании на паузе | Импортируем, но управление не берём |

### 15.9. Откат (Rollback)

Любое изменение, сделанное системой, можно откатить:

```typescript
// Каждое изменение записывается в ChangeLog
{
  id: "clxxx",
  campaignId: "...",
  entityType: "keyword",    // campaign | adgroup | ad | keyword | bid
  entityId: "...",
  action: "pause",
  prevValue: { status: "ACTIVE" },
  newValue:  { status: "PAUSED" },
  reason: "CPA 3.2× выше цели, показов > 500",
  appliedAt: "2026-08-08T10:00:00Z",
  rolledBackAt: null
}
```

Кнопка «↩ Откатить» доступна для любого события в ChangeLog за последние 30 дней.

---

## 17. Источники (обновление)

**TikTok:**
- [TikTok Marketing API — Getting Started](https://business-api.tiktok.com/portal/docs)
- [Upgraded Smart+ API 2026](https://www.keyapi.ai/blog/how-to-use-tiktok-api-for-marketing-automation/)

**LinkedIn:**
- [LinkedIn Marketing API Docs](https://learn.microsoft.com/en-us/linkedin/marketing/)
- [Access Tiers](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/marketing-tiers)
- [Increasing Access](https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access)

**Meta:**
- [Marketing API Overview](https://developers.facebook.com/docs/marketing-apis/overview)

**Google Ads:**
- [Google Ads API Docs](https://developers.google.com/google-ads/api/docs/start)

**AI-креативы:**
- [Kandinsky 3.1](https://fusionbrain.ai/) — российский, есть API
- [YandexART](https://yandex.cloud/ru/services/yandexart) — российский, через Yandex Cloud
- [DALL-E 3 API](https://platform.openai.com/docs/guides/images)
- [Runway Gen-3 API](https://docs.dev.runwayml.com/)
