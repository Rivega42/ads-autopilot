#!/usr/bin/env bash
# Дамп базы в ./backups/YYYY-MM-DD/ с ротацией. Запускается хостовым cron:
#   0 3 * * * cd /root/projects/ads-autopilot && ./scripts/backup-db.sh >> /var/log/ads-backup.log 2>&1
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
BACKUP_ROOT="${BACKUP_ROOT:-./backups}"

# Пароль и имя базы берём из того же .env, что и стек: второй источник правды
# рано или поздно разойдётся с первым, и дамп молча пойдёт не в ту базу.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${POSTGRES_USER:?POSTGRES_USER не задан}"
: "${POSTGRES_DB:?POSTGRES_DB не задан}"

DAY="$(date -u +%Y-%m-%d)"
STAMP="$(date -u +%H%M%S)"
DEST_DIR="${BACKUP_ROOT}/${DAY}"
DEST="${DEST_DIR}/${POSTGRES_DB}-${STAMP}.sql.gz"

mkdir -p "$DEST_DIR"

# pg_dump пишет в stdout контейнера, сжимаем на хосте: так дамп не занимает место
# внутри контейнера и не зависит от свободного места в его слое.
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format=plain --no-owner |
  gzip -9 >"$DEST"

# Пустой дамп — это отказ, а не успех: без проверки ротация через месяц удалит
# последнюю рабочую копию, а на её месте будут лежать нули.
SIZE="$(stat -c%s "$DEST")"
if [[ "$SIZE" -lt 1024 ]]; then
  echo "backup-db: дамп подозрительно мал (${SIZE} байт), удаляю: $DEST" >&2
  rm -f "$DEST"
  exit 1
fi

echo "backup-db: готово $DEST (${SIZE} байт)"

find "$BACKUP_ROOT" -type f -name '*.sql.gz' -mtime "+${RETENTION_DAYS}" -print -delete
find "$BACKUP_ROOT" -type d -empty -delete
