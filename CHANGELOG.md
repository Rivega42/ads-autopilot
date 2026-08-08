# Changelog

Все значимые изменения проекта документируются здесь.

Формат основан на [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
проект следует [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added

- Milestone 1 в процессе.
- Первая реальная рекламная кампания: аккаунт Яндекс Директа для языковой
  школы SmartSay (`src/campaigns/smartsay/`, `docs/campaigns/smartsay/`).
  11 кампаний, 26 групп, 213 ключевых фраз, 114 общих минус-слов
- `src/campaigns/smartsay/limits.ts` — лимиты Яндекс Директа и валидаторы
  (заголовки, тексты, быстрые ссылки, уточнения, длина и число слов во фразе).
  Переиспользуется продуктом при генерации креативов
- `pnpm campaign:smartsay` — генерация файлов для загрузки в Директ Коммандер
  из типизированного blueprint'а
- `src/clients/yandex-direct/` — клиент Yandex Direct API v5: OAuth (неявный
  поток без секрета и обмен кода на токен), учёт баллов из заголовка `Units`,
  разбор ошибок в теле ответа при HTTP 200, ретраи с экспоненциальной паузой,
  маскирование токена в логах, поддержка песочницы

---

## [0.0.1] — 2026-08-08

### Added

- Начальный commit с ТЗ (`TZ.md`, 60 КБ, 14 разделов + приложения)
- Полное описание Full-AI архитектуры (раздел 13 ТЗ)
- Поддержка 7 рекламных каналов: Яндекс Директ, VK Реклама, TikTok Marketing,
  LinkedIn Marketing, Meta Ads, Google Ads, Telegram Ads (раздел 12 ТЗ)
- Раздел 15 ТЗ — импорт существующих кампаний (система подхватывает уже
  работающие кампании клиента и берёт управление ими)
- Оформление репо: README, CLAUDE.md, CONTRIBUTING, LICENSE, SECURITY,
  templates для issues и PRs
- CI workflow (базовый линт + typecheck + тесты)

### Infrastructure

- Приватный GitHub-репо `Rivega42/ads-autopilot`
- Default branch: `main`
- Лицензия: Proprietary

---

Ссылки:

- [Unreleased]: https://github.com/Rivega42/ads-autopilot/compare/v0.0.1...HEAD
- [0.0.1]: https://github.com/Rivega42/ads-autopilot/releases/tag/v0.0.1
