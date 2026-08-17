#!/usr/bin/env bash
# Откат прод-стека на предыдущую версию образов. Запускать из каталога проекта
# на сервере: ./scripts/rollback.sh [--list] [--app REF] [--web REF] [--yes]
#
# Откуда берётся «предыдущая»: из файла истории деплоев (.deploy-history), куда
# scripts/deploy.sh пишет digest'ы образов после каждого успешного деплоя.
# Список тегов в GHCR для этого не годится — он говорит, что собрано, но не
# говорит, что доехало и поднялось именно здесь; плюс требует токена с
# read:packages и разбора JSON на проде. Аргумент командной строки остаётся как
# запасной путь: пустая история (первый деплой после ввода этого скрипта) или
# откат на конкретный sha-тег из GHCR.
#
# Чего скрипт не делает: не откатывает миграции. По CLAUDE.md §7 они
# backward-compatible, то есть старый код обязан работать с новой схемой, и
# «докатить назад» безопаснее всего никак. Но и молчать нельзя: применённые
# после отката миграции скрипт покажет и спросит подтверждение — если старый код
# с ними всё-таки не живёт, откат образа проблему не решит, тут нужен дамп.
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
DEPLOY_HISTORY="${DEPLOY_HISTORY:-.deploy-history}"
ENV_FILE="${ENV_FILE:-.env}"
HISTORY_TOOL="./scripts/deploy-history.sh"

TARGET_APP=""
TARGET_WEB=""
ASSUME_YES=false

while [[ $# -gt 0 ]]; do
  case "$1" in
  --list)
    "$HISTORY_TOOL" list "$DEPLOY_HISTORY"
    exit 0
    ;;
  --app)
    TARGET_APP="${2:?--app требует ссылку на образ}"
    shift 2
    ;;
  --web)
    TARGET_WEB="${2:?--web требует ссылку на образ}"
    shift 2
    ;;
  --yes | -y)
    ASSUME_YES=true
    shift
    ;;
  -h | --help)
    sed -n '2,17p' "$0"
    exit 0
    ;;
  *)
    echo "rollback: неизвестный аргумент $1" >&2
    exit 64
    ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "rollback: рядом нет $ENV_FILE — это не каталог развёрнутого проекта" >&2
  exit 1
fi

# POSTGRES_* нужны для проверки миграций, TELEGRAM_* — для уведомления. Источник
# тот же, что у стека: второй источник правды рано или поздно разойдётся с первым.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

notify_tg() {
  local text="$1"
  [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_ADMIN_CHAT_ID:-}" ]] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  curl -fsS --max-time 10 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_ADMIN_CHAT_ID}" \
    --data-urlencode "text=${text}" >/dev/null 2>&1 ||
    echo "rollback: уведомление в TG не ушло (не фатально)" >&2
}

# Значение пишем последней строкой, старые вхождения ключа выкидываем: иначе
# compose возьмёт последнее, а человек, читающий .env, — первое.
set_env_var() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  chmod --reference="$ENV_FILE" "$tmp" 2>/dev/null || chmod 600 "$tmp"
  grep -vE "^[[:space:]]*${key}=" "$ENV_FILE" >"$tmp" || true
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  mv "$tmp" "$ENV_FILE"
}

CURRENT_APP=""
CURRENT_WEB=""
if CURRENT="$("$HISTORY_TOOL" current "$COMPOSE_FILE" 2>/dev/null)"; then
  IFS=$'\t' read -r CURRENT_APP CURRENT_WEB <<<"$CURRENT"
  echo "rollback: сейчас запущено"
  echo "  app: $CURRENT_APP"
  echo "  web: $CURRENT_WEB"
else
  echo "rollback: стек не запущен — беру последнюю запись истории как есть" >&2
fi

if [[ -z "$TARGET_APP" || -z "$TARGET_WEB" ]]; then
  if PREV="$("$HISTORY_TOOL" previous "$DEPLOY_HISTORY" "$CURRENT_APP" "$CURRENT_WEB")"; then
    IFS=$'\t' read -r PREV_APP PREV_WEB <<<"$PREV"
    TARGET_APP="${TARGET_APP:-$PREV_APP}"
    TARGET_WEB="${TARGET_WEB:-$PREV_WEB}"
  else
    echo "rollback: в $DEPLOY_HISTORY нет версии, на которую можно откатиться." >&2
    echo "rollback: укажи образ явно, например" >&2
    echo "  ./scripts/rollback.sh --app ghcr.io/rivega42/ads-autopilot:sha-abc1234 \\" >&2
    echo "                        --web ghcr.io/rivega42/ads-autopilot-web:sha-abc1234" >&2
    echo "rollback: доступные теги видны на github.com/rivega42/ads-autopilot/pkgs/container/ads-autopilot" >&2
    exit 1
  fi
fi

if [[ -z "$TARGET_APP" || -z "$TARGET_WEB" ]]; then
  echo "rollback: не определён образ ($TARGET_APP / $TARGET_WEB) — история битая?" >&2
  echo "rollback: посмотри ./scripts/rollback.sh --list и укажи --app/--web руками" >&2
  exit 1
fi

echo "rollback: цель"
echo "  app: $TARGET_APP"
echo "  web: $TARGET_WEB"

if [[ "$TARGET_APP" == "$CURRENT_APP" && "$TARGET_WEB" == "$CURRENT_WEB" ]]; then
  echo "rollback: это те же образы, что уже запущены — откатывать нечего" >&2
  exit 1
fi

# Тянем образы до правки .env: если целевого образа нет ни локально, ни в
# реестре, лучше упасть здесь, чем оставить .env с несуществующим тегом.
for ref in "$TARGET_APP" "$TARGET_WEB"; do
  if ! docker image inspect "$ref" >/dev/null 2>&1; then
    echo "rollback: тяну $ref"
    docker pull "$ref"
  fi
done

REVISION="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$TARGET_APP" 2>/dev/null || true)"
[[ -z "$REVISION" || "$REVISION" == '<no value>' ]] || echo "rollback: коммит целевого образа $REVISION"

# ── Миграции ────────────────────────────────────────────────────────────────
# Сравниваем то, что уже применено в базе, с тем, что знает целевой образ.
# Разница = миграции, которые останутся применёнными после отката.
check_migrations() {
  local applied image_migrations extra
  if [[ -z "${POSTGRES_USER:-}" || -z "${POSTGRES_DB:-}" ]]; then
    echo "rollback: POSTGRES_USER/POSTGRES_DB не заданы, проверку миграций пропускаю" >&2
    return 0
  fi

  applied="$(docker compose -f "$COMPOSE_FILE" exec -T postgres \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
    'select migration_name from _prisma_migrations where finished_at is not null order by 1' 2>/dev/null || true)"
  if [[ -z "$applied" ]]; then
    echo "rollback: не смог прочитать _prisma_migrations (база не поднята?), проверку пропускаю" >&2
    return 0
  fi

  image_migrations="$(docker run --rm --entrypoint sh "$TARGET_APP" \
    -c 'ls -1 /app/prisma/migrations' 2>/dev/null | grep -E '^[0-9]{8,}_' | sort || true)"
  if [[ -z "$image_migrations" ]]; then
    echo "rollback: в целевом образе не нашёл prisma/migrations, проверку пропускаю" >&2
    return 0
  fi

  extra="$(comm -23 <(printf '%s\n' "$applied" | sed 's/[[:space:]]*$//' | sort) <(printf '%s\n' "$image_migrations"))"
  if [[ -z "$extra" ]]; then
    echo "rollback: новых миграций после целевой версии нет"
    return 0
  fi

  echo
  echo "ВНИМАНИЕ: в базе уже применены миграции, которых нет в целевом образе:"
  printf '%s\n' "$extra" | sed 's/^/  /'
  echo "Скрипт их НЕ откатывает. По CLAUDE.md §7 миграции backward-compatible,"
  echo "то есть старый код обязан работать с новой схемой — но если он с ней не"
  echo "работает, откат образа не поможет: нужен дамп (./scripts/backup-db.sh) и"
  echo "разбор руками. Схему после этого назад не вернуть без потери данных."
  echo
}

check_migrations

if [[ "$ASSUME_YES" != true ]]; then
  read -r -p "Откатываем? [y/N] " answer
  [[ "$answer" == [yY] ]] || {
    echo "rollback: отменено"
    exit 1
  }
fi

set_env_var APP_IMAGE "$TARGET_APP"
set_env_var WEB_IMAGE "$TARGET_WEB"
echo "rollback: в $ENV_FILE зафиксированы APP_IMAGE/WEB_IMAGE"

# Обязательно, а не «для порядка»: переменные окружения перебивают значения из
# .env при подстановке в compose, а мы сами их выше и экспортировали, читая
# .env. Без этой строки дочерний deploy.sh поднимал бы ровно ту версию, от
# которой убегаем, и рапортовал об успешном откате.
export APP_IMAGE="$TARGET_APP"
export WEB_IMAGE="$TARGET_WEB"

# Деплой переиспользуем целиком: pull, up --wait, health и запись в историю там
# уже сделаны и проверены. Метка события другая — см. deploy-history.sh.
if DEPLOY_EVENT=rollback ./scripts/deploy.sh; then
  echo "rollback: готово"
  notify_tg "🔙 Откат прода выполнен
app: $TARGET_APP
web: $TARGET_WEB
Внимание: APP_IMAGE/WEB_IMAGE закреплены в .env — следующий деплой пойдёт с них, пока не снимешь."
  echo
  echo "rollback: APP_IMAGE/WEB_IMAGE теперь закреплены в $ENV_FILE."
  echo "rollback: чтобы вернуться на актуальную версию — убери эти строки (или"
  echo "          поставь нужный тег) и запусти ./scripts/deploy.sh"
else
  echo "rollback: деплой откатной версии не поднялся — стек в неопределённом состоянии" >&2
  notify_tg "⚠️ Откат прода НЕ УДАЛСЯ
app: $TARGET_APP
web: $TARGET_WEB
Стек мог остаться недоступным, нужен человек."
  exit 1
fi
