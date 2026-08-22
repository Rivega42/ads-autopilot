#!/usr/bin/env bash
# Дамп базы в ./backups/YYYY-MM-DD/ с ротацией. Запускается хостовым cron:
#   0 3 * * * cd /root/projects/ads-autopilot && ./scripts/backup-db.sh >> /var/log/ads-backup.log 2>&1
set -euo pipefail

# Пароль и имя базы берём из того же .env, что и стек: второй источник правды
# рано или поздно разойдётся с первым, и дамп молча пойдёт не в ту базу.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# Дефолты — после .env, но с уважением к тому, что передали в командной строке:
# `${VAR:-}` подхватил бы пустое значение из .env (там переменные принято
# объявлять пустыми), и дамп уехал бы в корень файловой системы.
COMPOSE_FILE="${COMPOSE_FILE:-}"
[[ -n "$COMPOSE_FILE" ]] || COMPOSE_FILE=docker-compose.prod.yml
RETENTION_DAYS="${RETENTION_DAYS:-}"
[[ -n "$RETENTION_DAYS" ]] || RETENTION_DAYS=30
BACKUP_ROOT="${BACKUP_ROOT:-}"
[[ -n "$BACKUP_ROOT" ]] || BACKUP_ROOT=./backups

: "${POSTGRES_USER:?POSTGRES_USER не задан}"
: "${POSTGRES_DB:?POSTGRES_DB не задан}"

DAY="$(date -u +%Y-%m-%d)"
STAMP="$(date -u +%H%M%S)"
DEST_DIR="${BACKUP_ROOT}/${DAY}"
DEST="${DEST_DIR}/${POSTGRES_DB}-${STAMP}.sql.gz"
# Пишем во временный файл и переносим только целый дамп. Если писать сразу в
# DEST, то оборванный pg_dump оставляет на диске валидный gzip с обрезанным SQL и
# свежим mtime: ротация выкинет рабочие копии раньше него.
TMP="${DEST}.part"

mkdir -p "$DEST_DIR"
trap 'rm -f "$TMP"' EXIT

# pg_dump пишет в stdout контейнера, сжимаем на хосте: так дамп не занимает место
# внутри контейнера и не зависит от свободного места в его слое.
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format=plain --no-owner |
  gzip -9 >"$TMP"

SIZE="$(stat -c%s "$TMP")"
if [[ "$SIZE" -lt 1024 ]]; then
  echo "backup-db: дамп подозрительно мал (${SIZE} байт), выбрасываю" >&2
  exit 1
fi

mv "$TMP" "$DEST"
trap - EXIT
echo "backup-db: готово $DEST (${SIZE} байт)"

find "$BACKUP_ROOT" -type f -name '*.sql.gz' -mtime "+${RETENTION_DAYS}" -print -delete
# -mindepth 1: без него find удалил бы сам BACKUP_ROOT, а это точка bind-mount'а
# в compose — пересозданный каталог получил бы другой инод, и контейнер postgres
# остался бы с /backups на удалённом.
find "$BACKUP_ROOT" -mindepth 1 -type d -empty -delete
