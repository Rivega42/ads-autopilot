# E02 — База данных (Prisma)

**Цель:** полная Prisma-схема с миграциями для всех сущностей ТЗ (§9), сид тестовых данных, repository-слой.

**Зависимости:** E01.
**DoD эпика:** `pnpm prisma migrate deploy` создаёт все таблицы; репозитории покрыты unit-тестами; сид создаёт демо-клиента.

---

## Задачи

- [x] **T02.01** — Установка Prisma + драйвера pg
  - **DoD:** `prisma`, `@prisma/client`, скрипты `db:migrate`, `db:generate`, `db:studio`, `db:reset`
  - **Files:** `package.json`, `prisma/schema.prisma` (заготовка)
  - **P0** · 15м

- [x] **T02.02** — Модель `Client`
  - **DoD:** поля: id, tgUserId, tgUsername, name, createdAt, updatedAt, status (enum), industry, timezone
  - **Files:** `prisma/schema.prisma`, миграция
  - **P0** · 20м

- [x] **T02.03** — Модель `Credential` (зашифрованная)
  - **DoD:** clientId, provider (enum: YANDEX_DIRECT | VK_ADS | TIKTOK | ...), encryptedPayload (bytes), iv, tag, rotatedAt, expiresAt
  - **Files:** `prisma/schema.prisma`, миграция
  - **P0** · 20м

- [x] **T02.04** — Модель `Campaign`
  - **DoD:** id, clientId, externalId, provider, name, status (enum), dailyBudget, strategy, targetCpa, importedAt, importSource, baselineData (json), handoverMode
  - **Files:** `prisma/schema.prisma`, миграция
  - **P0** · 20м

- [x] **T02.05** — Модель `AdGroup`
  - **DoD:** id, campaignId, externalId, name, status, targetings (json)
  - **Files:** `prisma/schema.prisma`, миграция
  - **P0** · 15м

- [x] **T02.06** — Модель `Ad`
  - **DoD:** id, adGroupId, externalId, format (enum), title, body, imageUrl, videoUrl, cta, moderationStatus, moderationReason
  - **Files:** `prisma/schema.prisma`, миграция
  - **P0** · 15м

- [x] **T02.07** — Модель `Keyword`
  - **DoD:** id, adGroupId, externalId, phrase, bid, matchType (enum), status
  - **Files:** `prisma/schema.prisma`, миграция
  - **P0** · 15м

- [x] **T02.08** — Модель `CampaignStat` (тайм-серия)
  - **DoD:** id, entityType (enum: campaign|adgroup|ad|keyword), entityId, date, impressions, clicks, spend, conversions, ctr, cpc, cpa; индекс (entityId, date)
  - **Files:** `prisma/schema.prisma`, миграция
  - **P0** · 25м

- [x] **T02.09** — Модель `ChangeLog`
  - **DoD:** id, campaignId, entityType, entityId, action, prevValue (json), newValue (json), reason, appliedAt, rolledBackAt, actor (enum: SYSTEM|USER|AI)
  - **Files:** `prisma/schema.prisma`, миграция
  - **P0** · 20м

- [x] **T02.10** — Модель `PendingApproval`
  - **DoD:** id, clientId, kind (enum), payload (json), tgMessageId, expiresAt, decidedAt, decision (enum: APPROVED|REJECTED|EXPIRED)
  - **Files:** `prisma/schema.prisma`, миграция
  - **P0** · 20м

- [x] **T02.11** — Модель `AuditLog` (для доступа к credentials)
  - **DoD:** id, actor, action, resource, ip, userAgent, createdAt
  - **Files:** `prisma/schema.prisma`, миграция
  - **P0** · 15м

- [x] **T02.12** — Singleton `PrismaClient`
  - **DoD:** `src/db/prisma.ts` создаёт один экземпляр, переиспользуется во всех модулях
  - **Files:** `src/db/prisma.ts`
  - **P0** · 10м

- [x] **T02.13** — Repository: `ClientRepository`
  - **DoD:** методы `create`, `findByTgId`, `findById`, `updateStatus`; unit-тесты (in-memory pg или testcontainers)
  - **Files:** `src/repos/ClientRepository.ts`, `src/repos/__tests__/ClientRepository.test.ts`
  - **P0** · 40м

- [x] **T02.14** — Repository: `CampaignRepository`
  - **DoD:** методы `upsert`, `findByExternal`, `listByClient`, `updateHandoverMode`; unit-тесты
  - **Files:** `src/repos/CampaignRepository.ts` + тесты
  - **P0** · 40м

- [x] **T02.15** — Sid для локальной разработки
  - **DoD:** `prisma/seed.ts` создаёт клиента "Demo Roman" + 2 фейковые кампании; `pnpm db:seed` работает
  - **Files:** `prisma/seed.ts`, `package.json`
  - **P1** · 25м

- [x] **T02.16** — Prisma studio в docker-compose (профиль tools)
  - **DoD:** `docker compose --profile tools up prisma-studio` открывает :5555
  - **Files:** `docker-compose.yml`
  - **P2** · 15м
