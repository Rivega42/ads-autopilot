# E03 — Security & credentials

**Цель:** безопасное хранение OAuth-токенов клиентов (AES-256-GCM), ротация, audit-log.

**Зависимости:** E02.
**DoD эпика:** `CredentialService` умеет seal/unseal, ключ шифрования только в env, любые обращения к credentials логируются в audit-log.

---

## Задачи

- [ ] **T03.01** — Helper `crypto/aead.ts` (AES-256-GCM)
  - **DoD:** функции `seal(plaintext, key): {ciphertext, iv, tag}` и `unseal({ciphertext, iv, tag}, key): plaintext`, iv = random 12 байт, tag = 16 байт; тесты round-trip + tamper-detection
  - **Files:** `src/crypto/aead.ts`, `src/crypto/__tests__/aead.test.ts`
  - **P0** · 30м

- [ ] **T03.02** — Loader ключа шифрования
  - **DoD:** `getEncryptionKey()` читает `CREDENTIALS_ENCRYPTION_KEY` (base64, 32 байта), падает при отсутствии или неверном размере
  - **Files:** `src/crypto/key.ts`, `src/env.ts` (добавить поле)
  - **P0** · 15м

- [ ] **T03.03** — `CredentialRepository`
  - **DoD:** методы `save`, `getForClient`, `deactivate`, `rotate`; хранит только seal(payload)
  - **Files:** `src/repos/CredentialRepository.ts` + тесты
  - **P0** · 40м

- [ ] **T03.04** — `CredentialService` фасад
  - **DoD:** `getYandexToken(clientId)`, `getVkToken(clientId)`, при отсутствии → throw `CredentialNotFoundError`
  - **Files:** `src/services/CredentialService.ts` + тесты
  - **P0** · 30м

- [ ] **T03.05** — Валидация OAuth-payload (Zod)
  - **DoD:** отдельные схемы `YandexOAuthPayload`, `VkOAuthPayload`, `TikTokOAuthPayload`
  - **Files:** `src/schemas/credentials.ts` + тесты
  - **P0** · 25м

- [ ] **T03.06** — Audit-логгер доступа к credentials
  - **DoD:** декоратор/middleware — каждое обращение к `CredentialService.get*` создаёт запись в `AuditLog`
  - **Files:** `src/services/auditLog.ts`
  - **P0** · 25м

- [ ] **T03.07** — Rate-limit на unseal (защита от бегущего процесса)
  - **DoD:** более 100 unseal/минуту на 1 clientId → warn в логи + telegram-алерт
  - **Files:** `src/services/CredentialService.ts`
  - **P1** · 25м

- [ ] **T03.08** — Ротация ключа шифрования (rekey)
  - **DoD:** CLI `pnpm rekey --old-key=... --new-key=...` пересобирает все Credential записи; dry-run по умолчанию
  - **Files:** `scripts/rekey.ts`
  - **P1** · 45м

- [ ] **T03.09** — Redaction секретов в логах Pino
  - **DoD:** paths `req.headers.authorization`, `payload.token`, `payload.refresh_token` заменены на `[REDACTED]`
  - **Files:** `src/logger.ts`
  - **P0** · 15м

- [ ] **T03.10** — Rate-limiter Fastify (общий)
  - **DoD:** `@fastify/rate-limit`, 100 req/min per IP, ошибка 429 + Retry-After
  - **Files:** `src/plugins/rateLimit.ts`
  - **P0** · 20м

- [ ] **T03.11** — Helmet + CORS
  - **DoD:** `@fastify/helmet` со strict CSP для дашборда, CORS только для собственного домена
  - **Files:** `src/plugins/security.ts`
  - **P0** · 20м

- [ ] **T03.12** — Whitelist Telegram-администраторов
  - **DoD:** `env.TELEGRAM_ADMIN_CHAT_ID` (список через запятую), middleware проверяет что sender.id ∈ whitelist перед destructive actions; попытка от других → лог + отказ
  - **Files:** `src/bot/middleware/adminOnly.ts`
  - **P0** · 25м

- [ ] **T03.13** — Проверка `.env.example` vs `.env` на CI
  - **DoD:** GitHub Action job падает если в `.env.example` есть ключ, отсутствующий в `env.ts` (и наоборот)
  - **Files:** `.github/workflows/env-check.yml`, `scripts/check-env.ts`
  - **P1** · 30м

- [ ] **T03.14** — Runbook: инцидент утечки токена
  - **DoD:** `docs/runbooks/credential-leak.md` — пошагово: определить область, отозвать токен у провайдера, ротировать ключ, уведомить клиента
  - **Files:** `docs/runbooks/credential-leak.md`
  - **P1** · 20м
