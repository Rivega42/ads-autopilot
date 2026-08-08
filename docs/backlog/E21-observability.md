# E21 — Observability и алертинг

**Цель:** видеть систему целиком: логи, метрики, трейсы, здоровье провайдеров, деньги. Быстрый MTTR при инцидентах, никаких «молчаливых» ошибок.

**Зависимости:** E01 (каркас), E02 (БД), E04 (бот), E16 (крон/очереди).
**DoD эпика:** дашборд с ключевыми KPI, structured-логи в JSON, метрики Prometheus, алерты в TG с классификацией severity, SLO по каждому провайдеру.

---

## Логирование

- [ ] **T21.01** — Pino как основной логгер
  - **DoD:** `src/lib/logger.ts`: pino в prod (JSON), pino-pretty в dev; уровни `trace|debug|info|warn|error|fatal`; чтение `LOG_LEVEL` из env
  - **Files:** `src/lib/logger.ts` + тест форматтера
  - **P0** · 25м

- [ ] **T21.02** — Redaction чувствительных полей
  - **DoD:** `redact: [password, token, apiKey, authorization, *.token, *.apiKey]` в pino-конфиге; тест: секрет в объекте → `[Redacted]` в выводе
  - **Files:** logger.ts + тест
  - **P0** · 20м

- [ ] **T21.03** — Correlation ID middleware
  - **DoD:** Fastify hook: генерит `x-request-id` (nanoid), кладёт в AsyncLocalStorage; логгер добавляет во все записи одного запроса
  - **Files:** `src/lib/requestContext.ts` + тест
  - **P0** · 35м

- [ ] **T21.04** — Log rotation (файлы, prod)
  - **DoD:** `pino-roll` — по 100МБ, 7 файлов; каталог `/var/log/ads-autopilot/`
  - **Files:** logger.ts + docker-compose (том)
  - **P1** · 25м

## Метрики

- [ ] **T21.05** — Prom-client в проекте
  - **DoD:** `/metrics` endpoint (Fastify plugin), default метрики Node (heap, event-loop lag)
  - **Files:** `src/routes/metrics.ts` + тест
  - **P0** · 25м

- [ ] **T21.06** — HTTP-метрики
  - **DoD:** `http_request_duration_seconds` (histogram), лейблы: `method`, `route`, `status`
  - **Files:** `src/lib/httpMetrics.ts` + тест
  - **P0** · 30м

- [ ] **T21.07** — Метрики провайдеров
  - **DoD:** `provider_request_total{provider,method,status}`, `provider_request_duration_seconds`, `provider_rate_limit_remaining{provider}`
  - **Files:** декоратор `withMetrics` в `src/lib/providerMetrics.ts` + подключение к httpClient каждого провайдера
  - **P0** · 45м

- [ ] **T21.08** — Метрики очередей
  - **DoD:** `queue_jobs_total{queue,status}`, `queue_job_duration_seconds{queue}`, `queue_backlog{queue}`
  - **Files:** hook в BullMQ через events + `src/lib/queueMetrics.ts`
  - **P0** · 40м

- [ ] **T21.09** — Бизнес-метрики
  - **DoD:** `ads_spend_daily_rub{tenant,provider}`, `ads_leads_daily{tenant,provider}`, `ads_cpa_current{tenant,provider}`, `approvals_pending{tenant}`
  - **Files:** `src/lib/businessMetrics.ts` — обновляется cron'ом (каждые 5 мин)
  - **P0** · 45м

- [ ] **T21.10** — Метрики AI-агентов
  - **DoD:** `ai_tokens_used_total{agent,model}`, `ai_cost_rub_total{agent,model}`, `ai_call_duration_seconds{agent}`, `ai_call_errors_total{agent,type}`
  - **Files:** wrapper вокруг Anthropic SDK + `src/lib/aiMetrics.ts`
  - **P0** · 40м

## Health-чеки

- [ ] **T21.11** — `/health` (liveness)
  - **DoD:** всегда 200, если процесс живой; `{status:"ok"}`
  - **Files:** `src/routes/health.ts` + тест
  - **P0** · 15м

- [ ] **T21.12** — `/ready` (readiness)
  - **DoD:** проверяет PG (SELECT 1), Redis (PING), OpenClaw gateway (доступен); возвращает 503 если хотя бы один down
  - **Files:** тот же роутер + тест
  - **P0** · 35м

- [ ] **T21.13** — `/health/providers`
  - **DoD:** для каждого настроенного провайдера — последнее время успешного вызова, rate-limit остаток, статус токена
  - **Files:** `src/routes/providerHealth.ts` + тест
  - **P1** · 45м

## Трейсинг (опционально)

- [ ] **T21.14** — OpenTelemetry SDK
  - **DoD:** auto-instrumentation для Fastify, Prisma, ioredis; экспорт в OTLP (если `OTLP_ENDPOINT` задан) или no-op
  - **Files:** `src/lib/tracing.ts` + документация в CLAUDE.md
  - **P2** · 60м

- [ ] **T21.15** — Ручные спаны для AI-агентов
  - **DoD:** `tracer.startActiveSpan('ai.call', ...)` с атрибутами `agent`, `model`, `tokens`
  - **Files:** wrapper AI SDK + тест
  - **P2** · 30м

## Алертинг

- [ ] **T21.16** — Правила алертов (YAML)
  - **DoD:** `alerts/rules.yaml`: список правил (metric expression + threshold + severity + description); загружается на старте
  - **Files:** `src/alerting/rules.ts` + `alerts/rules.yaml` (10+ дефолтных правил)
  - **P0** · 50м

- [ ] **T21.17** — Правила — предметный список
  - **DoD:** содержит: `provider_error_rate > 10% (5m)`, `queue_backlog > 500`, `ai_cost_rub_total (1h) > 500`, `spend_daily_rub > threshold*1.5`, `readiness=down > 2m`, `approvals_pending > 20`
  - **Files:** `alerts/rules.yaml`
  - **P0** · 30м

- [ ] **T21.18** — Evaluator (cron 30с)
  - **DoD:** каждые 30с — прочитать все правила, посчитать значения через prom-client registry, сравнить, если alert → `AlertService.fire()`
  - **Files:** `src/alerting/evaluator.ts` + тест
  - **P0** · 45м

- [ ] **T21.19** — `AlertService` с дедупликацией
  - **DoD:** dedup-key = ruleId; если alert уже active — не спамить (state в Redis, TTL=6ч); первый раз шлём, повтор — раз в час
  - **Files:** `src/alerting/AlertService.ts` + тест
  - **P0** · 45м

- [ ] **T21.20** — Отправка алертов в Telegram
  - **DoD:** формат: severity-emoji + название + краткое описание + ссылка на дашборд; критикал = звонок владельцу через отдельный `criticalAlertChat`
  - **Files:** `src/alerting/transports/telegram.ts` + тест
  - **P0** · 35м

- [ ] **T21.21** — Silence / mute alert
  - **DoD:** команда `/mute <ruleId> 4h` — Redis-запись, evaluator пропускает
  - **Files:** `src/bot/handlers/mute.ts` + тест
  - **P1** · 30м

## Grafana / дашборды (опционально)

- [ ] **T21.22** — JSON дашборда «Overview»
  - **DoD:** `grafana/dashboards/overview.json` — панели: RPS, error rate, queue backlog, spend/lead per tenant, AI cost
  - **Files:** JSON + README как импортировать
  - **P2** · 50м

- [ ] **T21.23** — JSON дашборда «Providers»
  - **DoD:** rate-limit, latency, error rate per provider; auth token TTL
  - **Files:** `grafana/dashboards/providers.json`
  - **P2** · 40м

- [ ] **T21.24** — Docker-compose для локального стека
  - **DoD:** Prometheus + Grafana + Alertmanager в `docker-compose.observability.yml`; профиль `--profile observability`
  - **Files:** compose + README
  - **P2** · 45м

## Инциденты

- [ ] **T21.25** — Postmortem-шаблон
  - **DoD:** `docs/incidents/TEMPLATE.md` — Impact, Timeline, Root Cause, Detection, Recovery, Action Items
  - **Files:** шаблон + запись в CONTRIBUTING.md
  - **P2** · 15м

- [ ] **T21.26** — SLO-документация
  - **DoD:** `docs/SLO.md` — по каждому провайдеру: availability, latency p95, MTTR цели
  - **Files:** SLO.md
  - **P2** · 25м

**Итого:** ~26 задач, ~14ч.
