# ads-autopilot

> Полностью автономный AI-агент для управления рекламными кампаниями.

[![Status](https://img.shields.io/badge/status-planning-yellow)](./TZ.md)
[![License](https://img.shields.io/badge/license-Proprietary-red)](./LICENSE)
[![Node](https://img.shields.io/badge/node-22%2B-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.x-blue)](https://www.typescriptlang.org/)

---

## О проекте

**ads-autopilot** — сервис, который берёт на себя всю рутину управления рекламой в **Яндекс Директ**, **VK Реклама**, **TikTok Marketing**, **LinkedIn Marketing**, **Meta Ads**, **Google Ads** и **Telegram Ads**.

Отличие от классических рекламных инструментов (Alytics, Marilyn, K50) — **всё делает AI**, а не человек.

### Что AI делает без вас

| Задача | AI-компонент | Модель |
|---|---|---|
| Онбординг клиента | AI-Интервьюер | Claude Sonnet 4.6 |
| План кампании | AI-Стратег | Claude Opus 4.7 |
| Тексты объявлений | AI-Копирайтер | Claude Sonnet 4.6 |
| Картинки/баннеры | AI-Дизайнер | Kandinsky 3.1 / YandexART / DALL-E 3 |
| Видеоролики | AI-Видеограф | Kandinsky Video / Runway / Sora |
| Модерация | AI-Модератор | Claude Sonnet 4.6 + rulebase |
| Оптимизация ставок | AI-Оптимизатор | LightGBM + Claude Opus |
| Аналитика и отчёты | AI-Аналитик | Claude Opus 4.7 |
| Конкурентная разведка | AI-Разведчик | GPT-4o / Claude Opus + WebSearch |
| Семантическое ядро | AI-Wordstat | Claude + embeddings (bge-m3) |
| Квалификация лидов | AI-Follow-up | Claude Sonnet |

### Роль человека

Только три точки контакта:

1. **Онбординг** — 15 минут, один раз (ответить на вопросы AI-интервьюера)
2. **Апрув крупных изменений** — 2-3 мин, раз в 2-3 дня (кнопка в Telegram)
3. **Стратегический разбор** — 30 мин, раз в месяц (обсудить с AI куда двигаемся)

Всё остальное — AI.

---

## Быстрый старт

### Требования

- **Node.js** 22+
- **PostgreSQL** 16+
- **Redis** 7+
- **Docker** (для локальной разработки)
- **OpenAI/Anthropic/OpenRouter** API ключ
- Токены рекламных кабинетов (см. [TZ.md § 2](./TZ.md))

### Установка (для разработки)

```bash
git clone https://github.com/Rivega42/ads-autopilot.git
cd ads-autopilot
pnpm install
cp .env.example .env  # заполнить своими токенами
docker compose up -d postgres redis
pnpm prisma migrate dev
pnpm dev
```

Подробнее — в [docs/getting-started.md](./docs/getting-started.md) (будет добавлено на Milestone 1).

---

## Документация

- 📋 **[TZ.md](./TZ.md)** — полное техническое задание (single source of truth)
- 🤖 **[CLAUDE.md](./CLAUDE.md)** — инструкции для AI-разработчика
- 🤝 **[CONTRIBUTING.md](./CONTRIBUTING.md)** — как контрибьютить
- 📝 **[CHANGELOG.md](./CHANGELOG.md)** — история изменений
- 🔐 **[SECURITY.md](./SECURITY.md)** — политика безопасности
- 📜 **[LICENSE](./LICENSE)** — лицензия (Proprietary)

---

## Roadmap

- [x] **v0.0.1** — ТЗ и структура репо
- [ ] **Milestone 1** — Каркас проекта (TS + Fastify + Prisma + Grammy)
- [ ] **Milestone 2** — Яндекс Директ клиент (Sandbox)
- [ ] **Milestone 3** — VK Реклама клиент
- [ ] **Milestone 4** — AI-Оптимизатор (базовый)
- [ ] **Milestone 5** — Approval flow в Telegram
- [ ] **Milestone 6** — Отчёты и дашборд
- [ ] **Milestone 7** — AI-Модератор и креативы
- [ ] **Milestone 8** — Продакшн деплой
- [ ] **Milestone 9** — AI-Онбординг
- [ ] **Milestone 10** — AI-Креативы (картинки + видео)
- [ ] **Milestone 11** — AI-Модератор (advanced)
- [ ] **Milestone 12** — AI-Стратег с конкурентной разведкой
- [ ] **Milestone 13** — AI-Аналитик и weekly reports
- [ ] **Milestone 14** — TikTok / LinkedIn / Meta / Google / Telegram Ads адаптеры
- [ ] **Milestone 15** — **Импорт существующих кампаний** (см. TZ § 15)

---

## Каналы

| Канал | Статус | Приоритет | Одобрение |
|---|---|---|---|
| Яндекс Директ | 🔥 core | P0 | 1-5 дней |
| VK Реклама (ads.vk.ru) | 🔥 core | P0 | 1-3 дня |
| TikTok Marketing | 🟡 planned | P1 | 1-2 недели |
| LinkedIn Marketing | 🟡 planned | P2 | 4-16 недель |
| Meta Ads (FB/IG) | 🔴 optional | P3 | 1-4 недели |
| Google Ads | 🔴 optional | P3 | 1-3 недели |
| Telegram Ads | 🟢 partner | P4 | сразу |

---

## Автор

**Роман Гудков** — [@Rivega42](https://github.com/Rivega42)
📧 roman.v.gudkov@gmail.com

---

## Лицензия

Proprietary — All Rights Reserved © 2026 Roman Gudkov.
Использование, копирование, распространение без письменного согласия владельца запрещено.
См. [LICENSE](./LICENSE).
