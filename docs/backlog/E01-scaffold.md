# E01 — Каркас проекта

**Цель:** рабочий TypeScript-проект с линтером, форматером, тестами, Docker Compose (postgres + redis), готовый принимать первую бизнес-логику.

**Зависимости:** нет.
**DoD эпика:** `pnpm install && pnpm dev` запускает Fastify на :3000, `pnpm test` проходит, `docker compose up` поднимает pg+redis, CI зелёный.

---

## Задачи

- [ ] **T01.01** — `pnpm init` + базовый `package.json`
  - **DoD:** `name`, `version=0.0.1`, `packageManager=pnpm@9`, `engines.node=">=22"`, `type=module`
  - **Files:** `package.json`
  - **P0** · 10м

- [ ] **T01.02** — TypeScript config
  - **DoD:** `tsconfig.json` со `strict: true`, `target: ES2022`, `module: ESNext`, `moduleResolution: bundler`, path alias `@/*` → `src/*`
  - **Files:** `tsconfig.json`
  - **P0** · 10м

- [ ] **T01.03** — Prettier config
  - **DoD:** `.prettierrc` (semi, singleQuote, 100 cols, trailingComma=all), `.prettierignore`, `pnpm format` работает
  - **Files:** `.prettierrc`, `.prettierignore`, `package.json` (script)
  - **P0** · 10м

- [ ] **T01.04** — ESLint config (flat)
  - **DoD:** `eslint.config.js` c `@typescript-eslint`, `eslint-plugin-import`, `pnpm lint` работает и не ругается на пустой проект
  - **Files:** `eslint.config.js`, `.eslintignore`
  - **P0** · 20м

- [ ] **T01.05** — Vitest + coverage
  - **DoD:** `vitest.config.ts` с `coverage.provider = 'v8'`, threshold 80%, `pnpm test` проходит на dummy тесте
  - **Files:** `vitest.config.ts`, `src/__tests__/smoke.test.ts`
  - **P0** · 15м

- [ ] **T01.06** — Fastify boot
  - **DoD:** `src/server.ts` — Fastify на `PORT` (default 3000), эндпоинт `GET /health` → `{status:'ok', ts, version}`
  - **Files:** `src/server.ts`, `src/config.ts`
  - **P0** · 20м

- [ ] **T01.07** — Pino logger
  - **DoD:** `src/logger.ts` экспортирует настроенный pino (level из env, pretty в dev, json в prod), Fastify использует его
  - **Files:** `src/logger.ts`
  - **P0** · 15м

- [ ] **T01.08** — Zod-валидация env
  - **DoD:** `src/env.ts` парсит `process.env` через zod, падает при отсутствии обязательных, экспортирует typed `env`
  - **Files:** `src/env.ts`
  - **P0** · 20м

- [ ] **T01.09** — `pnpm dev` через tsx watch
  - **DoD:** `pnpm dev` перезапускает при изменениях в `src/`
  - **Files:** `package.json` (scripts)
  - **P0** · 10м

- [ ] **T01.10** — Docker Compose (dev)
  - **DoD:** `docker-compose.yml` с postgres:16, redis:7, healthchecks, volume для pg-data
  - **Files:** `docker-compose.yml`
  - **P0** · 20м

- [ ] **T01.11** — Dockerfile (multi-stage)
  - **DoD:** stage build (pnpm install --frozen-lockfile + tsc) + stage runtime (node:22-alpine, non-root), финальный образ < 300 MB
  - **Files:** `Dockerfile`, `.dockerignore`
  - **P1** · 30м

- [ ] **T01.12** — Graceful shutdown
  - **DoD:** SIGTERM/SIGINT закрывают Fastify, Prisma, BullMQ (когда появятся), таймаут 10с
  - **Files:** `src/shutdown.ts`, `src/server.ts`
  - **P1** · 20м

- [ ] **T01.13** — Error handler middleware
  - **DoD:** Fastify errorHandler ловит все errors, логирует с requestId, отвечает JSON `{error, requestId}`; секреты не утекают в ответ
  - **Files:** `src/errorHandler.ts`, `src/server.ts`
  - **P0** · 20м

- [ ] **T01.14** — RequestId + correlation
  - **DoD:** Каждый запрос получает UUID (или из заголовка `x-request-id`), проброшен в pino через `.child({requestId})`
  - **Files:** `src/plugins/requestId.ts`, `src/server.ts`
  - **P1** · 20м

- [ ] **T01.15** — README quick start
  - **DoD:** секция «Локальный запуск» с 6 командами (clone → install → env → up pg → migrate → dev)
  - **Files:** `README.md`
  - **P0** · 15м

- [ ] **T01.16** — Husky pre-commit hook
  - **DoD:** pre-commit запускает `lint-staged` (prettier + eslint --fix), commit падает при ошибках
  - **Files:** `.husky/pre-commit`, `package.json` (lint-staged config)
  - **P1** · 15м

- [ ] **T01.17** — Commitlint
  - **DoD:** commit-msg hook валидирует Conventional Commits, при нарушении commit падает с подсказкой
  - **Files:** `commitlint.config.js`, `.husky/commit-msg`
  - **P1** · 15м

- [ ] **T01.18** — CI зелёный
  - **DoD:** `.github/workflows/ci.yml` проходит на пустом проекте (lint + typecheck + test); фикс `pnpm.lockfile` если надо
  - **Files:** `pnpm-lock.yaml` (сгенерировать)
  - **P0** · 15м
