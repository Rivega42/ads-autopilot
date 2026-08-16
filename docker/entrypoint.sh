#!/bin/sh
set -eu

# Одна роль на контейнер: api отдаёт HTTP, worker крутит очереди, bot держит
# long polling Telegram. Три процесса в одном контейнере нельзя — падение одного
# осталось бы незамеченным для докера.
ROLE="${ROLE:-api}"

if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  echo "entrypoint: prisma migrate deploy (ROLE=${ROLE})"
  # Собственный advisory-lock не нужен: prisma берёт его в Postgres сама, поэтому
  # одновременный старт нескольких контейнеров не приводит к гонке миграций.
  ./node_modules/.bin/prisma migrate deploy
fi

case "$ROLE" in
api) exec node dist/server.js ;;
worker) exec node dist/apps/worker.js ;;
bot) exec node dist/apps/bot.js ;;
*)
  echo "entrypoint: неизвестная роль ROLE=${ROLE}; ожидается api|worker|bot" >&2
  exit 64
  ;;
esac
