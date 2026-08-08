# Backlog — ads-autopilot

> Атомарная декомпозиция ТЗ на эпики → истории → задачи.
> Правило: **1 задача = 1 PR** (максимум 300 строк diff, 1-4 часа работы).

## Как пользоваться (для Claude)

1. Открой нужный файл эпика в `docs/backlog/EXX-*.md`
2. Возьми **самую верхнюю незавершённую задачу** (`[ ]`) — они упорядочены по зависимостям
3. Создай ветку `feat/T-XX-YY-short-desc` от `develop`
4. Сделай задачу, следуя её **Definition of Done**
5. Пометь `[x]` в бэклоге, обнови `CHANGELOG.md` (секция Unreleased)
6. Открой PR по шаблону
7. После мёржа — следующая задача

## Легенда статусов

- `[ ]` — todo
- `[~]` — in progress (укажи ветку в комментарии)
- `[x]` — done (укажи PR #)
- `[!]` — заблокировано (укажи чем)

## Приоритеты

- 🔥 **P0** — блокирует MVP
- 🟠 **P1** — важно для MVP
- 🟡 **P2** — nice to have, не блокирует релиз
- 🟢 **P3** — идея на будущее

## Эпики

| # | Эпик | Файл | Задач | Оценка |
|---|---|---|---|---|
| E01 | Каркас проекта | [E01-scaffold.md](backlog/E01-scaffold.md) | 18 | 1 день |
| E02 | База данных (Prisma) | [E02-database.md](backlog/E02-database.md) | 16 | 1 день |
| E03 | Security & credentials | [E03-security.md](backlog/E03-security.md) | 14 | 1 день |
| E04 | Telegram Bot (Grammy) | [E04-telegram-bot.md](backlog/E04-telegram-bot.md) | 20 | 2 дня |
| E05 | Yandex Direct API | [E05-yandex-direct.md](backlog/E05-yandex-direct.md) | 32 | 4 дня |
| E06 | VK Реклама API | [E06-vk-ads.md](backlog/E06-vk-ads.md) | 26 | 3 дня |
| E07 | AI-Онбординг клиента | [E07-ai-onboarding.md](backlog/E07-ai-onboarding.md) | 14 | 1.5 дня |
| E08 | AI-Стратег | [E08-ai-strategist.md](backlog/E08-ai-strategist.md) | 16 | 2 дня |
| E09 | AI-Креативы | [E09-ai-creatives.md](backlog/E09-ai-creatives.md) | 24 | 3 дня |
| E10 | AI-Модератор | [E10-ai-moderator.md](backlog/E10-ai-moderator.md) | 14 | 1.5 дня |
| E11 | AI-Оптимизатор | [E11-ai-optimizer.md](backlog/E11-ai-optimizer.md) | 20 | 2.5 дня |
| E12 | AI-Аналитик | [E12-ai-analyst.md](backlog/E12-ai-analyst.md) | 14 | 1.5 дня |
| E13 | AI-Конкурентная разведка | [E13-ai-competitive.md](backlog/E13-ai-competitive.md) | 12 | 1.5 дня |
| E14 | AI-Wordstat | [E14-ai-wordstat.md](backlog/E14-ai-wordstat.md) | 12 | 1.5 дня |
| E15 | AI-Follow-up лидов | [E15-ai-followup.md](backlog/E15-ai-followup.md) | 14 | 1.5 дня |
| E16 | Cron & очереди (BullMQ) | [E16-cron-queue.md](backlog/E16-cron-queue.md) | 16 | 1.5 дня |
| E17 | Импорт существующих кампаний | [E17-import-campaigns.md](backlog/E17-import-campaigns.md) | 22 | 2.5 дня |
| E18 | Web-дашборд (Next.js) | [E18-dashboard.md](backlog/E18-dashboard.md) | 26 | 3 дня |
| E19 | Доп. каналы (TikTok/LinkedIn/Meta/Google/TG Ads) | [E19-extra-channels.md](backlog/E19-extra-channels.md) | 30 | 5 дней |
| E20 | Observability | [E20-observability.md](backlog/E20-observability.md) | 14 | 1.5 дня |
| E21 | Deployment | [E21-deployment.md](backlog/E21-deployment.md) | 16 | 2 дня |
| E22 | Документация & runbooks | [E22-docs.md](backlog/E22-docs.md) | 12 | 1.5 дня |

**Итого:** ~412 атомарных задач, ~44 дня работы (в одиночку, без параллелизма).

## MVP-скоуп (первые 15 дней)

Порядок эпиков для MVP:
1. E01 → E02 → E03 (фундамент, 3 дня)
2. E04 (бот, 2 дня)
3. E05 (Директ, 4 дня — параллельно с E04)
4. E06 (VK, 3 дня — после E05)
5. E16 (крон, 1.5 дня)
6. E07 → E08 (онбординг + стратег, 3.5 дня)
7. E11 → E12 (оптимизатор + аналитик, 4 дня)

После MVP: E09 (креативы), E10 (модератор), E17 (импорт), E18 (дашборд), E19 (доп. каналы).

## Правила именования веток

`<type>/T<epic>.<task>-<slug>`

Примеры:
- `feat/T05.03-yandex-oauth-flow`
- `fix/T11.07-bid-change-rollback`
- `refactor/T04.12-callback-router`

## Правила коммитов (Conventional Commits)

```
<type>(<scope>): <краткое описание в императиве>

<опциональное тело>

Refs: T05.03
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `style`.

## Зависимости между эпиками

```
E01 (каркас)
 ├─ E02 (БД)
 │   ├─ E03 (security)
 │   │   ├─ E05 (Директ)
 │   │   ├─ E06 (VK)
 │   │   └─ E19 (доп. каналы)
 │   └─ E17 (импорт кампаний) — требует E05 + E06
 ├─ E04 (бот)
 │   ├─ E07 (онбординг) — требует E04
 │   └─ E11.approval (одобрения) — требует E04
 ├─ E16 (крон) — требует E02
 │   ├─ E11 (оптимизатор) — требует E05, E06, E16
 │   └─ E12 (аналитик) — требует E05, E06, E16
 └─ E20 (observability) — параллельно с любым

E08 (стратег) — требует E07
E09 (креативы) — требует E08
E10 (модератор) — требует E05 или E06
E13 (конкурентная разведка) — независим
E14 (wordstat) — независим (использует Yandex Wordstat API)
E15 (follow-up) — независим (webhook от CRM)
E18 (дашборд) — требует E02, E11, E12
```
