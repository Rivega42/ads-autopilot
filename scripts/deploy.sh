#!/usr/bin/env bash
# Деплой прод-стека на текущем хосте: подтянуть образы, поднять, дождаться здоровья.
# Запускать из каталога проекта на сервере (см. docs/DEPLOY.md).
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"

if [[ ! -f .env ]]; then
  echo "deploy: рядом нет .env — стек не поднимется без POSTGRES_*, TELEGRAM_* и ключа шифрования" >&2
  exit 1
fi

# Образы, собранные на самой машине (docs/DEPLOY.md §4), в реестре не лежат, и
# строгий pull обрывал бы деплой ещё до старта стека.
echo "deploy: pull"
docker compose -f "$COMPOSE_FILE" pull --ignore-pull-failures

# --wait держит команду до healthy: без него скрипт завершался бы успехом ровно
# в тот момент, когда контейнеры только начали падать в рестарт-петлю.
echo "deploy: up"
docker compose -f "$COMPOSE_FILE" up -d --wait --wait-timeout "$HEALTH_TIMEOUT"

echo "deploy: health"
docker compose -f "$COMPOSE_FILE" exec -T api wget -qO- http://127.0.0.1:3000/health

echo
echo "deploy: готово. DRY_RUN=$(docker compose -f "$COMPOSE_FILE" exec -T api printenv DRY_RUN || echo '?')"
