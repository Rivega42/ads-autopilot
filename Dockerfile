ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

# Манифесты копируются отдельно от исходников, чтобы слой с install переживал
# правку кода. Для workspace их четыре: без pnpm-workspace.yaml и web/package.json
# pnpm считает репозиторий одиночным пакетом и роняет --frozen-lockfile.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY web/package.json ./web/package.json
RUN pnpm install --frozen-lockfile

FROM base AS build
# Ни `prisma generate`, ни `next build` не подключаются к базе — URL нужен только
# для валидации схемы (в самой схеме datasource.url нет). Значение фиктивное и
# в образ не попадает: стадия build отбрасывается целиком.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build"
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/web/node_modules ./web/node_modules
COPY . .
# web/node_modules сносим сразу: следующий этап копирует каталог web целиком, и
# без этого в финальный образ уехали бы dev-зависимости дашборда.
RUN pnpm db:generate && pnpm build && pnpm --filter web build && rm -rf web/node_modules

# Прод-зависимости ставим начисто в отдельную папку. `pnpm prune --prod` здесь не
# годится: он выкинет @prisma/client вместе с сгенерированным клиентом, который
# лежит внутри пакета, и восстановить его в рантайме уже нечем.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY web/package.json ./web/package.json
RUN pnpm install --frozen-lockfile --prod
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build"
RUN pnpm db:generate

# ── Бэкенд: api, worker и bot из одного образа, роль выбирает entrypoint ──────
FROM node:${NODE_VERSION} AS app
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --chown=app:app package.json ./package.json
# Схема и миграции нужны в рантайме: entrypoint умеет накатывать их на старте.
COPY --chown=app:app prisma ./prisma
COPY --chown=app:app prisma.config.ts ./prisma.config.ts
COPY --chown=app:app docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# ── Дашборд ──────────────────────────────────────────────────────────────────
# Next 14 без output:'standalone', поэтому `next start` требует исходники
# страниц рядом с .next — копируем каталог web целиком.
FROM node:${NODE_VERSION} AS web
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
COPY --from=prod-deps --chown=app:app /app/web/node_modules ./web/node_modules
COPY --from=build --chown=app:app /app/web ./web
COPY --chown=app:app package.json ./package.json
WORKDIR /app/web
USER app
EXPOSE 3001
# 401 — здоровый ответ: дашборд закрыт basic-auth и без заголовка отвечает именно так.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -S --spider -T 3 -t 1 "http://127.0.0.1:3001/" 2>&1 | grep -qE 'HTTP/1\.1 (200|401)'
CMD ["node_modules/.bin/next", "start", "--port", "3001", "--hostname", "0.0.0.0"]
