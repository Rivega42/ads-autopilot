import { parseArgs, resolveWindow, usageLines } from '@/acceptance/args.js';
import {
  closeCycleConnections,
  collectCycleEvidence,
  judgeCycle,
  judgeDay,
  renderCycleMarkdown,
  renderCycleText,
  type CycleVerdict,
} from '@/acceptance/index.js';
import { prisma } from '@/db/prisma.js';
import { env } from '@/env.js';
import { describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';
import { clampMarkdown, getReportMessenger } from '@/reporter/index.js';

/**
 * `pnpm acceptance` — вердикт по пункту приёмки ТЗ §9.6.
 *
 * Отдельная команда, а не крон и не страница дашборда. Крон, который сам о себе
 * отчитывается, — лишний участник в том же процессе, чью работу он проверяет:
 * упавший воркер промолчит и о своём падении тоже. Страницу открывают глазами и
 * читают «вроде зелено». Команда возвращает код возврата, поэтому её можно
 * поставить в crontab самого стенда и получать ответ в Telegram — а можно
 * запустить руками и увидеть, на чём именно держится вердикт.
 *
 * Коды возврата: 0 — пройдено, 1 — сорвано, 2 — не хватает улик. Третий код
 * отдельный намеренно: «не смог проверить» не должно молча совпадать ни с
 * «хорошо», ни с «плохо».
 */

const log = logger.child({ scope: 'acceptance' });

const EXIT_CODE = { passed: 0, failed: 1, 'no-data': 2 } as const;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usageLines().join('\n')}\n`);
    return;
  }

  const dates = resolveWindow(args);
  const evidence = await collectCycleEvidence({ dates });
  const cycle = judgeCycle(evidence.map(judgeDay), args.days);

  process.stdout.write(`${renderCycleText(cycle)}\n`);
  if (args.telegram) await deliver(cycle);

  process.exitCode = EXIT_CODE[cycle.status];
}

async function deliver(cycle: CycleVerdict): Promise<void> {
  const chatId = env.TELEGRAM_ADMIN_CHAT_ID;
  if (!chatId) {
    // Не молчим и не падаем: вердикт уже напечатан, но человек просил Telegram —
    // он должен узнать, что письма не будет.
    process.stdout.write('\nTELEGRAM_ADMIN_CHAT_ID не задан — вердикт в Telegram не ушёл.\n');
    process.exitCode = EXIT_CODE['no-data'];
    return;
  }
  try {
    await getReportMessenger().sendMarkdown(chatId, clampMarkdown(renderCycleMarkdown(cycle)));
  } catch (err) {
    process.stdout.write(`\nОтправить вердикт в Telegram не удалось: ${describeError(err)}\n`);
    process.exitCode = EXIT_CODE['no-data'];
  }
}

main()
  .catch((err) => {
    log.error({ err: describeError(err) }, 'acceptance check failed');
    process.stdout.write(`Проверку выполнить не удалось: ${describeError(err)}\n`);
    process.exitCode = EXIT_CODE['no-data'];
  })
  .finally(async () => {
    await closeCycleConnections();
    await prisma.$disconnect();
  });
