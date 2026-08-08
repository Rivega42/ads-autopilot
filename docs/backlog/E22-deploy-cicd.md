# E22 — Deploy, CI/CD и production

**Цель:** воспроизводимый деплой одной командой на любой VPS Selectel/Hetzner, zero-downtime, автобэкапы, staging-окружение, security-hardening.

**Зависимости:** E01–E21 (всё готово к продакшену).
**DoD эпика:** `./deploy.sh production` — работает, DB бэкапится ежедневно и восстанавливается автоматом в тесте, CI не даёт слить сломанный код в main.

---

## Dockerfile и образ

- [ ] **T22.01** — Multi-stage Dockerfile для API
  - **DoD:** этапы: `deps` (npm ci) → `build` (tsc + prisma generate) → `runtime` (только dist + node_modules production); node:20-alpine; финальный образ < 300МБ
  - **Files:** `Dockerfile`
  - **P0** · 45м

- [ ] **T22.02** — Dockerfile для worker
  - **DoD:** такой же образ, но `CMD ["node", "dist/worker.js"]`; либо один образ + переменная `ROLE=api|worker`
  - **Files:** тот же Dockerfile + entrypoint.sh
  - **P0** · 25м

- [ ] **T22.03** — `.dockerignore`
  - **DoD:** node_modules, .git, dist, coverage, *.log, .env*, .vscode
  - **Files:** `.dockerignore`
  - **P0** · 10м

- [ ] **T22.04** — Non-root пользователь в контейнере
  - **DoD:** `USER node`; каталог `/app` принадлежит node:node
  - **Files:** Dockerfile
  - **P0** · 15м

- [ ] **T22.05** — Healthcheck в Dockerfile
  - **DoD:** `HEALTHCHECK CMD curl -f localhost:PORT/health || exit 1`
  - **Files:** Dockerfile
  - **P0** · 10м

## docker-compose

- [ ] **T22.06** — `docker-compose.yml` — прод-стек
  - **DoD:** сервисы: `api`, `worker`, `postgres:16`, `redis:7`, `nginx`; сеть `internal`; volume для pg_data, redis_data
  - **Files:** `docker-compose.yml`
  - **P0** · 45м

- [ ] **T22.07** — `docker-compose.dev.yml`
  - **DoD:** мгновенная разработка: bind mount кода, `npm run dev`; отдельные порты; profile `--profile dev`
  - **Files:** dev-compose
  - **P0** · 30м

- [ ] **T22.08** — Nginx reverse-proxy
  - **DoD:** `nginx/nginx.conf`: `api.ads.example.ru` → api:3000; TLS через Certbot (bind mount `/etc/letsencrypt`); `security headers` (HSTS, CSP, X-Frame-Options)
  - **Files:** nginx.conf + docker-compose config
  - **P0** · 55м

- [ ] **T22.09** — Автоматический TLS
  - **DoD:** `certbot renew` в cron + hook на reload nginx; описано в README
  - **Files:** `scripts/setup-tls.sh` + документация
  - **P1** · 35м

## Migrations и запуск

- [ ] **T22.10** — Prisma migrate на старте
  - **DoD:** `entrypoint.sh`: если `RUN_MIGRATIONS=true` → `prisma migrate deploy` затем `node dist/main.js`; лочит advisory-lock, чтобы 2 инстанса не мигрировали одновременно
  - **Files:** `entrypoint.sh`
  - **P0** · 40м

- [ ] **T22.11** — Prisma seed для нового tenant
  - **DoD:** `prisma/seed.ts`: базовые пороги, дефолтные шаблоны промптов; запуск через `npm run seed`
  - **Files:** seed.ts
  - **P1** · 25м

## CI (GitHub Actions)

- [ ] **T22.12** — Обновить `ci.yml`: lint + typecheck + test с PG16
  - **DoD:** уже есть на старте — проверить, что покрывает всё; matrix Node 20; кэш npm
  - **Files:** `.github/workflows/ci.yml`
  - **P0** · 30м

- [ ] **T22.13** — Job «prisma migrate check»
  - **DoD:** поднимает PG в services, `prisma migrate deploy` + `prisma generate` — фейлится, если миграции битые
  - **Files:** ci.yml (добавить job)
  - **P0** · 25м

- [ ] **T22.14** — Job «build docker image»
  - **DoD:** только на push в main: собирает Docker image, пушит в GHCR (`ghcr.io/rivega42/ads-autopilot:sha-XXXX` + `:latest`)
  - **Files:** `.github/workflows/build.yml`
  - **P0** · 40м

- [ ] **T22.15** — Job «trivy scan»
  - **DoD:** сканит образ Trivy; ломает CI при HIGH/CRITICAL уязвимостях (allow-list через `.trivyignore`)
  - **Files:** build.yml (добавить step)
  - **P1** · 30м

- [ ] **T22.16** — Job «sbom generation»
  - **DoD:** генерит SBOM (syft) — как артефакт release-а
  - **Files:** build.yml
  - **P2** · 25м

- [ ] **T22.17** — Semantic-release / release notes
  - **DoD:** на теге `v*` — автогенерация CHANGELOG.md + GitHub Release + тег на образе `:v1.2.3`
  - **Files:** `.releaserc` + `.github/workflows/release.yml`
  - **P2** · 45м

## Deploy

- [ ] **T22.18** — `scripts/deploy.sh <env>`
  - **DoD:** параметры env=staging|production; читает `deploy/<env>.env`; SSH на целевой хост, `docker compose pull && docker compose up -d --wait`; healthcheck после
  - **Files:** `scripts/deploy.sh`
  - **P0** · 60м

- [ ] **T22.19** — Zero-downtime rolling update
  - **DoD:** запускаем новый api вторым инстансом рядом, nginx делает graceful reload, старый останавливаем; для worker'а — SIGTERM + drain BullMQ
  - **Files:** deploy.sh + graceful shutdown в `src/main.ts`
  - **P0** · 60м

- [ ] **T22.20** — Rollback команда
  - **DoD:** `scripts/rollback.sh` — берёт предыдущий тег в GHCR, деплоит его; лог в TG
  - **Files:** rollback.sh
  - **P0** · 30м

- [ ] **T22.21** — Ansible playbook (опционально)
  - **DoD:** `ansible/playbook.yml` — bootstrap чистого VPS: docker, docker-compose plugin, ufw, fail2ban, unattended-upgrades, non-root user
  - **Files:** ansible/
  - **P1** · 90м

- [ ] **T22.22** — Terraform для Selectel (опционально)
  - **DoD:** `terraform/` — модуль создаёт VPS 8/16, floating IP, снапшот-политику
  - **Files:** terraform/
  - **P2** · 90м

## Backups

- [ ] **T22.23** — Скрипт `scripts/backup-db.sh`
  - **DoD:** `pg_dump` → gzip → сохраняется в `/backups/YYYY-MM-DD/`; хранение 30 дней; ротация
  - **Files:** backup-db.sh + cron
  - **P0** · 40м

- [ ] **T22.24** — Upload бэкапов в S3-compatible
  - **DoD:** после дампа — `rclone copy` в Yandex Object Storage / Selectel; путь `s3://backups/ads-autopilot/YYYY-MM-DD/`
  - **Files:** backup-db.sh (расширение)
  - **P0** · 35м

- [ ] **T22.25** — Автоматический restore-тест
  - **DoD:** раз в неделю — берём последний бэкап, разворачиваем в отдельную PG-инстанцию, прогоняем `SELECT COUNT(*)` по ключевым таблицам, репорт в TG
  - **Files:** `scripts/verify-backup.sh` + cron
  - **P1** · 60м

- [ ] **T22.26** — Backup Redis (BullMQ jobs)
  - **DoD:** `BGSAVE` + upload `dump.rdb` раз в час; хранение 24ч
  - **Files:** `scripts/backup-redis.sh` + cron
  - **P1** · 30м

## Staging

- [ ] **T22.27** — Отдельный docker-compose для staging
  - **DoD:** те же образы, отдельная БД, песочница провайдеров (Yandex Direct sandbox, VK test-account); домен `staging.api.ads.example.ru`
  - **Files:** `docker-compose.staging.yml`
  - **P1** · 45м

- [ ] **T22.28** — Автодеплой staging на push в main
  - **DoD:** GH Actions job после build → `deploy.sh staging`
  - **Files:** `.github/workflows/deploy-staging.yml`
  - **P1** · 30м

- [ ] **T22.29** — Прод-деплой на тег
  - **DoD:** только на `v*` тег + ручной approval (GitHub Environment) → `deploy.sh production`
  - **Files:** `.github/workflows/deploy-prod.yml`
  - **P0** · 40м

## Security-hardening

- [ ] **T22.30** — UFW правила на хосте
  - **DoD:** только 22, 80, 443; всё остальное deny; описано в ansible / README
  - **Files:** ansible/roles/firewall/
  - **P0** · 20м

- [ ] **T22.31** — Fail2ban для sshd + nginx
  - **DoD:** jail для sshd (5 попыток → бан 1ч), для nginx-basic-auth (админка dashboard)
  - **Files:** ansible + `/etc/fail2ban/jail.d/`
  - **P1** · 30м

- [ ] **T22.32** — Secrets в docker через файлы, не env
  - **DoD:** используем `secrets:` в compose (bind /run/secrets); в приложении читаем `SECRETS_DIR`
  - **Files:** compose + `src/config.ts`
  - **P1** · 40м

- [ ] **T22.33** — Read-only rootfs где возможно
  - **DoD:** `read_only: true` для api/worker, `tmpfs` для /tmp
  - **Files:** compose
  - **P2** · 25м

- [ ] **T22.34** — Автообновления системных пакетов
  - **DoD:** unattended-upgrades с security-only; уведомление в TG при applied
  - **Files:** ansible
  - **P1** · 25м

## Документация

- [ ] **T22.35** — `docs/DEPLOY.md` — прод-runbook
  - **DoD:** от заказа VPS до первого запуска; TLS; переменные; проверки после деплоя
  - **Files:** DEPLOY.md
  - **P0** · 45м

- [ ] **T22.36** — `docs/RUNBOOK.md` — типовые инциденты
  - **DoD:** «PG диск заполнен», «Redis OOM», «rate-limit провайдера», «токен просрочен» — с готовыми командами
  - **Files:** RUNBOOK.md
  - **P0** · 60м

- [ ] **T22.37** — `docs/DR.md` — Disaster Recovery
  - **DoD:** сценарии: потеря VPS, потеря БД, компрометация токенов; RPO/RTO цели; пошаговые действия
  - **Files:** DR.md
  - **P1** · 45м

**Итого:** ~37 задач, ~24ч.
