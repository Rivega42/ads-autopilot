import { cycleWindow } from '@/acceptance/cycle.js';

/**
 * Разбор аргументов `pnpm acceptance` — отдельно от точки входа.
 *
 * Причина та же, что у `src/cli/flags.ts`: файл в `src/apps/` запускает работу
 * прямо на импорте, и проверять разбор аргументов, импортируя его, означало бы
 * лезть в базу на каждом тесте.
 */

export const DEFAULT_DAYS = 3;

/** Как проверку зовут в дереве исходников. */
export const DEV_INVOCATION = 'pnpm acceptance';

/**
 * Как её зовут из прод-образа.
 *
 * `pnpm acceptance` там не работает и работать не может по той же причине, что и
 * `pnpm cli`: образ собран без dev-зависимостей, то есть без pnpm и без tsx, а
 * исходников в нём нет вовсе (docs/DEPLOY.md §6.1). Запускается собранный
 * `dist/apps/acceptance.js`, роль `acceptance` в `docker/entrypoint.sh`.
 *
 * Своя копия рядом с `src/cli/invocation.ts`, а не общая с ней: файл роли и сама
 * роль здесь другие, а обобщать две строки в параметризованную функцию — плодить
 * связь между командами, у которых общего только способ упаковки.
 */
export const IMAGE_INVOCATION =
  'docker compose -f docker-compose.prod.yml run --rm -e ROLE=acceptance api';

/**
 * Подсказка «как меня позвать», годная для того, кто читает вывод: выводится из
 * того, чем запущен процесс, а не из предположения о читателе.
 */
export function acceptanceInvocation(entryPath: string | undefined = process.argv[1]): string {
  if (entryPath === undefined) return DEV_INVOCATION;
  const tail = entryPath.split(/[\\/]/).slice(-3).join('/');
  return tail === 'dist/apps/acceptance.js' ? IMAGE_INVOCATION : DEV_INVOCATION;
}

export const usageLines = (invocation = acceptanceInvocation()): string[] => [
  `${invocation} [--days N] [--until YYYY-MM-DD] [--telegram]`,
  '',
  '  --days N          сколько последних полных суток проверять (по умолчанию 3)',
  '  --until <дата>    последние проверяемые сутки по МСК (по умолчанию вчера)',
  '  --telegram        продублировать вердикт в TELEGRAM_ADMIN_CHAT_ID',
  '',
  'Коды возврата: 0 — пройдено, 1 — сорвано, 2 — не хватает улик.',
  'Процедура целиком — docs/ACCEPTANCE.md',
];

export interface AcceptanceArgs {
  days: number;
  until: string | undefined;
  telegram: boolean;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): AcceptanceArgs {
  const args: AcceptanceArgs = {
    days: DEFAULT_DAYS,
    until: undefined,
    telegram: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') {
      args.help = true;
      continue;
    }
    if (flag === '--telegram') {
      args.telegram = true;
      continue;
    }
    const value = argv[i + 1];
    if (flag === '--days') {
      const days = Number(value);
      // Отвергаем на входе, а не подставляем умолчание: `--days 0` не должно
      // разворачиваться в «проверю трое суток» и печатать вердикт не о том.
      if (!Number.isInteger(days) || days < 1 || days > 31) {
        throw new Error(`--days ожидает целое от 1 до 31, получено: ${value ?? '(пусто)'}`);
      }
      args.days = days;
      i += 1;
      continue;
    }
    if (flag === '--until') {
      if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error(`--until ожидает дату вида 2026-08-21, получено: ${value ?? '(пусто)'}`);
      }
      args.until = value;
      i += 1;
      continue;
    }
    throw new Error(`Неизвестный аргумент: ${flag}`);
  }

  return args;
}

/** Окно суток: либо последние N полных, либо N суток, кончающихся на `--until`. */
export function resolveWindow(args: AcceptanceArgs, now: Date = new Date()): string[] {
  if (args.until === undefined) return cycleWindow(args.days, now);
  // Полдень МСК следующих суток: для `cycleWindow` «вчера» — это ровно `until`.
  const noonAfter = new Date(`${args.until}T09:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000;
  return cycleWindow(args.days, new Date(noonAfter));
}
