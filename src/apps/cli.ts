import { parseArgs } from 'node:util';

import { backfillMetrikaConfig, clientBriefSchema } from '@/ai/onboarding/index.js';
import {
  checkCampaignEntry,
  launchCampaign,
  renderEntryBlock,
  renderPlanSummary,
  renderReadiness,
  type CampaignLaunchOptions,
} from '@/campaigns/index.js';
import { bootstrapChannels } from '@/channels/bootstrap.js';
import { registeredChannels } from '@/channels/registry.js';
import {
  cliInvocation,
  clientsUsageLines,
  needsHumanFix,
  resolveApply,
  resolveClientId,
  runClientsCommand,
  runIngestCommand,
  runOptimizeCommand,
} from '@/cli/index.js';
import { generateCreativeSetOnDemand } from '@/creatives/index.js';
import { credentialsUsageLines, runCredentialsCommand } from '@/credentials/index.js';
import { prisma } from '@/db/prisma.js';
import { AppError, describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

/**
 * Ручной прогон задач — пункты приёмки ТЗ § 9.3 («оптимизатор в --dry-run
 * показывает список рекомендаций») и § 9.1 (команда `campaign` — вход в создание
 * кампании), а заодно единственный способ проверить пайплайн на живых кабинетах,
 * не дожидаясь крона.
 */

const log = logger.child({ scope: 'cli' });

function printUsage(): void {
  const cli = cliInvocation();
  process.stdout.write(
    [
      `Использование: ${cli} <команда> [опции]`,
      '',
      'Команды:',
      '  channels            показать зарегистрированные адаптеры',
      ...clientsUsageLines(),
      ...credentialsUsageLines(),
      '  ingest              загрузить сущности и статистику из кабинетов (нужен --apply)',
      '  search-queries      загрузить поисковые запросы (нужен --apply)',
      '  campaign            проверить готовность к запуску; с --apply — собрать план',
      '                      и отправить его на апрув в Telegram',
      '  optimize            показать решения оптимизатора; с --apply — применить их',
      '  creatives           сгенерировать тексты объявлений (платно, нужен --apply)',
      '  backfill-metrika    проставить настройки Метрики из готовых брифов (нужен --apply)',
      '',
      'Опции:',
      '  --client <id>       ограничить одним клиентом',
      '  --apply             применить решения (по умолчанию — только показать)',
      '  --dry-run           только показать; вместе с --apply — ошибка',
      '  --name <имя>        clients add: имя клиента',
      '  --tg-user-id <id>   clients add: Telegram-аккаунт клиента',
      '  --status <статус>   clients add: ACTIVE (по умолчанию) | PAUSED | ARCHIVED',
      '  --segment <имя>     сегмент для creatives (по умолчанию — горячий спрос)',
      '  --new               campaign: собрать новый план, даже если кампании уже созданы',
      '  --chat <id>         campaign: куда слать карточки (по умолчанию — чат клиента)',
      '  --provider <канал>  credentials: yandex_direct | vk_ads',
      '  --help',
      '',
      'Без --apply ни одна команда ничего не пишет, не тратит деньги и не ходит',
      'в кабинеты площадок.',
      '',
      'DRY_RUN=true в окружении — предохранитель на ИЗМЕНЕНИЯ в кабинетах: он',
      'отменяет --apply у optimize. Чтение кабинетов (ingest, search-queries),',
      'запись в нашу БД (clients add, credentials set) и платные вызовы модели',
      '(creatives) он не запрещает — их сдерживает --apply.',
      '',
    ].join('\n'),
  );
}

async function cmdChannels(): Promise<void> {
  const channels = registeredChannels();
  process.stdout.write(`Зарегистрировано адаптеров: ${channels.length}\n`);
  for (const c of channels) process.stdout.write(`  • ${c}\n`);
}

/**
 * Генерация текстов объявлений вручную.
 *
 * Требует `--apply`, хотя в кабинет ничего не пишет. Причина в другом ресурсе:
 * `DRY_RUN` защищает рекламные кабинеты, но не кошелёк — генерация текстов идёт
 * в LLM по-настоящему при любом его значении. Команда, которая тратит деньги
 * просто от того, что её набрали, — ловушка; остальные команды CLI приучают,
 * что без `--apply` ничего не происходит.
 *
 * Картинки отсюда не заказываются вовсе: провайдер и форматы выбирает вызывающий,
 * а набор баннеров стоит до $0.15 — такое решение не принимают флагом по умолчанию.
 */
async function cmdCreatives(
  clientId: string | undefined,
  segmentName: string | undefined,
  apply: boolean,
) {
  if (!clientId) {
    process.stdout.write('Нужен --client <id>: сегмент генерируется под конкретный бриф.\n');
    process.exitCode = 1;
    return;
  }

  const brief = await prisma.clientBrief.findUnique({
    where: { clientId },
    select: { data: true, status: true },
  });
  if (!brief) {
    process.stdout.write(`У клиента ${clientId} нет брифа — сначала онбординг.\n`);
    process.exitCode = 1;
    return;
  }

  const parsed = clientBriefSchema.safeParse(brief.data);
  if (!parsed.success) {
    // Незавершённый бриф — не ошибка данных, а нормальное состояние на середине
    // интервью: генерировать по нему тексты бессмысленно, а не опасно.
    process.stdout.write(
      `Бриф не готов (статус ${brief.status}): ${parsed.error.issues[0]?.message ?? 'не проходит валидацию'}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const name = segmentName ?? 'Горячий спрос';

  if (!apply) {
    process.stdout.write(
      `Клиент ${clientId}, сегмент «${name}» — бриф готов, генерировать можно.\n` +
        'Запрос к модели платный и DRY_RUN его не останавливает, поэтому нужен --apply.\n',
    );
    return;
  }

  const set = await generateCreativeSetOnDemand({
    clientId,
    brief: parsed.data,
    segment: { name, intent: 'прямой коммерческий запрос' },
  });

  process.stdout.write(`Сегмент «${name}», вариантов: ${set.texts.variants.length}\n`);
  for (const v of set.texts.variants) {
    process.stdout.write(`  • ${v.title}\n    ${v.text}\n`);
  }
  for (const r of set.texts.rejected) {
    process.stdout.write(`  ✗ отклонён: ${r.reason}\n`);
  }
  for (const w of set.warnings) process.stdout.write(`  ! ${w}\n`);
  // Про dry-run здесь не пишем: строка «dryRun=true» рядом с суммой читается как
  // «денег не потрачено», а модель уже оплачена.
  process.stdout.write(`Модель оплачена: $${set.totalCostUsd.toFixed(4)}\n`);
}

/**
 * Вход в создание кампании (пункт приёмки ТЗ §9.1).
 *
 * Без `--apply` не тратится ничего: команда только сверяет бриф, доступы, бюджет
 * и гео и печатает, во что это обойдётся. С `--apply` собирается план — два платных
 * вызова модели — и на каждую кампанию плана выпускается карточка апрува.
 *
 * В кабинет отсюда не уходит ничего ни при каком флаге. Последний шаг — нажатие
 * человека в Telegram: создание кампании тратит бюджет клиента с нуля, и права
 * сделать это по одной командной строке у CLI нет (TZ §3.5).
 */
async function cmdCampaign(
  clientId: string | undefined,
  opts: { apply: boolean; fresh: boolean; chatId?: string },
): Promise<void> {
  if (!clientId) {
    process.stdout.write('Нужен --client <id>: план собирается по брифу конкретного клиента.\n');
    process.exitCode = 1;
    return;
  }

  const launchOptions: CampaignLaunchOptions = {
    fresh: opts.fresh,
    ...(opts.chatId === undefined ? {} : { chatId: opts.chatId }),
  };

  if (!opts.apply) {
    const check = await checkCampaignEntry(clientId, launchOptions);
    if (check.kind !== 'ready') {
      process.stdout.write(`${renderEntryBlock(check)}\n`);
      if (needsHumanFix(check)) process.exitCode = 1;
      return;
    }
    process.stdout.write(`${renderReadiness(check)}\n\n`);
    if (check.undelivered.length > 0) {
      // Заявки живы, а карточек в чате нет — нажать их некому, и запуск упрётся
      // в ту же недоставку. Скрипт, обходящий клиентов, обязан увидеть это кодом
      // возврата, а не строкой «готов к запуску» среди успешных.
      process.stdout.write(
        `⚠️  Карточек прошлого захода не доставлено: ${check.undelivered.length}. ` +
          'Нажать их некому — проверьте TELEGRAM_BOT_TOKEN и чат клиента ' +
          'до того, как выпускать новые.\n',
      );
    }
    process.stdout.write(
      'Ничего не сделано: команда без --apply только проверяет.\n' +
        `Собрать план и отправить карточки: ${cliInvocation()} campaign --client ` +
        `${clientId} --apply\n`,
    );
    if (needsHumanFix(check)) process.exitCode = 1;
    return;
  }

  process.stdout.write('Готовлю план — если его ещё нет, это два платных вызова модели…\n');
  const outcome = await launchCampaign(clientId, launchOptions);

  if (outcome.kind === 'not_plannable') {
    process.stdout.write(`План собрать нельзя: ${outcome.reason}\n`);
    process.exitCode = 1;
    return;
  }
  if (outcome.kind !== 'submitted') {
    process.stdout.write(`${renderEntryBlock(outcome)}\n`);
    if (outcome.kind === 'already_created') {
      process.stdout.write('Собрать новый план поверх созданных: повторить с --new\n');
    }
    if (needsHumanFix(outcome)) process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `\n${renderPlanSummary(outcome.plan, {
      dryRun: outcome.dryRun,
      only: outcome.campaignIndexes,
    })}\n`,
  );
  if (outcome.reused) {
    process.stdout.write('\nПлан взят с прошлого захода — модель не звали, денег не потрачено.\n');
  }
  process.stdout.write(
    `\nЗаявок выпущено: ${outcome.approvals.length} (план ${outcome.plan.id}).\n` +
      'Кампании создаются только после ✅ в Telegram — до нажатия в кабинете ничего нет.\n',
  );
  // Недоставленную карточку нажать нельзя, а заявка при этом создана и через
  // APPROVAL_TIMEOUT_HOURS тихо истечёт. Молчать об этом — обещать запуск,
  // которого не будет.
  const undelivered = outcome.approvals.filter((a) => a.error !== null);
  for (const approval of outcome.approvals) {
    process.stdout.write(
      approval.error === null
        ? `  • ${approval.id} → чат ${approval.chatId ?? '—'}\n`
        : `  • ${approval.id} → НЕ ДОСТАВЛЕНА: ${approval.error}\n`,
    );
  }
  if (undelivered.length > 0) {
    process.stdout.write(
      `\n⚠️  Карточек не доставлено: ${undelivered.length}. Нажать их некому — ` +
        'проверьте TELEGRAM_BOT_TOKEN и чат клиента, потом повторите команду: ' +
        'план уже собран, второй раз модель звать не придётся.\n',
    );
    process.exitCode = 1;
  }
}

async function cmdBackfillMetrika(apply: boolean): Promise<void> {
  const result = await backfillMetrikaConfig({ apply });
  const verb = apply ? 'записано' : 'будет записано';

  process.stdout.write(
    apply
      ? 'Прогон с записью в БД.\n'
      : 'Черновой прогон: в БД ничего не пишется (нужен --apply).\n',
  );
  process.stdout.write(`Просмотрено брифов: ${result.scanned}\n`);
  process.stdout.write(
    `Метрика включится (счётчик + цель), ${verb}: ${result.configured}\n` +
      `Пропущено (в брифе про Метрику ничего нет): ${result.skipped}\n`,
  );

  if (result.goalOnly.length > 0) {
    // Главная строка вывода: без счётчика загрузка конверсий не включается, и
    // «обновлено: 40» без этой оговорки читается как «Метрика заработала».
    process.stdout.write(
      `\n⚠️  Только цель, без счётчика — у ${result.goalOnly.length} клиентов.\n` +
        '   КОНВЕРСИИ ИЗ МЕТРИКИ У НИХ ПО-ПРЕЖНЕМУ НЕ ЗАГРУЖАЮТСЯ: нужен номер\n' +
        '   счётчика (Client.metrikaCounterId) — спросить у клиента и вписать руками.\n',
    );
    for (const id of result.goalOnly) process.stdout.write(`  • ${id}\n`);
  }

  if (result.ambiguous.length > 0) {
    process.stdout.write(
      `\nНеоднозначная цель у ${result.ambiguous.length} клиентов — заполнить руками:\n`,
    );
    for (const id of result.ambiguous) process.stdout.write(`  • ${id}\n`);
  }
}

/**
 * Флаги команд. Таблица одна и та же для разбора и для вывода типов: вторая
 * копия в виде интерфейса разъезжалась бы с первой на каждом новом флаге.
 */
const CLI_OPTIONS = {
  client: { type: 'string' },
  apply: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  name: { type: 'string' },
  'tg-user-id': { type: 'string' },
  status: { type: 'string' },
  segment: { type: 'string' },
  new: { type: 'boolean', default: false },
  chat: { type: 'string' },
  provider: { type: 'string' },
  help: { type: 'boolean', default: false },
} as const;

/**
 * Разбор аргументов.
 *
 * Ошибка `parseArgs` (опечатка во флаге) отдаётся человеку текстом и справкой:
 * голый `TypeError: Unknown option` не подсказывает, какие опции существуют, — а
 * именно так выглядел `--dry-run` из пункта приёмки ТЗ §9.3, пока флага не было.
 */
function parseCliArgs() {
  try {
    return parseArgs({ allowPositionals: true, options: CLI_OPTIONS });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n`);
    printUsage();
    process.exitCode = 1;
    return null;
  }
}

async function main(): Promise<void> {
  const parsed = parseCliArgs();
  if (parsed === null) return;
  const { positionals } = parsed;

  const command = positionals[0];
  if (parsed.values.help === true || !command) {
    printUsage();
    return;
  }

  // Дальше по коду читается только `values`, где `--client` уже проверен: пустая
  // строка отбивается один раз на всех, а не пятой копией рядом с четырьмя (см.
  // `resolveClientId`). Сырой `parsed.values.client` ниже не встречается нигде.
  const values = { ...parsed.values, client: resolveClientId(parsed.values.client) };

  // Разбирается до диспетчера: противоречие флагов — ошибка ввода, а не
  // особенность команды, и отвечать на неё все обязаны одинаково.
  const apply = resolveApply({ apply: values.apply, dryRun: values['dry-run'] });

  bootstrapChannels();

  switch (command) {
    case 'channels':
      await cmdChannels();
      break;
    case 'clients':
      await runClientsCommand({
        ...(positionals[1] === undefined ? {} : { action: positionals[1] }),
        ...(values.name === undefined ? {} : { name: values.name }),
        ...(values['tg-user-id'] === undefined ? {} : { tgUserId: values['tg-user-id'] }),
        ...(values.status === undefined ? {} : { status: values.status }),
        apply,
      });
      break;
    case 'ingest':
    case 'search-queries':
      if (
        await runIngestCommand({
          kind: command === 'ingest' ? 'entities' : 'search-queries',
          ...(values.client === undefined ? {} : { clientId: values.client }),
          apply,
        })
      ) {
        process.exitCode = 1;
      }
      break;
    case 'campaign':
      await cmdCampaign(values.client, {
        apply,
        fresh: values.new === true,
        ...(values.chat === undefined ? {} : { chatId: values.chat }),
      });
      break;
    case 'credentials':
      await runCredentialsCommand({
        ...(positionals[1] === undefined ? {} : { action: positionals[1] }),
        ...(values.client === undefined ? {} : { clientId: values.client }),
        ...(values.provider === undefined ? {} : { provider: values.provider }),
        apply,
      });
      break;
    case 'optimize':
      if (
        await runOptimizeCommand({
          ...(values.client === undefined ? {} : { clientId: values.client }),
          apply,
        })
      ) {
        process.exitCode = 1;
      }
      break;
    case 'creatives':
      await cmdCreatives(values.client, values.segment, apply);
      break;
    case 'backfill-metrika':
      await cmdBackfillMetrika(apply);
      break;
    default:
      process.stdout.write(`Неизвестная команда: ${command}\n\n`);
      printUsage();
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    // Ошибку ввода человек обязан прочитать: при LOG_LEVEL=silent логгер молчит,
    // и команда падала бы вообще без объяснения. Уровень предупреждения, а не
    // ошибки, — опечатка во флаге не повод будить дежурного алертом (CLAUDE.md §9).
    const known = err instanceof AppError;
    const message = known ? err.message : describeError(err);
    if (known) log.warn({ err: message }, 'cli rejected input');
    else log.error({ err: message }, 'cli failed');
    process.stderr.write(`Ошибка: ${message}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
