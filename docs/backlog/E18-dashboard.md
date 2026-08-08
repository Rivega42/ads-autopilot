# E18 — Web-дашборд (Next.js 14)

**Цель:** веб-UI для просмотра расхода/лидов/CPA, ChangeLog с rollback, апрувы.

**Зависимости:** E02, E11, E12, E17.
**DoD эпика:** Роман логинится через Telegram Login Widget, видит overview всех клиентов, может откатить любое изменение за 30 дней.

---

## Задачи

- [ ] **T18.01** — Next.js 14 app init (в подпапке `web/`)
  - **DoD:** `web/` — Next 14 app router, TypeScript, Tailwind, shadcn/ui; `pnpm --filter web dev` работает
  - **Files:** `web/package.json`, `web/next.config.ts`, `web/app/layout.tsx`
  - **P0** · 35м

- [ ] **T18.02** — Telegram Login Widget auth
  - **DoD:** `/login` со виджетом; валидация hash на сервере; создание сессии в cookie (JWT)
  - **Files:** `web/app/login/page.tsx`, `web/app/api/auth/telegram/route.ts`
  - **P0** · 50м

- [ ] **T18.03** — Middleware: защита роутов
  - **DoD:** `middleware.ts` редиректит на `/login` если нет валидного JWT; исключения: /login, /api/auth/*
  - **Files:** `web/middleware.ts`
  - **P0** · 20м

- [ ] **T18.04** — API-клиент для main-бэкенда
  - **DoD:** `lib/api.ts` — fetch-обёртка с JWT-заголовком; типы из shared package
  - **Files:** `web/lib/api.ts`
  - **P0** · 25м

- [ ] **T18.05** — Страница `/overview` (главная)
  - **DoD:** карточки: расход за сегодня/вчера/неделю, лиды, CPA, топ каналы; график расхода за 30 дней
  - **Files:** `web/app/overview/page.tsx`, `web/components/StatCards.tsx`, `web/components/SpendChart.tsx`
  - **P0** · 55м

- [ ] **T18.06** — Страница `/campaigns` (список)
  - **DoD:** таблица кампаний с фильтрами: канал, статус, клиент; сортировка по CPA/spend; пагинация
  - **Files:** `web/app/campaigns/page.tsx`, `web/components/CampaignTable.tsx`
  - **P0** · 50м

- [ ] **T18.07** — Страница `/campaigns/[id]` (детали)
  - **DoD:** статистика по дням, список групп/объявлений/ключей, ChangeLog по этой кампании
  - **Files:** `web/app/campaigns/[id]/page.tsx`
  - **P0** · 60м

- [ ] **T18.08** — Страница `/changelog` (все изменения)
  - **DoD:** таблица всех изменений за 30 дней: время, кто (AI/User/System), сущность, action, prev→new; кнопка [Откатить]
  - **Files:** `web/app/changelog/page.tsx`, `web/components/ChangeLogTable.tsx`
  - **P0** · 45м

- [ ] **T18.09** — Rollback UI + подтверждение
  - **DoD:** нажатие [Откатить] → модалка с превью изменения → confirm → API-вызов
  - **Files:** `web/components/RollbackDialog.tsx`
  - **P0** · 30м

- [ ] **T18.10** — Страница `/approvals` (ожидающие апрувы)
  - **DoD:** список PendingApproval со статусом PENDING; каждый со своим виджетом (BID_CHANGE, STRATEGY, IMPORT_HANDOVER)
  - **Files:** `web/app/approvals/page.tsx`, `web/components/ApprovalCard.tsx`
  - **P0** · 40м

- [ ] **T18.11** — Страница `/clients` (список клиентов)
  - **DoD:** таблица клиентов: имя, TG, подключённые каналы, месячный spend; фильтр по статусу
  - **Files:** `web/app/clients/page.tsx`
  - **P1** · 35м

- [ ] **T18.12** — Страница `/clients/[id]` (профиль клиента)
  - **DoD:** портрет, подключённые креденшелы (масками), кампании, аудит-логи
  - **Files:** `web/app/clients/[id]/page.tsx`
  - **P1** · 45м

- [ ] **T18.13** — Страница `/reports` (сохранённые отчёты)
  - **DoD:** список daily/weekly отчётов из БД, просмотр в HTML
  - **Files:** `web/app/reports/page.tsx`
  - **P1** · 30м

- [ ] **T18.14** — Server-Sent Events для real-time обновлений
  - **DoD:** `/api/events` (SSE) шлёт события approval_created, change_applied, alert; UI показывает нотификации
  - **Files:** `web/app/api/events/route.ts`, `web/hooks/useEvents.ts`
  - **P1** · 50м

- [ ] **T18.15** — Тема dark/light
  - **DoD:** переключатель, сохранение в localStorage, Tailwind darkMode: 'class'
  - **Files:** `web/components/ThemeToggle.tsx`
  - **P2** · 20м

- [ ] **T18.16** — Мобильная адаптация
  - **DoD:** overview + approvals читаемы на 375px; таблицы горизонтально скролятся
  - **Files:** все компоненты
  - **P1** · 40м

- [ ] **T18.17** — E2E тесты Playwright
  - **DoD:** login → overview → перейти в campaign → откатить изменение
  - **Files:** `web/tests/e2e/*.spec.ts`
  - **P0** · 60м

- [ ] **T18.18** — Страница `/settings/notifications`
  - **DoD:** какие алерты приходить в TG, порог CPA, порог расхода
  - **Files:** `web/app/settings/notifications/page.tsx`
  - **P1** · 30м

- [ ] **T18.19** — Экспорт отчёта в CSV/XLSX
  - **DoD:** кнопка [Экспорт] на страницах campaigns и changelog
  - **Files:** `web/lib/export.ts`
  - **P2** · 30м

- [ ] **T18.20** — 404 + 500 pages
  - **DoD:** кастомные страницы с ссылкой на TG-бот
  - **Files:** `web/app/not-found.tsx`, `web/app/error.tsx`
  - **P1** · 15м

- [ ] **T18.21** — Loading states + skeletons
  - **DoD:** Suspense boundaries, skeleton-компоненты для таблиц
  - **Files:** `web/components/skeletons/*`
  - **P1** · 25м

- [ ] **T18.22** — Sentry (frontend errors)
  - **DoD:** `@sentry/nextjs` подключён, DSN из env
  - **Files:** `web/sentry.client.config.ts`
  - **P1** · 20м

- [ ] **T18.23** — Rate-limit API-роутов дашборда
  - **DoD:** middleware ограничивает 100 req/min per user
  - **Files:** `web/middleware.ts`
  - **P0** · 20м

- [ ] **T18.24** — Docker-контейнер web
  - **DoD:** отдельный Dockerfile для Next.js standalone build
  - **Files:** `web/Dockerfile`
  - **P0** · 25м

- [ ] **T18.25** — Docs: как локально запустить дашборд
  - **DoD:** секция в главном README
  - **Files:** `README.md`, `web/README.md`
  - **P1** · 15м

- [ ] **T18.26** — Compose: `web` сервис
  - **DoD:** `docker-compose.yml` содержит web-сервис, порт 3001
  - **Files:** `docker-compose.yml`
  - **P0** · 15м
