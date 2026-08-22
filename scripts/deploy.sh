#!/usr/bin/env bash
# Деплой прод-стека на текущем хосте: подтянуть образы, поднять, дождаться здоровья.
# Запускать из каталога проекта на сервере (см. docs/DEPLOY.md).
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
# Сколько наблюдаем за сервисами без healthcheck, прежде чем поверить, что они
# поднялись. Бот выходит по таймауту getMe через полминуты — за меньшую выдержку
# рестарт-петля не успевает проявиться.
DEPLOY_SETTLE_SECONDS="${DEPLOY_SETTLE_SECONDS:-45}"
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
echo

# Тот же /health, но снаружи, через nginx. Проверка изнутри контейнера доказывает
# только что процесс жив: nginx резолвит апстримы и держит адрес, а api при выкате
# пересоздаётся — и деплой с зелёным внутренним health отдавал наружу 502.
# Правка в docker/nginx.conf.template это чинит, но проверять надо тем путём,
# которым ходят люди, иначе следующая такая поломка снова доедет до прода.
# Домен спрашиваем у самого nginx, а не парсим .env: там значение может быть в
# кавычках и с комментарием на конце, а в окружении контейнера лежит ровно то, что
# compose подставил в конфиг.
API_DOMAIN_VALUE="$(docker compose -f "$COMPOSE_FILE" exec -T nginx printenv API_DOMAIN 2>/dev/null | tr -d '\r' || true)"
# Пропуск — только по явному требованию, а не потому, что чего-то не нашлось.
# Проверка, которая молча самоотключается там, где условия ей не подошли, — это
# ровно тот дефект, который она и закрывает: зелёный выкат при лежащем наружу API.
# На хосте без curl это будет громко и один раз, а не тихо и каждый выкат.
if [[ "${DEPLOY_SKIP_NGINX_CHECK:-0}" == "1" ]]; then
  echo "deploy: проверка через nginx отключена явно (DEPLOY_SKIP_NGINX_CHECK=1)" >&2
elif ! command -v curl >/dev/null 2>&1; then
  echo "deploy: curl не найден, а проверить маршрут больше нечем (apt install curl)" >&2
  echo "deploy: осознанный пропуск — DEPLOY_SKIP_NGINX_CHECK=1 ./scripts/deploy.sh" >&2
  exit 1
elif [[ -z "$API_DOMAIN_VALUE" ]]; then
  echo "deploy: nginx не отдал API_DOMAIN — проверить маршрут не по чему" >&2
  echo "deploy: смотри API_DOMAIN в .env и docker compose config" >&2
  exit 1
else
  echo "deploy: health через nginx ($API_DOMAIN_VALUE)"
  # --noproxy: разговор идёт с локальным портом, любой прокси из окружения тут лишний.
  # -k: сертификат может быть самоподписанным на стенде; проверяем маршрут, не TLS.
  NGINX_CODE="$(curl -sk --noproxy '*' --max-time 15 -o /dev/null -w '%{http_code}' \
    --resolve "$API_DOMAIN_VALUE:443:127.0.0.1" "https://$API_DOMAIN_VALUE/health" || echo 000)"
  if [[ "$NGINX_CODE" != "200" ]]; then
    echo "deploy: nginx отдал $NGINX_CODE вместо 200 на https://$API_DOMAIN_VALUE/health" >&2
    echo "deploy: api жив (проверка выше прошла), значит дело в прокси — смотри logs nginx" >&2
    exit 1
  fi
  echo "deploy: nginx → 200"
fi

# Сервисы без healthcheck (worker, bot) `up --wait` считает готовыми в момент
# создания контейнера — падающий на старте процесс проходит выкат как «Healthy».
# Ловим петлю по счётчику рестартов, снятому дважды с выдержкой: он растёт ровно
# тогда, когда контейнер перезапускался, и не зависит ни от какой константы из кода.
echo "deploy: выдержка ${DEPLOY_SETTLE_SECONDS}с (worker, bot)"
declare -A RESTARTS_BEFORE=()
for svc in worker bot; do
  cid="$(docker compose -f "$COMPOSE_FILE" ps -q "$svc" || true)"
  [[ -n "$cid" ]] || continue
  RESTARTS_BEFORE["$svc"]="$(docker inspect -f '{{.RestartCount}}' "$cid")"
done
sleep "$DEPLOY_SETTLE_SECONDS"
for svc in worker bot; do
  cid="$(docker compose -f "$COMPOSE_FILE" ps -q "$svc" || true)"
  if [[ -z "$cid" ]]; then
    echo "deploy: контейнер $svc не найден" >&2
    exit 1
  fi
  state="$(docker inspect -f '{{.State.Status}}' "$cid")"
  after="$(docker inspect -f '{{.RestartCount}}' "$cid")"
  before="${RESTARTS_BEFORE[$svc]:-0}"
  if [[ "$state" != "running" || "$after" != "$before" ]]; then
    echo "deploy: $svc не удержался (состояние $state, рестартов $before→$after)" >&2
    echo "deploy: docker compose -f $COMPOSE_FILE logs $svc" >&2
    exit 1
  fi
  echo "deploy: $svc держится"
done

# Что именно сейчас запущено — записываем в историю деплоев, из неё
# scripts/rollback.sh берёт «предыдущую» версию. Пишем только после успешного
# health: неподнявшийся стек откатывать не на что.
if [[ -x scripts/deploy-history.sh ]]; then
  ./scripts/deploy-history.sh record "$DEPLOY_EVENT" "$DEPLOY_HISTORY" "$COMPOSE_FILE"
fi

echo
echo "deploy: готово. DRY_RUN=$(docker compose -f "$COMPOSE_FILE" exec -T api printenv DRY_RUN || echo '?')"
