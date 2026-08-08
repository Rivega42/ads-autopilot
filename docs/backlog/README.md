# Backlog

22 эпика, ~330 атомарных задач. Каждая задача имеет DoD (Definition of Done), приоритет и оценку в минутах.

## Приоритеты
- **P0** — блокеры MVP, без них ничего не работает
- **P1** — важная функциональность MVP
- **P2** — nice to have, можно после запуска

## Порядок работы (Milestone → эпики)

### Milestone 1 — «Каркас» (~1 неделя)
- [E01](E01-scaffold.md) — TS + Fastify + Prisma + Grammy + Docker
- [E02](E02-database.md) — Prisma-схема (Tenant, User, Campaign, Approval, Metric, ChangeLog)
- [E03](E03-security.md) — Секреты (шифрование, ротация, KMS-подобная абстракция)
- [E04](E04-telegram-bot.md) — Бот-скелет + auth

### Milestone 2 — «Provider layer» (~2 недели)
- [E05](E05-yandex-direct.md) — Direct API v5 (OAuth, campaigns, keywords, bids, reports)
- [E06](E06-vk-ads.md) — VK Реклама API (OAuth, кабинеты, объявления, аудитории)
- [E17](E17-import-campaigns.md) — Импорт существующих кампаний + режим наблюдателя

### Milestone 3 — «AI-brain» (~2 недели)
- [E07](E07-ai-onboarding.md) — 15 вопросов → портрет клиента
- [E08](E08-ai-strategist.md) — Opus 4.7 — анализ ниши, план кампаний
- [E09](E09-ai-creatives.md) — тексты + Kandinsky/YandexART + Runway/Sora
- [E10](E10-ai-moderator.md) — обработка отказов и ретрай
- [E11](E11-ai-optimizer.md) — LightGBM + LLM-агент
- [E12](E12-ai-analyst.md) — недельные разборы
- [E13](E13-ai-competitive.md) — конкурентная разведка
- [E14](E14-ai-wordstat.md) — семантическое ядро через LLM + эмбеддинги
- [E15](E15-ai-followup.md) — квалификация лидов в WhatsApp/TG

### Milestone 4 — «Ops & UI» (~1 неделя)
- [E16](E16-cron-queue.md) — BullMQ, планировщик, ретраи
- [E18](E18-dashboard.md) — Next.js дашборд
- [E20](E20-hitl-approvals.md) — апрувы, changelog, rollback, kill-switch
- [E21](E21-observability.md) — логи, метрики, алерты, health-checks

### Milestone 5 — «Production» (~1 неделя)
- [E22](E22-deploy-cicd.md) — Docker, CI/CD, staging, backups, security

### Milestone 6 — «Extra channels» (по запросу клиентов)
- [E19](E19-extra-channels.md) — TikTok, LinkedIn, Meta, Google, Telegram Ads

---

## Как работать с задачами

1. Взять задачу из ближайшего Milestone по приоритету P0 → P1 → P2
2. Создать ветку `feat/TXX.XX-краткое-описание`
3. Реализовать → соответствие DoD
4. Тесты — обязательно (см. CLAUDE.md, §Testing)
5. PR → self-review чеклист → squash merge
6. Чекбокс в файле эпика ставит зелёная галочка после merge

## Итоговая оценка

- Всего задач: **~330**
- P0/P1/P2 распределение: ~60/30/10
- Оценочное время MVP (Milestones 1–5): **~180–220 часов** (при парной работе Роман + Вика)
- Продакшн-релиз: **6 недель** от старта
