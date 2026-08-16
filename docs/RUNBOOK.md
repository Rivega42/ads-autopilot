# Runbook: типовые инциденты

Все команды — из каталога проекта на сервере. Дальше `dc` = `docker compose -f docker-compose.prod.yml`.

## Первое действие при любом «всё сломалось»

```bash
dc ps                      # кто не healthy
dc logs --tail=200 api worker bot
```

Если непонятно, что происходит, и деньги могут утекать — останови запись, не весь стек:

```bash
sed -i 's/^DRY_RUN=.*/DRY_RUN=true/' .env && dc up -d worker
```

Воркер перезапустится с включённым предохранителем: чтение и карточки останутся,
изменения в кабинеты прекратятся.

---

## Диск на Postgres кончился

**Симптом:** `PANIC: could not write to file`, api не отвечает, в логах `no space left on device`.

```bash
df -h /var/lib/docker
du -sh backups/*                       # чаще всего виноваты дампы
dc exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "select relname, pg_size_pretty(pg_total_relation_size(relid)) from pg_catalog.pg_statio_user_tables order by pg_total_relation_size(relid) desc limit 10;"
```

Что чистить в порядке безопасности: старые бэкапы → `docker system prune -af` →
старые строки `CampaignStat` глубже года. `ErrorLog` и `ChangeLog` не трогать без
нужды: это единственный след того, что система делала в кабинетах.

## Redis OOM / воркер не берёт задачи

**Симптом:** `OOM command not allowed`, задачи висят в waiting.

```bash
dc exec redis redis-cli info memory | grep used_memory_human
dc exec redis redis-cli info keyspace
```

`maxmemory-policy` обязан быть `noeviction` — при любом другом Redis молча
выбросит состояние задач BullMQ. Проверить: `dc exec redis redis-cli config get maxmemory-policy`.

Разбор завалов:

```bash
dc exec redis redis-cli --scan --pattern 'bull:*:failed' | head
```

Перезапуск воркера безопасен: задачи переживают рестарт, кроме той, что была в работе — она уйдёт в retry.

## Провайдер отдаёт 429 / кончились units Директа

**Симптом:** в логах `OutOfUnitsError` или всплеск `rate limit`.

Это штатное поведение, не инцидент: клиент Директа считает баллы сам и
откладывает работу до следующего окна. Смотреть:

```bash
dc exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "select \"createdAt\", method, spent, remaining, \"dailyLimit\" from \"UnitsLedger\" order by \"createdAt\" desc limit 20;"
```

Если баллы кончаются каждый день — это не баг клиента, а слишком частый сбор
статистики или слишком много кампаний на один кабинет. Лечится расписанием
(`CRON_SCHEDULE` в `src/scheduler/queues.ts`), а не ретраями.

## Токен клиента протух

**Симптом:** `refresh-tokens` в логах с ошибкой, у клиента перестала идти статистика.

```bash
dc logs worker | grep refresh-tokens | tail -20
dc exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "select \"clientId\", provider, \"expiresAt\" from \"Credential\" order by \"expiresAt\";"
```

Refresh-токен Яндекса не вечен: если он тоже истёк, автоматика не поможет —
клиент проходит OAuth заново. Никогда не логировать сам токен: в логи идут
последние 4 символа (CLAUDE.md §6).

## Бот молчит

```bash
dc logs bot --tail=100
```

Частые причины по убыванию: конфликт `getUpdates` (запущены два экземпляра бота —
проверь, не остался ли старый контейнер), неверный `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_ADMIN_CHAT_ID` от другого аккаунта.

Одновременно два `bot` контейнера держать нельзя: Telegram отдаёт long polling
только одному, второй будет тихо получать 409.

## Апрув завис в APPLYING

**Симптом:** карточка показывает «применяется» дольше нескольких минут.

Так бывает, когда контейнер упал между записью в кабинет и записью статуса.
Разгребает `expire-approvals` (каждые 5 минут). Если не разгребло:

```bash
dc exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "select id, kind, decision, \"createdAt\", \"decidedAt\", error from \"PendingApproval\" where decision = 'APPLYING' order by \"createdAt\";"
```

**Прежде чем что-то менять руками — проверь ChangeLog по этой же заявке.** Строка
в `APPLYING` не означает «не применено»: изменение могло дойти до площадки.
Повторное применение — второе изменение бюджета, а не «докат» первого.

## Миграция не накатилась

**Симптом:** `api` в рестарт-петле, в логах prisma `migrate deploy` с ошибкой.

```bash
dc logs api --tail=50
dc exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "select migration_name, finished_at, logs from _prisma_migrations order by started_at desc limit 5;"
```

Незавершённая миграция блокирует все последующие. Откатывать `migrate resolve
--rolled-back` можно только убедившись, что её изменения действительно не
применились — иначе схема и история разъедутся навсегда. Перед любым таким
действием — свежий дамп (`./scripts/backup-db.sh`).

## Что-то поменялось в кабинете, и непонятно кем

```bash
dc exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "select \"appliedAt\", actor, \"approvedBy\", action, \"entityType\", \"entityId\", \"prevValue\", \"newValue\" from \"ChangeLog\" order by \"appliedAt\" desc limit 20;"
```

`actor` различает человека и автоматику. Если изменения в кабинете нет в
ChangeLog — его сделали не мы.
