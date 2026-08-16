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

Собрать на месте:

```bash
docker build --target app -t ads-autopilot:app .
docker build --target web -t ads-autopilot-web:latest .
echo 'APP_IMAGE=ads-autopilot:app' >> .env
echo 'WEB_IMAGE=ads-autopilot-web:latest' >> .env
```

Либо взять готовые из GHCR — тогда `APP_IMAGE`/`WEB_IMAGE` не задавать, в compose
уже стоят значения по умолчанию.

## 5. Запуск

```bash
./scripts/deploy.sh
```

Скрипт делает `pull`, `up -d --wait` и дёргает `/health`. Миграции накатывает
контейнер `api` на старте (`RUN_MIGRATIONS=true`); prisma берёт advisory-lock,
поэтому повторный запуск деплоя безопасен.

## 6. Проверки после деплоя

```bash
docker compose -f docker-compose.prod.yml ps          # все healthy
curl -s https://api.example.ru/health                 # {"status":"ok",...}
curl -s -o /dev/null -w '%{http_code}\n' https://dash.example.ru/   # 401 — так и надо
docker compose -f docker-compose.prod.yml logs worker | grep 'worker started'
```

В логе воркера должны быть десять строк `scheduled repeatable job` — по одной на
задачу из TZ §3.4. Меньше — значит часть расписаний не встала.

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

## Обновление

```bash
git pull && ./scripts/deploy.sh
```

Откат: поставить прежний тег образа в `APP_IMAGE`/`WEB_IMAGE` и повторить деплой.
Миграции назад не откатываются — они пишутся backward-compatible (CLAUDE.md §7),
поэтому старый образ работает с новой схемой.
