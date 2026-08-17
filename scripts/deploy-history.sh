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
#   <ISO-время>\t<deploy|rollback>\t<образ api>\t<образ web>
set -euo pipefail

usage() {
  cat >&2 <<'TXT'
использование:
  deploy-history.sh record <deploy|rollback> <файл-истории> <compose-файл>
  deploy-history.sh current <compose-файл>                 # что запущено сейчас
  deploy-history.sh previous <файл-истории> <app> <web>    # кандидат на откат
  deploy-history.sh list <файл-истории>
TXT
  exit 64
}

# Ссылка на образ, из которого реально запущен сервис. Предпочитаем digest: тег
# latest подвижен, и записанный в историю «latest» указывал бы после следующей
# публикации уже на другой образ — откатываться было бы некуда.
resolve_ref() {
  local compose_file="$1" svc="$2"
  local cid img_ref img_id repo digest

  cid="$(docker compose -f "$compose_file" ps -q "$svc" 2>/dev/null | head -n1)"
  [[ -n "$cid" ]] || return 1

  img_ref="$(docker inspect --format '{{.Config.Image}}' "$cid")"
  img_id="$(docker inspect --format '{{.Image}}' "$cid")"

  repo="${img_ref%@*}"
  repo="${repo%:*}"

  # RepoDigests пуст у образа, собранного на этой же машине, — тогда остаётся
  # только тег. Для локальной сборки это честно: неподвижной ссылки на неё нет.
  while IFS= read -r digest; do
    [[ -n "$digest" ]] || continue
    if [[ "$digest" == "$repo@"* ]]; then
      echo "$digest"
      return 0
    fi
  done < <(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$img_id" 2>/dev/null || true)

  echo "$img_ref"
}

cmd_current() {
  local compose_file="$1" app web
  app="$(resolve_ref "$compose_file" api)" || return 1
  web="$(resolve_ref "$compose_file" web)" || return 1
  printf '%s\t%s\n' "$app" "$web"
}

cmd_record() {
  local event="$1" file="$2" compose_file="$3" pair
  if ! pair="$(cmd_current "$compose_file")"; then
    echo "deploy-history: контейнеры api/web не найдены, запись пропущена" >&2
    return 0
  fi
  printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$event" "$pair" >>"$file"
  echo "deploy-history: записано в $file"
}

cmd_previous() {
  local file="$1" cur_app="$2" cur_web="$3"
  [[ -s "$file" ]] || return 1
  awk -F'\t' -v cur_app="$cur_app" -v cur_web="$cur_web" '
    { n++; ev[n] = $2; app[n] = $3; web[n] = $4 }
    END {
      skip[cur_app SUBSEP cur_web] = 1
      for (i = n; i >= 1; i--) {
        key = app[i] SUBSEP web[i]
        if (key in skip) continue
        # Версию, сразу после которой шёл откат, считаем забракованной: второй
        # rollback подряд должен уходить глубже, а не возвращать то, от чего
        # только что убежали.
        if (i < n && ev[i + 1] == "rollback") { skip[key] = 1; continue }
        print app[i] "\t" web[i]
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
  awk -F'\t' '{ printf "%s  %-8s app=%s web=%s\n", $1, $2, $3, $4 }' "$file"
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
