#!/usr/bin/env bash
# Откат прод-стека на предыдущую версию образов. Запускать из каталога проекта
# на сервере: ./scripts/rollback.sh [--list] [--app REF] [--web REF] [--yes]
#
#   --list      показать историю деплоев этой машины и выйти
#   --app REF   откатить api/worker/bot на конкретный образ
#   --web REF   откатить дашборд на конкретный образ
#   --yes, -y   не спрашивать подтверждения (для неинтерактивных запусков)
#
# Откуда берётся «предыдущая»: из файла истории деплоев (.deploy-history), куда
# scripts/deploy.sh пишет ссылки на образы после каждого успешного деплоя.
# Список тегов в GHCR для этого не годится — он говорит, что собрано, но не
# говорит, что доехало и поднялось именно здесь; плюс требует токена с
# read:packages и разбора JSON на проде. Аргументы --app/--web остаются как
# запасной путь: пустая история (первый деплой после ввода этого скрипта) или
# откат на конкретный sha-тег из GHCR. Указать можно один из двух — вторая
# половина возьмётся из истории, а если истории нет, останется как есть.
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
TARGET_APP_PIN=""
TARGET_WEB_PIN=""
ASSUME_YES=false

# Временный файл — копия .env со всеми секретами. Без trap'а оборванный на
# полпути скрипт оставлял бы его в каталоге деплоя.
TMP_FILES=()
cleanup() {
  [[ ${#TMP_FILES[@]} -eq 0 ]] || rm -f "${TMP_FILES[@]}"
}
trap cleanup EXIT

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
    # Шапка файла и есть справка; диапазон строк не фиксируем, чтобы он не
    # разъезжался при каждой правке комментария.
    awk 'NR > 1 && /^#/ { sub(/^#[[:space:]]?/, ""); print; next } NR > 1 { exit }' "$0"
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

# POSTGRES_* нужны для проверки миграций, TELEGRAM_* — для уведомления.
#
# Читаем файл сами, а не через `source`: у compose и у bash разные парсеры одного
# и того же файла. Значение с неэкранированным пробелом compose возьмёт целиком,
# а bash выполнит второе слово как команду; значение с `$(...)` или backtick bash
# просто исполнит — из файла, в котором лежат ключ шифрования и токены. Правила
# берём compose'овские: комментарии, необязательный `export`, последнее вхождение
# ключа побеждает, окружающие кавычки снимаются. Приоритет тоже как у compose:
# переменная окружения перебивает файл.
env_get() {
  # Кавычка приходит через -v: hex-эскейпы в регулярках есть не у всякого awk,
  # а на Ubuntu по умолчанию mawk, а не gawk.
  awk -v key="$1" -v sq="'" '
    { sub(/\r$/, "") }
    /^[[:space:]]*#/ { next }
    {
      line = $0
      sub(/^[[:space:]]*/, "", line)
      sub(/^export[[:space:]]+/, "", line)
      eq = index(line, "=")
      if (eq == 0) next
      k = substr(line, 1, eq - 1)
      sub(/[[:space:]]+$/, "", k)
      if (k != key) next
      v = substr(line, eq + 1)
      q = substr(v, 1, 1)
      if (length(v) >= 2 && substr(v, length(v)) == q && (q == "\"" || q == sq))
        v = substr(v, 2, length(v) - 2)
      found = v
    }
    END { if (found != "") print found }
  ' "$ENV_FILE"
}

POSTGRES_USER="${POSTGRES_USER:-$(env_get POSTGRES_USER)}"
POSTGRES_DB="${POSTGRES_DB:-$(env_get POSTGRES_DB)}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-$(env_get TELEGRAM_BOT_TOKEN)}"
TELEGRAM_ADMIN_CHAT_ID="${TELEGRAM_ADMIN_CHAT_ID:-$(env_get TELEGRAM_ADMIN_CHAT_ID)}"

notify_tg() {
  local text="$1"
  [[ -n "$TELEGRAM_BOT_TOKEN" && -n "$TELEGRAM_ADMIN_CHAT_ID" ]] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  # URL с токеном идёт в curl через --config, а не аргументом: аргументы видны в
  # `ps -eo args` любому локальному пользователю (CLAUDE.md §6).
  local sent=true
  curl -fsS --max-time 10 --config - \
    --data-urlencode "chat_id=${TELEGRAM_ADMIN_CHAT_ID}" \
    --data-urlencode "text=${text}" >/dev/null 2>&1 <<CFG || sent=false
url = "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage"
CFG
  [[ "$sent" == true ]] || echo "rollback: уведомление в TG не ушло (не фатально)" >&2
}

# Значение пишем последней строкой, старые вхождения ключа выкидываем: иначе
# compose возьмёт последнее, а человек, читающий .env, — первое.
set_env_var() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  TMP_FILES+=("$tmp")
  chmod --reference="$ENV_FILE" "$tmp" 2>/dev/null || chmod 600 "$tmp"
  grep -vE "^[[:space:]]*${key}=" "$ENV_FILE" >"$tmp" || true
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  mv "$tmp" "$ENV_FILE"
}

# Мусор в ссылке (чаще всего — невидимый \r от редактора с windows-хоста) лучше
# поймать здесь, чем услышать от docker pull «invalid reference format».
valid_ref() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@-]*$ ]]
}

is_registry_ref() {
  local ref="$1" first="${1%%/*}"
  [[ "$ref" == */* ]] || return 1
  [[ "$first" == *.* || "$first" == *:* || "$first" == 'localhost' ]]
}

# Печатает ссылку, которой реально можно поднять сервис: она же, если образ на
# месте; иначе локальный пин (docs/DEPLOY.md §4.2); иначе тянем из реестра.
resolve_image() {
  local ref="$1" pin="${2:-}"
  if docker image inspect "$ref" >/dev/null 2>&1; then
    printf '%s' "$ref"
    return 0
  fi
  if [[ -n "$pin" ]] && docker image inspect "$pin" >/dev/null 2>&1; then
    echo "rollback: $ref локально не нашёлся, беру закреплённый $pin" >&2
    printf '%s' "$pin"
    return 0
  fi
  if is_registry_ref "$ref"; then
    echo "rollback: тяну $ref" >&2
    docker pull "$ref" >&2 </dev/null && {
      printf '%s' "$ref"
      return 0
    }
    return 1
  fi
  echo "rollback: образа $ref на этой машине нет, и тянуть его неоткуда:" >&2
  echo "rollback: ссылка локальная, реестр в ней не указан. Так бывает после" >&2
  echo "rollback: 'docker system prune -af' или когда версия старше последних" >&2
  echo "rollback: DEPLOY_PIN_KEEP (=${DEPLOY_PIN_KEEP:-8}) закреплённых. Собери нужный коммит" >&2
  echo "rollback: заново (docs/DEPLOY.md §4.2) или укажи --app/--web образом из GHCR." >&2
  return 1
}

CURRENT_APP=""
CURRENT_WEB=""
CURRENT_KNOWN=false
if CURRENT="$("$HISTORY_TOOL" current "$COMPOSE_FILE" 2>/dev/null)"; then
  IFS=$'\t' read -r CURRENT_APP CURRENT_WEB <<<"$CURRENT"
  CURRENT_KNOWN=true
  echo "rollback: сейчас запущено"
  echo "  app: $CURRENT_APP"
  echo "  web: $CURRENT_WEB"
# `docker compose ps -q` пуст не только у снесённого стека, но и у просто
# остановленного (`down`, `stop`, ребут хоста) — а это ровно то состояние, в
# котором откатываются чаще всего. Без этой ветки «предыдущей» оказывалась
# последняя запись истории, то есть текущая версия, и скрипт бодро рапортовал об
# откате, ничего не откатив.
elif CURRENT="$("$HISTORY_TOOL" last "$DEPLOY_HISTORY" 2>/dev/null)"; then
  IFS=$'\t' read -r CURRENT_APP CURRENT_WEB _ _ <<<"$CURRENT"
  CURRENT_KNOWN=true
  echo "rollback: стек не запущен — за текущую версию беру последнюю запись $DEPLOY_HISTORY"
  echo "  app: $CURRENT_APP"
  echo "  web: $CURRENT_WEB"
else
  echo "rollback: стек не запущен и история пуста — текущая версия неизвестна" >&2
fi

if [[ -z "$TARGET_APP" || -z "$TARGET_WEB" ]]; then
  if PREV="$("$HISTORY_TOOL" previous "$DEPLOY_HISTORY" "$CURRENT_APP" "$CURRENT_WEB")"; then
    IFS=$'\t' read -r PREV_APP PREV_WEB PREV_APP_PIN PREV_WEB_PIN <<<"$PREV"
    if [[ -z "$TARGET_APP" ]]; then
      TARGET_APP="$PREV_APP"
      TARGET_APP_PIN="$PREV_APP_PIN"
    fi
    if [[ -z "$TARGET_WEB" ]]; then
      TARGET_WEB="$PREV_WEB"
      TARGET_WEB_PIN="$PREV_WEB_PIN"
    fi
  else
    # Подходящей записи в истории нет, но половину указали руками: вторую
    # оставляем как есть. Отказать в откате целиком — ровно тот случай, ради
    # которого --app/--web и заявлены в шапке запасным путём.
    TARGET_APP="${TARGET_APP:-$CURRENT_APP}"
    TARGET_WEB="${TARGET_WEB:-$CURRENT_WEB}"
  fi
fi

if [[ -z "$TARGET_APP" || -z "$TARGET_WEB" ]]; then
  echo "rollback: не на что откатываться: в $DEPLOY_HISTORY нет подходящей записи," >&2
  echo "rollback: а $([[ -z "$TARGET_APP" ]] && echo --app || echo --web) не указан и текущую версию взять неоткуда." >&2
  echo "rollback: укажи образы явно, например" >&2
  echo "  ./scripts/rollback.sh --app ghcr.io/rivega42/ads-autopilot:sha-abc1234 \\" >&2
  echo "                        --web ghcr.io/rivega42/ads-autopilot-web:sha-abc1234" >&2
  echo "rollback: доступные теги видны на github.com/rivega42/ads-autopilot/pkgs/container/ads-autopilot" >&2
  exit 1
fi

for ref in "$TARGET_APP" "$TARGET_WEB"; do
  if ! valid_ref "$ref"; then
    echo "rollback: ссылка «$ref» не похожа на образ — опечатка в --app/--web или битая строка в $DEPLOY_HISTORY" >&2
    echo "rollback: посмотри ./scripts/rollback.sh --list и укажи --app/--web руками" >&2
    exit 1
  fi
done

echo "rollback: цель"
echo "  app: $TARGET_APP"
echo "  web: $TARGET_WEB"

if [[ "$CURRENT_KNOWN" == true && "$TARGET_APP" == "$CURRENT_APP" && "$TARGET_WEB" == "$CURRENT_WEB" ]]; then
  echo "rollback: это та же версия, что уже задеплоена — откатывать нечего" >&2
  exit 1
fi

# Достаём образы до правки .env: если целевого образа нет ни локально, ни в
# реестре, лучше упасть здесь, чем оставить .env с несуществующим тегом.
TARGET_APP="$(resolve_image "$TARGET_APP" "$TARGET_APP_PIN")"
TARGET_WEB="$(resolve_image "$TARGET_WEB" "$TARGET_WEB_PIN")"

REVISION="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$TARGET_APP" 2>/dev/null || true)"
[[ -z "$REVISION" || "$REVISION" == '<no value>' ]] || echo "rollback: коммит целевого образа $REVISION"

# ── Миграции ────────────────────────────────────────────────────────────────
# Сравниваем то, что уже применено в базе, с тем, что знает целевой образ.
# Разница = миграции, которые останутся применёнными после отката.
check_migrations() {
  local applied image_migrations extra
  if [[ -z "$POSTGRES_USER" || -z "$POSTGRES_DB" ]]; then
    echo "rollback: POSTGRES_USER/POSTGRES_DB не заданы, проверку миграций пропускаю" >&2
    return 0
  fi

  # </dev/null обязателен: `compose exec -T` вычитывает stdin скрипта до конца,
  # и без этого ответ на вопрос ниже (`echo y | ./scripts/rollback.sh`) уезжал бы
  # в psql, а read получал бы EOF.
  applied="$(docker compose -f "$COMPOSE_FILE" exec -T postgres \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
    'select migration_name from _prisma_migrations where finished_at is not null order by 1' \
    </dev/null 2>/dev/null || true)"
  if [[ -z "$applied" ]]; then
    echo "rollback: не смог прочитать _prisma_migrations (база не поднята?), проверку пропускаю" >&2
    return 0
  fi

  image_migrations="$(docker run --rm --entrypoint sh "$TARGET_APP" \
    -c 'ls -1 /app/prisma/migrations' </dev/null 2>/dev/null | grep -E '^[0-9]{8,}_' | sort || true)"
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
  answer=''
  printf 'Откатываем? [y/N] '
  # На EOF read возвращает ненулевой код, и под `set -e` скрипт падал бы молча,
  # не дойдя до строчки «отменено».
  if ! read -r answer && [[ -z "$answer" ]]; then
    echo
    echo "rollback: отвечать некому (stdin пуст) — запусти из терминала или добавь --yes" >&2
    exit 1
  fi
  if [[ ! "$answer" =~ ^[yY]([eE][sS])?$ ]]; then
    echo "rollback: отменено"
    exit 1
  fi
fi

set_env_var APP_IMAGE "$TARGET_APP"
set_env_var WEB_IMAGE "$TARGET_WEB"
echo "rollback: в $ENV_FILE зафиксированы APP_IMAGE/WEB_IMAGE"

# Обязательно, а не «для порядка»: переменные окружения перебивают значения из
# .env при подстановке в compose. Если APP_IMAGE уже экспортирован в шелле, из
# которого запускают откат, дочерний deploy.sh поднял бы ровно ту версию, от
# которой убегаем, и отрапортовал об успешном откате.
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
