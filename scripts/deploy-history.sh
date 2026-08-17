#!/usr/bin/env bash
# История деплоев: что именно (какие образы) крутится на этом хосте и что крутилось до.
# Вызывается из scripts/deploy.sh и scripts/rollback.sh, руками нужен разве что
# для `list`.
#
# Почему файл на хосте, а не список тегов в GHCR: реестр знает, какие образы
# собраны, но не знает, какой из них доезжал до этой машины и поднимался здесь
# успешно. Плюс списку тегов нужен токен с read:packages и разбор JSON на
# проде — ради данных, которые деплой и так держит в руках. Файл лежит рядом с
# .env, в git не попадает и переживает `git pull`.
#
# Формат — TSV, по строке на событие:
#   <ISO-время>\t<deploy|rollback>\t<образ api>\t<образ web>\t<пин api>\t<пин web>
# Пины (колонки 5-6) добавлены позже; строки из четырёх колонок читаются как
# были, с пустыми пинами.
set -euo pipefail

# Сколько пин-тегов на образ держим. 0 — не чистить вовсе.
PIN_KEEP="${DEPLOY_PIN_KEEP:-8}"

usage() {
  cat >&2 <<'TXT'
использование:
  deploy-history.sh record <deploy|rollback> <файл-истории> <compose-файл>
  deploy-history.sh current <compose-файл>                 # что запущено сейчас
  deploy-history.sh last <файл-истории>                    # последняя запись
  deploy-history.sh previous <файл-истории> <app> <web>    # кандидат на откат
  deploy-history.sh list <файл-истории>
TXT
  exit 64
}

# Есть ли в ссылке реестр, из которого её можно вытянуть обратно. Правило то же,
# что у самого docker: часть до первого «/» считается хостом реестра, если в ней
# есть точка или порт (либо это localhost). Голое `ads-autopilot:app` реестра не
# имеет — тянуть такую ссылку неоткуда.
is_registry_ref() {
  local ref="$1" first="${1%%/*}"
  [[ "$ref" == */* ]] || return 1
  [[ "$first" == *.* || "$first" == *:* || "$first" == 'localhost' ]]
}

# Локальный неподвижный тег на образ, из которого поднят сервис.
#
# Зачем: у собранного здесь образа RepoDigests не пуст (docker 28+ с
# containerd-snapshotter'ом считает digest и локально), но этот digest — не
# ссылка на вечность. Пересборка того же тега (`docker build -t ads-autopilot:app .`,
# ровно сценарий docs/DEPLOY.md §4.2) отбирает у старого образа последнюю ссылку,
# и он удаляется целиком: не резолвится ни по digest, ни по ID, в dangling не
# висит. Отдельный тег, который никто не пересобирает, образ удерживает.
ensure_pin() {
  local img_ref="$1" img_id="$2" repo base short pin
  repo="${img_ref%@*}"
  repo="${repo%:*}"
  base="${repo##*/}"
  # Откатились на пин — и снова его закрепляем: без этой строки имя росло бы
  # хвостом (ads-autopilot-deployed-deployed-…) на каждом откате отката.
  base="${base%-deployed}"
  [[ -n "$base" ]] || return 1
  short="${img_id#sha256:}"
  pin="${base}-deployed:${short:0:12}"
  docker tag "$img_id" "$pin" >/dev/null 2>&1 || return 1
  echo "$pin"
}

# Пины копятся по два на деплой, а образ — это гигабайт с хвостом. Удаляем
# только теги, которые сами же и создали, и только сверх PIN_KEEP последних;
# docker images отдаёт список от свежих к старым. Задеплоенную сейчас версию
# ретеншен не заденет даже после отката на старый образ: `docker rmi` без -f
# отказывается снимать последнюю ссылку на образ, который занят контейнером
# (проверено и на running, и на stopped).
prune_pins() {
  local pin="$1" repo idx
  [[ "$PIN_KEEP" -gt 0 ]] || return 0
  repo="${pin%:*}"
  local tags=()
  mapfile -t tags < <(docker images --filter "reference=${repo}:*" --format '{{.Repository}}:{{.Tag}}' 2>/dev/null || true)
  ((${#tags[@]} > PIN_KEEP)) || return 0
  for ((idx = PIN_KEEP; idx < ${#tags[@]}; idx++)); do
    docker rmi "${tags[idx]}" >/dev/null 2>&1 || true
  done
}

# Печатает «<основная ссылка>\t<пин>» для сервиса.
#
# Основная ссылка для образа из реестра — digest: тег latest подвижен, и
# записанный в историю «latest» указывал бы после следующей публикации уже на
# другой образ. Для собранного здесь образа неподвижной ссылки не существует в
# принципе, поэтому основной становится пин — он хотя бы резолвится.
#
# Пин создаём и в read-командах: он выводится из ID образа, так что операция
# идемпотентная, а без неё `current` и `record` называли бы одну и ту же версию
# по-разному.
resolve_ref() {
  local compose_file="$1" svc="$2"
  local cid img_ref img_id repo digest pin=''

  cid="$(docker compose -f "$compose_file" ps -q "$svc" 2>/dev/null | head -n1)"
  [[ -n "$cid" ]] || return 1

  img_ref="$(docker inspect --format '{{.Config.Image}}' "$cid")"
  img_id="$(docker inspect --format '{{.Image}}' "$cid")"

  repo="${img_ref%@*}"
  repo="${repo%:*}"

  pin="$(ensure_pin "$img_ref" "$img_id" || true)"

  if is_registry_ref "$repo"; then
    while IFS= read -r digest; do
      [[ -n "$digest" ]] || continue
      if [[ "$digest" == "$repo@"* ]]; then
        printf '%s\t%s\n' "$digest" "$pin"
        return 0
      fi
    done < <(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$img_id" 2>/dev/null || true)
  fi

  if [[ -n "$pin" ]]; then
    printf '%s\t%s\n' "$pin" ''
  else
    echo "deploy-history: не смог закрепить образ $svc тегом, пишу подвижный $img_ref" >&2
    printf '%s\t%s\n' "$img_ref" ''
  fi
}

cmd_current() {
  local compose_file="$1" app web
  app="$(resolve_ref "$compose_file" api | cut -f1)" || return 1
  web="$(resolve_ref "$compose_file" web | cut -f1)" || return 1
  [[ -n "$app" && -n "$web" ]] || return 1
  printf '%s\t%s\n' "$app" "$web"
}

cmd_record() {
  local event="$1" file="$2" compose_file="$3"
  local app app_pin web web_pin
  if ! IFS=$'\t' read -r app app_pin < <(resolve_ref "$compose_file" api) ||
    ! IFS=$'\t' read -r web web_pin < <(resolve_ref "$compose_file" web) ||
    [[ -z "$app" || -z "$web" ]]; then
    echo "deploy-history: контейнеры api/web не найдены, запись пропущена" >&2
    return 0
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$event" "$app" "$web" "${app_pin:-}" "${web_pin:-}" >>"$file"
  echo "deploy-history: записано в $file"

  # У локальной сборки пин и есть основная ссылка, отдельной колонки для него нет.
  local ref
  for ref in "${app_pin:-$app}" "${web_pin:-$web}"; do
    if [[ "$ref" == *-deployed:* ]]; then
      prune_pins "$ref"
    fi
  done
}

# Последняя запись. Нужна, когда стек не запущен: тогда «что задеплоено» знает
# только история, и без этого откат уехал бы на ту же самую версию.
cmd_last() {
  local file="$1"
  [[ -s "$file" ]] || return 1
  awk -F'\t' '
    { sub(/\r$/, "") }
    $3 != "" && $4 != "" { app = $3; web = $4; apin = $5; wpin = $6; found = 1 }
    END {
      if (!found) exit 1
      print app "\t" web "\t" apin "\t" wpin
    }
  ' "$file"
}

cmd_previous() {
  local file="$1" cur_app="$2" cur_web="$3"
  [[ -s "$file" ]] || return 1
  # sub(/\r$/) до разбора на поля: строка с CRLF (её легко занести редактором с
  # windows-хоста) иначе доезжает до docker pull с невидимым \r в конце ссылки.
  awk -F'\t' -v cur_app="$cur_app" -v cur_web="$cur_web" '
    { sub(/\r$/, "") }
    $3 != "" && $4 != "" { n++; ev[n] = $2; app[n] = $3; web[n] = $4; apin[n] = $5; wpin[n] = $6 }
    END {
      skip[cur_app SUBSEP cur_web] = 1
      for (i = n; i >= 1; i--) {
        key = app[i] SUBSEP web[i]
        if (key in skip) continue
        # Версию, сразу после которой шёл откат, считаем забракованной: второй
        # rollback подряд должен уходить глубже, а не возвращать то, от чего
        # только что убежали.
        if (i < n && ev[i + 1] == "rollback") { skip[key] = 1; continue }
        print app[i] "\t" web[i] "\t" apin[i] "\t" wpin[i]
        exit 0
      }
      exit 1
    }
  ' "$file"
}

cmd_list() {
  local file="$1"
  if [[ ! -s "$file" ]]; then
    echo "deploy-history: история пуста ($file)"
    return 0
  fi
  awk -F'\t' '
    { sub(/\r$/, "") }
    $3 != "" { printf "%s  %-8s app=%s web=%s\n", $1, $2, $3, $4 }
  ' "$file"
}

[[ $# -ge 1 ]] || usage
case "$1" in
record)
  [[ $# -eq 4 ]] || usage
  cmd_record "$2" "$3" "$4"
  ;;
current)
  [[ $# -eq 2 ]] || usage
  cmd_current "$2"
  ;;
last)
  [[ $# -eq 2 ]] || usage
  cmd_last "$2"
  ;;
previous)
  [[ $# -eq 4 ]] || usage
  cmd_previous "$2" "$3" "$4"
  ;;
list)
  [[ $# -eq 2 ]] || usage
  cmd_list "$2"
  ;;
*) usage ;;
esac
