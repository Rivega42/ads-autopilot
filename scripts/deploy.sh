#!/usr/bin/env bash
# Деплой прод-стека на текущем хосте: подтянуть образы, поднять, дождаться здоровья.
# Запускать из каталога проекта на сервере (см. docs/DEPLOY.md).
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
DEPLOY_HISTORY="${DEPLOY_HISTORY:-.deploy-history}"
# scripts/rollback.sh переиспользует этот скрипт и помечает своё событие иначе:
# по метке история отличает «выкатили новое» от «убежали со сломанного».
DEPLOY_EVENT="${DEPLOY_EVENT:-deploy}"

if [[ ! -f .env ]]; then
  echo "deploy: рядом нет .env — стек не поднимется без POSTGRES_*, TELEGRAM_* и ключа шифрования" >&2
  exit 1
fi

# Образы, собранные на самой машине (docs/DEPLOY.md §4), в реестре не лежат, и
# строгий pull обрывал бы деплой ещё до старта стека.
echo "deploy: pull"
PULL_LOG="$(mktemp)"
trap 'rm -f "$PULL_LOG"' EXIT
docker compose -f "$COMPOSE_FILE" pull --ignore-pull-failures 2>&1 | tee "$PULL_LOG"

# --ignore-pull-failures глотает и «нет такого образа», и «нет прав на пакет».
# Для локальной сборки это норма, для образа из GHCR — тихий деплой старой
# версии, поэтому хотя бы говорим об этом вслух.
if grep -qiE 'error|denied|unauthorized|not found|manifest unknown' "$PULL_LOG"; then
  echo "deploy: часть образов не скачалась (см. вывод pull выше)." >&2
  echo "deploy: для собранных на этой машине это ожидаемо; для ghcr.io — проверь docker login ghcr.io" >&2
fi

# --wait держит команду до healthy: без него скрипт завершался бы успехом ровно
# в тот момент, когда контейнеры только начали падать в рестарт-петлю.
echo "deploy: up"
docker compose -f "$COMPOSE_FILE" up -d --wait --wait-timeout "$HEALTH_TIMEOUT"

echo "deploy: health"
docker compose -f "$COMPOSE_FILE" exec -T api wget -qO- http://127.0.0.1:3000/health

# Что именно сейчас запущено — записываем в историю деплоев, из неё
# scripts/rollback.sh берёт «предыдущую» версию. Пишем только после успешного
# health: неподнявшийся стек откатывать не на что.
if [[ -x scripts/deploy-history.sh ]]; then
  ./scripts/deploy-history.sh record "$DEPLOY_EVENT" "$DEPLOY_HISTORY" "$COMPOSE_FILE"
fi

echo
echo "deploy: готово. DRY_RUN=$(docker compose -f "$COMPOSE_FILE" exec -T api printenv DRY_RUN || echo '?')"
