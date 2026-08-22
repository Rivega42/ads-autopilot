# Runbook: типовые инциденты

Все команды — из каталога проекта на сервере. Дальше `dc` = `docker compose -f docker-compose.prod.yml`.

## Первое действие при любом «всё сломалось»

```bash
dc ps                      # кто не healthy
dc logs --tail=200 api worker bot
```

Если непонятно, что происходит, и деньги могут утекать — останови запись, не весь стек:

```bash
sed -i 's/^DRY_RUN=.*/DRY_RUN=true/' .env && dc up -d worker bot
```

Оба, а не только воркер: апрувы применяет процесс бота, и он читает `DRY_RUN`
своего окружения. Перезапустив один воркер, получишь систему, где нажатие
«Применить» на ещё живой карточке по-прежнему уходит в кабинет.

После перезапуска чтение и карточки остаются, изменения в кабинеты прекращаются.

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

Оговорка про `prune -af`: он сносит и образы, закреплённые деплоем
(`*-deployed:*`, docs/DEPLOY.md §4.2). Для версий из GHCR это не страшно —
`rollback.sh` вытянет их обратно; для собранных на месте откат после такой чистки
невозможен в принципе, образ придётся собирать заново из нужного коммита. Если
версия сомнительная — сначала откатись, потом чисти. Начинать лучше с
`docker builder prune -af`: он освобождает кеш сборок и закреплённые образы не
трогает.

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

## Завести или заменить доступы клиента

Токен кабинета не хранится в `.env` и не передаётся аргументом команды: `argv`
виден в `ps` любому пользователю машины и оседает в истории shell. Секрет
читается из трубы, шифруется AES-256-GCM и ложится в `Credential`; сама запись
попадает в `AuditLog` с actor `cli:credentials` (CLAUDE.md §6).

Клиент должен уже существовать — секрет привязан к нему внешним ключом.
Найти id: `dc run --rm -T --no-deps -e ROLE=cli api clients`. Дальше `cli` — это
сокращение для `dc run --rm -T --no-deps -e ROLE=cli api` (в дев-окружении то же
самое зовётся `pnpm cli`).

**Клиента ещё нет.** Заводится командой; `tgUserId` обязан совпадать с
Telegram-аккаунтом клиента — иначе бот его не опознает и `/launch` ответит
«не нашёл тебя в базе»:

```bash
dc run --rm -T --no-deps -e ROLE=cli api \
  clients add --name "<Имя клиента>" --tg-user-id <tg_user_id> --apply
```

Без `--apply` та же команда показывает, что будет заведено, и не пишет ни строки.
Повторное заведение того же `tgUserId` отвергается с именем занявшего: второго
клиента на один аккаунт не бывает, а тихо переписать имя и статус живого клиента
команда не станет. Заведение ложится в `AuditLog` с actor `cli:clients`.

Статус задаётся `--status` (`ACTIVE` по умолчанию, ещё `PAUSED` и `ARCHIVED`).
Неактивного клиента крон загрузки, оптимизации и продления токенов пропускает —
команда об этом предупреждает.

**`-T` обязателен.** Без него `compose run` выделяет псевдотерминал, и команда
откажется читать секрет: набранное в терминале остаётся в скролле и в буфере
эмулятора, поэтому этот путь закрыт намеренно.

**Готовый токен Директа** (песочница или выданный клиентом):

```bash
read -rs TOKEN                                    # без эха и без записи в историю
printf '%s' "$TOKEN" | dc run --rm -T --no-deps -e ROLE=cli api \
  credentials set --client <id> --provider yandex_direct --apply
unset TOKEN
```

Та же команда без `--apply` ничего не пишет, а показывает разобранные поля с
замаскированными значениями — так проверяют, что вставилось именно то, что
скопировали, а не вместе с кавычками и переводом строки.

**Агентский доступ** — тем же способом, JSON-ом:

```bash
printf '%s' '{"accessToken":"…","refreshToken":"…","clientLogin":"логин-клиента","useOperatorUnits":true}' \
  | dc run --rm -T --no-deps -e ROLE=cli api \
    credentials set --client <id> --provider yandex_direct --apply
```

`clientLogin` заполняется ТОЛЬКО когда мы агентство: заголовок `Client-Login` на
прямом токене возвращает ошибку 54.

**Токена нет, есть только согласие клиента** — тогда через OAuth:

```bash
dc run --rm -T --no-deps -e ROLE=cli api credentials link --provider yandex_direct
read -rs CODE                                     # клиент вернёт код подтверждения
printf '%s' "$CODE" | dc run --rm -T --no-deps -e ROLE=cli api \
  credentials exchange --client <id> --provider yandex_direct --apply
unset CODE
```

Код одноразовый и живёт минуты, поэтому без `--apply` команда его не тратит:
черновой прогон показывает маску кода и на этом останавливается. Публичного
OAuth-callback'а у системы нет — код переносится руками.

Две предпосылки этого пути, без которых он не работает. Первая: в окружении
должны быть `YANDEX_OAUTH_CLIENT_ID` и `YANDEX_OAUTH_CLIENT_SECRET` — это наше
приложение в Яндекс OAuth, а не секрет клиента; без них команда откажет с
`YANDEX_OAUTH_NOT_CONFIGURED`. Вторая: приложение должно быть зарегистрировано
так, чтобы Яндекс **показывал код подтверждения на странице**. Если у приложения
задан redirect на наш домен, код уедет туда, а принять его там некому.

**VK Реклама** — не токен, а пара приложения (плюс `agencyClientName`, если
кабинет агентский):

```bash
printf '%s' '{"clientId":"…","clientSecret":"…","agencyClientName":"…"}' \
  | dc run --rm -T --no-deps -e ROLE=cli api \
    credentials set --client <id> --provider vk_ads --apply
```

**Проверка — тремя шагами, а не одним:**

```bash
dc run --rm -T --no-deps -e ROLE=cli api credentials list --client <id>   # какие каналы заведены
dc run --rm -T --no-deps -e ROLE=cli api ingest --client <id> --apply    # реально ли ходит в кабинет
dc exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "select actor, action, resource, \"createdAt\" from \"AuditLog\" where action like 'credential%' order by id desc limit 5;"
```

`ingest` без `--apply` (и при `DRY_RUN=true` в окружении) в кабинет не ходит
вовсе: печатает окно дат и список кабинетов, которые опросил бы. Проверка «реально
ли ходит» — это `--apply` на стенде с `DRY_RUN=false`.

Если клиент не в статусе `ACTIVE`, команда предупредит об этом при записи: крон
загрузки (`listIngestionTargets`) и продление токенов берут только активных, и
секрет будет лежать вполне рабочим, не делая ничего.

**Отзыв** (токен утёк, клиент ушёл):

```bash
dc run --rm -T --no-deps -e ROLE=cli api \
  credentials revoke --client <id> --provider yandex_direct --apply
```

Там, где трубы нет (systemd, CI), секрет можно передать переменной
`ADS_CREDENTIAL_PAYLOAD` — она старше stdin. На сервере руками так делать не
надо: `-e ADS_CREDENTIAL_PAYLOAD="$TOKEN"` кладёт токен в `argv` самого
`docker compose`, то есть ровно туда, откуда его и убирали. И в `.env` этой
переменной не место: там она пережила бы задачу, ради которой заведена.

## Токен клиента протух

**Симптом:** `refresh-tokens` в логах с ошибкой, у клиента перестала идти статистика.

```bash
dc logs worker | grep refresh-tokens | tail -20
dc exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "select \"clientId\", provider, \"expiresAt\" from \"Credential\" order by \"expiresAt\";"
```

Refresh-токен Яндекса не вечен: если он тоже истёк, автоматика не поможет —
доступ заводится заново по процедуре выше («Завести или заменить доступы
клиента»), обычно связкой `credentials link` → `credentials exchange`. Никогда не
логировать сам токен: в логи идут последние 4 символа (CLAUDE.md §6).

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

## Выкатили новую версию, и стало хуже

**Симптом:** после `./scripts/deploy.sh` сервисы не поднимаются, `/health` врёт,
в логах ошибки, которых вчера не было.

Сначала останови запись в кабинеты (`DRY_RUN=true`, см. самый верх), потом
откатывайся — иначе сломанная версия успеет применить ещё пачку изменений.

```bash
./scripts/rollback.sh --list   # какие версии здесь были
./scripts/rollback.sh          # на предыдущую; спросит подтверждение
```

Стек можно не поднимать: с остановленными контейнерами скрипт берёт текущую
версию из последней записи `.deploy-history`. Ответ на вопрос читается из stdin,
так что `echo y | ./scripts/rollback.sh` тоже работает, но для алертов и cron
честнее `--yes`.

Скрипт перед откатом показывает миграции, которые уже применены в базе, но
которых нет в целевом образе. Обратно он их не катит и не должен: миграции
backward-compatible (CLAUDE.md §7), старый код обязан с ними работать. Если он
не работает — откат образа не спасёт, нужен свежий дамп (`./scripts/backup-db.sh`)
и разбор руками, а не `migrate resolve`.

После отката в `.env` закреплены `APP_IMAGE`/`WEB_IMAGE`. Пока их не убрать,
любой следующий `deploy.sh` будет поднимать откатную версию, сколько бы раз ты
ни сделал `git pull`. Подробности — `docs/DEPLOY.md` §10.

## Что-то поменялось в кабинете, и непонятно кем

```bash
dc exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "select \"appliedAt\", actor, \"approvedBy\", action, \"entityType\", \"entityId\", \"prevValue\", \"newValue\" from \"ChangeLog\" order by \"appliedAt\" desc limit 20;"
```

`actor` различает человека и автоматику. Если изменения в кабинете нет в
ChangeLog — его сделали не мы.

## Проверить, отработали ли сутки целиком

```bash
# на стенде — из образа, `pnpm` и `tsx` в нём нет
docker compose -f docker-compose.prod.yml run --rm --no-deps -e ROLE=acceptance api --days 1
# в дереве исходников
pnpm acceptance --days 1
```

Отвечает по одним суткам: какие кроны отработали и сколько тиков, что осталось в
`ErrorLog`, ушёл ли дневной отчёт, не запускали ли команд руками. Коды возврата:
0 — пройдено, 1 — сорвано, 2 — улик не хватает (например, Redis подняли заново и
истории прогонов больше нет). Ничего не пишет, запускать можно в любой момент.

Разбор строк вывода и процедура приёмки ТЗ §9.6 целиком — [`ACCEPTANCE.md`](./ACCEPTANCE.md).
