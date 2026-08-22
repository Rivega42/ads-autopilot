#!/bin/sh
set -eu

# Одна роль на контейнер: api отдаёт HTTP, worker крутит очереди, bot держит
# long polling Telegram. Три процесса в одном контейнере нельзя — падение одного
# осталось бы незамеченным для докера.
ROLE="${ROLE:-api}"

run_migrations() {
  echo "entrypoint: prisma migrate deploy"
  # Собственный advisory-lock не нужен: prisma берёт его в Postgres сама, поэтому
  # одновременный старт нескольких контейнеров не приводит к гонке миграций.
  ./node_modules/.bin/prisma migrate deploy
}

# RUN_MIGRATIONS остаётся для одиночного запуска без compose. В прод-стеке
# миграции делает отдельная роль migrate: пока они шли внутри api, длинная
# миграция успевала провалить его healthcheck, и зависящие от него worker и bot
# не стартовали вовсе.
if [ "${RUN_MIGRATIONS:-false}" = "true" ] && [ "$ROLE" != "migrate" ]; then
  run_migrations
fi

case "$ROLE" in
migrate)
  run_migrations
  echo "entrypoint: миграции применены, выхожу"
  exit 0
  ;;
api) exec node dist/server.js ;;
worker) exec node dist/apps/worker.js ;;
bot) exec node dist/apps/bot.js ;;
# Ручной прогон: `docker compose run --rm -e ROLE=cli api campaign --client <id>`.
# `pnpm cli` из образа не работает и работать не может: прод-образ собран без
# pnpm и без tsx (обе — dev-зависимости), а `pnpm cli` — это `tsx src/apps/cli.ts`,
# то есть запуск исходников, которых в образе тоже нет. Запускается только
# собранный `dist/apps/cli.js`, и роль нужна затем, чтобы это знание жило здесь,
# а не в памяти дежурного.
cli) exec node dist/apps/cli.js "$@" ;;
# Приёмка ТЗ §9.6: `docker compose run --rm -e ROLE=acceptance api --days 1`.
# Отдельная роль, а не аргумент cli: команда возвращает 0/1/2 как вердикт, и
# смешивать эти коды с кодами возврата CLI нельзя. Процедура — docs/ACCEPTANCE.md.
acceptance) exec node dist/apps/acceptance.js "$@" ;;
*)
  echo "entrypoint: неизвестная роль ROLE=${ROLE}; ожидается migrate|api|worker|bot|cli|acceptance" >&2
  exit 64
  ;;
esac
