/** Как CLI зовут в дереве исходников. */
export const DEV_INVOCATION = 'pnpm cli';

/**
 * Как CLI зовут из прод-образа.
 *
 * `pnpm cli` там не работает и работать не может: образ собран без dev-зависимостей,
 * то есть без pnpm и без tsx, а исходников в нём нет вовсе (docs/DEPLOY.md §6.1).
 */
export const IMAGE_INVOCATION =
  'docker compose -f docker-compose.prod.yml run --rm -e ROLE=cli api';

/**
 * Подсказка «как меня позвать», годная для того, кто читает вывод.
 *
 * Справка с `pnpm cli` врала ровно тому, кто читал её на сервере: он видел
 * команду, которой в образе нет. Строка выводится из того, что запущено сейчас,
 * а не из предположения о читателе.
 *
 * Неизвестная точка входа считается дев-окружением: прод-образ запускает ровно
 * один файл — `dist/apps/cli.js` (docker/entrypoint.sh, роль `cli`), — а всё
 * остальное (vitest, ts-node, импорт из другого модуля) выполняется у
 * разработчика, которому подсказка про compose ничего не объясняет.
 */
export function cliInvocation(entryPath: string | undefined = process.argv[1]): string {
  if (entryPath === undefined) return DEV_INVOCATION;
  const parts = entryPath.split(/[\\/]/).slice(-3);
  const built = parts.join('/') === 'dist/apps/cli.js';
  return built ? IMAGE_INVOCATION : DEV_INVOCATION;
}
