# Деплой в прод

Одна виртуалка, docker compose, nginx снаружи. Postgres и Redis живут в том же
стеке и наружу не смотрят.

## 0. Что понадобится

- VPS: 4 vCPU / 8 ГБ / 80 ГБ SSD, Ubuntu 24.04. Меньше 8 ГБ — Postgres и Next
  начнут конкурировать за память.
- Два домена в A-записях на IP машины: `api.<домен>` и `dash.<домен>`.
- Токены площадок. **Сначала песочница**: `YANDEX_DIRECT_USE_SANDBOX=true`.

## 1. Подготовка хоста

```bash
apt update && apt install -y docker.io docker-compose-v2 git ufw certbot
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw --force enable

mkdir -p /root/projects && cd /root/projects
git clone https://github.com/rivega42/ads-autopilot.git
cd ads-autopilot
```

## 2. Переменные

```bash
cp .env.example .env
openssl rand -base64 32   # → CREDENTIALS_ENCRYPTION_KEY
openssl rand -base64 24   # → POSTGRES_PASSWORD
openssl rand -base64 24   # → DASHBOARD_PASSWORD
```

Обязательный минимум в `.env`: `POSTGRES_USER`, `POSTGRES_PASSWORD`,
`POSTGRES_DB`, `CREDENTIALS_ENCRYPTION_KEY`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_ADMIN_CHAT_ID`, `DASHBOARD_PASSWORD`, `API_DOMAIN`, `DASHBOARD_DOMAIN`.

`DRY_RUN` не трогать. Он `true` по умолчанию, и это правильное состояние до
первого успешного прогона в песочнице.

Права: `chmod 600 .env`. В нём лежит ключ, которым расшифровываются токены всех
клиентов — компрометация файла равна компрометации всех кабинетов.

## 3. TLS

Сертификаты выпускаются до первого старта nginx: конфиг ссылается на файлы
`/etc/letsencrypt/live/<домен>/`, и без них nginx не поднимется.

```bash
certbot certonly --standalone -d api.example.ru -d dash.example.ru
```

Продление: `certbot renew` ходит по HTTP на 80 порт, в конфиге для него оставлен
`/.well-known/acme-challenge/`. В cron:

```
0 4 * * 1 certbot renew --webroot -w /var/lib/docker/volumes/ads-autopilot_certbot_webroot/_data --quiet && docker compose -f /root/projects/ads-autopilot/docker-compose.prod.yml exec nginx nginx -s reload
```

## 4. Образы

Два рабочих пути. По умолчанию — первый.

### 4.1. Готовые из GHCR

Каждый push в `main` собирает и публикует оба образа
(`.github/workflows/publish.yml`):

| Образ                                | Что внутри                | Теги                                             |
| ------------------------------------ | ------------------------- | ------------------------------------------------ |
| `ghcr.io/rivega42/ads-autopilot`     | api, worker, bot, migrate | `latest`, `sha-<коммит>`, на теге `v*` — `1.2.3` |
| `ghcr.io/rivega42/ads-autopilot-web` | дашборд                   | те же                                            |

`APP_IMAGE`/`WEB_IMAGE` при этом не задавать: в compose уже стоят значения по
умолчанию с `:latest`.

Публикация идёт только после зелёного CI: `publish.yml` первым шагом вызывает
`ci.yml` целиком (lint, typecheck, unit, integration, дашборд) и лишь затем
собирает и пушит. Из-за этого образ появляется в реестре примерно на десять
минут позже коммита — это плата за то, что `:latest` не бывает собран из
заведомо красного коммита. Тот же гейт работает и на тегах `v*`: раньше релизный
тег не запускал проверки вообще. Сборка и пуш при этом разнесены на два job'а:
пуш стартует, только когда собрались **оба** образа, иначе при падении одной
половины матрицы в реестре оставались бы `ads-autopilot:latest` от одного
коммита и `ads-autopilot-web:latest` от другого — бэкенд и дашборд поехали бы на
одну схему БД с разных ревизий, и заметить это было бы нечем.

Пакеты GHCR создаются приватными — даже у публичного репозитория. Один раз надо
выбрать одно из двух, иначе `pull` на сервере молча не сработает (`deploy.sh`
скажет об этом отдельной строкой):

- сделать пакеты публичными: GitHub → репозиторий → Packages → `ads-autopilot` →
  Package settings → Change visibility (и то же для `ads-autopilot-web`);
- либо залогинить хост под токеном с правом `read:packages`:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u rivega42 --password-stdin
docker pull ghcr.io/rivega42/ads-autopilot:latest   # проверка, что путь рабочий
```

### 4.2. Собрать на месте

Нужно, когда разворачиваем коммит, которого нет в `main` (хотфикс, ветка), или
когда до GHCR нет доступа.

```bash
docker build --target app -t ads-autopilot:app .
docker build --target web -t ads-autopilot-web:latest .
echo 'APP_IMAGE=ads-autopilot:app' >> .env
echo 'WEB_IMAGE=ads-autopilot-web:latest' >> .env
```

Локально собранные образы в реестре не лежат, поэтому `deploy.sh` тянет образы с
`--ignore-pull-failures` и ругань `pull access denied` в его выводе на этом пути
ожидаема — стек поднимется на локальных.

Обратная сторона такой сборки: тег `ads-autopilot:app` подвижный. Пересборка под
тем же тегом не просто перевешивает его — старый образ теряет последнюю ссылку и
удаляется целиком: он не резолвится ни по `sha256:`-ID, ни по digest из
`RepoDigests` (docker 28+ считает digest и для локальной сборки, но в реестре
такого образа нет) и в dangling не остаётся. То есть откатываться было бы не на
что уже в момент пересборки, а не когда-нибудь потом при `prune`.

Поэтому `deploy.sh` при каждом успешном деплое вешает на поднятый образ
неподвижный тег вида `ads-autopilot-deployed:<12 знаков ID>` и пишет в историю
именно его. Тег никто не пересобирает, значит образ живёт, и откат на локальную
сборку работает так же, как на образ из GHCR, — офлайн, без реестра.

Что этот тег всё-таки не переживает:

- `docker system prune -af` (в том числе из runbook'а «диск кончился») — он сносит
  все образы, которые не заняты контейнерами;
- ротацию: держим последние `DEPLOY_PIN_KEEP` (по умолчанию 8) закреплённых
  образов на каждое имя, старые открепляются. Это гигабайты на диске, слои между
  сборками общие лишь частично;
- переустановку хоста, очевидно.

Во всех этих случаях откат на локальную сборку невозможен в принципе: собрать
такой образ заново можно только из того же коммита (`git checkout <sha>` и
`docker build`). Если откат должен переживать что угодно — это путь 4.1: образ в
GHCR, откат по `sha-<коммит>`, `rollback.sh` вытянет его в любой момент.

## 5. Запуск

```bash
./scripts/deploy.sh
```

Скрипт делает `pull`, `up -d --wait` и дёргает `/health`. Миграции накатывает
отдельный одноразовый контейнер `migrate`, и только после его успешного выхода
стартуют `api`, `worker`, `bot` и `web`. Prisma берёт advisory-lock, поэтому
повторный запуск деплоя безопасен, а длинная миграция ничей healthcheck не рушит.

## 6. Проверки после деплоя

```bash
docker compose -f docker-compose.prod.yml ps          # все healthy
curl -s https://api.example.ru/health                 # {"status":"ok",...}
curl -s -o /dev/null -w '%{http_code}\n' https://dash.example.ru/   # 401 — так и надо
docker compose -f docker-compose.prod.yml logs worker | grep 'worker started'
```

В логе воркера должны быть одиннадцать строк `scheduled repeatable job` — по одной
на задачу из TZ §3.4 плюс `evaluate-ab-tests`. Меньше — значит часть расписаний
не встала. Точный список печатается там же одной строкой `worker started`.

Телеграм: `/start` боту, должен ответить. Молчит — смотри `logs bot`.

## 7. Бэкапы

```bash
crontab -e
0 3 * * * cd /root/projects/ads-autopilot && ./scripts/backup-db.sh >> /var/log/ads-backup.log 2>&1
```

Дампы падают в `./backups/YYYY-MM-DD/`, хранятся 30 дней. Скрипт удаляет дамп
меньше 1 КБ и завершается с ошибкой — молчаливо ротировать пустышки нельзя.

Проверка восстановления (делать хотя бы раз в месяц, руками):

```bash
gunzip -c backups/2026-08-16/ads_autopilot-030000.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T postgres psql -U "$POSTGRES_USER" -d restore_test
```

## 8. Выход из dry-run

Отдельный шаг, не часть деплоя. До него система читает кабинеты и присылает
карточки, но ничего не меняет.

1. Прогнать сутки на песочнице Директа, убедиться, что карточки приходят и
   применяются без ошибок.
2. `DRY_RUN=false` в `.env`, `YANDEX_DIRECT_USE_SANDBOX=false`.
3. `docker compose -f docker-compose.prod.yml up -d api worker bot`.
4. Первый живой прогон смотреть глазами: `logs -f worker` во время `optimize-bids`.

## 9. Обновление

```bash
git pull && ./scripts/deploy.sh
```

`deploy.sh` после успешного `/health` дописывает строку в `.deploy-history`:
время, событие, ссылки на образы, из которых реально подняты `api` и `web`, и
локальные закреплённые теги для них (см. §4.2). Для образа из GHCR ссылка — это
digest, а не `latest`: `latest` через день указывает уже на другой образ. Файл
живёт только на сервере (в git его нет) и нужен ровно одному потребителю —
`rollback.sh`.

Ловушка: если в `.env` закреплены `APP_IMAGE`/`WEB_IMAGE` (после отката они
закреплены), `git pull` новую версию не привезёт — деплой поднимет то, что
закреплено. Снять закрепление = удалить эти строки из `.env`.

## 10. Откат

```bash
./scripts/rollback.sh          # на предыдущую записанную версию
./scripts/rollback.sh --list   # что и когда здесь крутилось
./scripts/rollback.sh --yes    # без вопроса (для скриптов и алертов)
./scripts/rollback.sh --app ghcr.io/rivega42/ads-autopilot:sha-abc1234 \
                      --web ghcr.io/rivega42/ads-autopilot-web:sha-abc1234
```

`--app` и `--web` можно указывать по отдельности: вторая половина возьмётся из
истории, а если истории нет — останется той, что запущена.

Что делает скрипт: берёт предыдущую версию из `.deploy-history` (или ту, что
указали явно), скачивает образы, **сравнивает миграции в целевом образе с
применёнными в базе**, спрашивает подтверждение, прописывает `APP_IMAGE`/
`WEB_IMAGE` в `.env` и вызывает `deploy.sh`. Если задан `TELEGRAM_BOT_TOKEN` —
шлёт результат в админский чат.

Две вещи, которые важно понимать до отката:

- **Миграции назад не едут.** Они пишутся backward-compatible (CLAUDE.md §7),
  поэтому старый образ работает с новой схемой; `prisma migrate deploy` из
  старого образа видит в базе лишние миграции и спокойно выходит с «No pending
  migrations to apply» — проверено на живой базе. Но если конкретная миграция
  backward-compatible всё-таки не была, откат образа проблему не решит: нужен
  дамп и разбор руками. Именно этот список скрипт и показывает перед вопросом.
- **Второй откат подряд уходит глубже, а не назад.** Версию, от которой убежали,
  история помечает и больше не предлагает. Когда предлагать нечего, скрипт
  говорит об этом и просит указать тег явно.
- **Остановленный стек — не помеха.** Если контейнеров нет (`down`, `stop`,
  ребут), за текущую версию берётся последняя запись `.deploy-history`, и
  «предыдущей» становится та, что перед ней.

Руками то же самое:

```bash
# Именно так, а не `sed -i s|^APP_IMAGE=.*|...|`: по умолчанию (§4.1) строки
# APP_IMAGE в .env нет вовсе, и замена молча не делает ничего — следующий
# deploy.sh поднимает :latest, то есть ту версию, от которой уходишь.
sed -i '/^APP_IMAGE=/d;/^WEB_IMAGE=/d' .env
cat >>.env <<'EOF'
APP_IMAGE=ghcr.io/rivega42/ads-autopilot:sha-abc1234
WEB_IMAGE=ghcr.io/rivega42/ads-autopilot-web:sha-abc1234
EOF
./scripts/deploy.sh
```

Если делаешь руками из шелла, где `APP_IMAGE` уже экспортирован (например,
`source .env` в этой же сессии) — сначала `unset APP_IMAGE WEB_IMAGE`. При
подстановке в compose окружение перебивает `.env`, и деплой поднимет ровно ту
версию, от которой ты уходишь, отрапортовав об успехе.
