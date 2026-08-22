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
import { generateCreativeSetOnDemand } from '@/creatives/index.js';
import { prisma } from '@/db/prisma.js';
import { env } from '@/env.js';
import { runIngestion, runSearchQueryIngestion } from '@/ingestion/index.js';
import { describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

/**
 * Ручной прогон задач — пункты приёмки ТЗ § 9.3 («оптимизатор в --dry-run
 * показывает список рекомендаций») и § 9.1 (команда `campaign` — вход в создание
 * кампании), а заодно единственный способ проверить пайплайн на живых кабинетах,
 * не дожидаясь крона.
 */

const log = logger.child({ scope: 'cli' });

function printUsage(): void {
  process.stdout.write(
    [
      'Использование: pnpm cli <команда> [опции]',
      '',
      'Команды:',
      '  channels            показать зарегистрированные адаптеры',
      '  clients             список клиентов и их каналов',
      '  ingest              загрузить сущности и статистику из кабинетов',
      '  search-queries      загрузить поисковые запросы',
      '  campaign            проверить готовность к запуску; с --apply — собрать план',
      '                      и отправить его на апрув в Telegram',
      '  optimize            показать решения оптимизатора',
      '  creatives           сгенерировать тексты объявлений (платно, нужен --apply)',
      '  backfill-metrika    проставить настройки Метрики из готовых брифов (нужен --apply)',
      '',
      'Опции:',
      '  --client <id>       ограничить одним клиентом',
      '  --apply             применить решения (по умолчанию — только показать)',
      '  --segment <имя>     сегмент для creatives (по умолчанию — горячий спрос)',
      '  --new               campaign: собрать новый план, даже если кампании уже созданы',
      '  --chat <id>         campaign: куда слать карточки (по умолчанию — чат клиента)',
      '  --help',
      '',
      'Без --apply ни одна команда ничего не пишет и не тратит деньги.',
      '',
    ].join('\n'),
  );
}

async function cmdChannels(): Promise<void> {
  const channels = registeredChannels();
  process.stdout.write(`Зарегистрировано адаптеров: ${channels.length}\n`);
  for (const c of channels) process.stdout.write(`  • ${c}\n`);
}

async function cmdClients(): Promise<void> {
  const clients = await prisma.client.findMany({
    select: {
      id: true,
      name: true,
      status: true,
      credentials: { select: { provider: true, expiresAt: true } },
      _count: { select: { campaigns: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (clients.length === 0) {
    process.stdout.write('Клиентов нет. Заполните базу: pnpm db:seed\n');
    return;
  }

  for (const c of clients) {
    const channels = c.credentials.map((cr) => cr.provider).join(', ') || 'нет доступов';
    process.stdout.write(
      `${c.id}  ${c.name}  [${c.status}]  кампаний: ${c._count.campaigns}  каналы: ${channels}\n`,
    );
  }
}

async function cmdIngest(clientId?: string): Promise<void> {
  const result = await runIngestion(clientId ? { clientId } : undefined);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function cmdSearchQueries(clientId?: string): Promise<void> {
  const result = await runSearchQueryIngestion(clientId ? { clientId } : undefined);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function cmdOptimize(clientId: string | undefined, apply: boolean): Promise<void> {
  // Импорт внутри команды: движок тянет Prisma и правила, а команде channels
  // это не нужно — CLI должен отвечать мгновенно.
  const { runOptimizer } = await import('@/optimizer/index.js');

  const campaigns = await prisma.campaign.findMany({
    where: clientId ? { clientId } : {},
    select: { id: true, name: true, clientId: true },
  });

  if (campaigns.length === 0) {
    process.stdout.write('Кампаний нет. Сначала выполните: pnpm cli ingest\n');
    return;
  }

  // apply просят явно, но глобальный DRY_RUN всё равно старше: снять защиту
  // можно только в двух местах сразу.
  const dryRun = !apply || env.DRY_RUN;
  if (apply && env.DRY_RUN) {
    process.stdout.write('⚠️  --apply проигнорирован: DRY_RUN=true в окружении\n\n');
  }

  let total = 0;
  const skipped: Record<string, number> = {};

  for (const campaign of campaigns) {
    const run = await runOptimizer(prisma, {
      campaignId: campaign.id,
      dryRun,
      searchQueries: await loadSearchQueries(campaign.id),
    });

    if (run.skipped) {
      skipped[run.skipped] = (skipped[run.skipped] ?? 0) + 1;
      continue;
    }

    const decisions = [...run.autoApply, ...run.approvals.flatMap((a) => a.decisions)];
    if (decisions.length === 0) continue;

    total += decisions.length;
    process.stdout.write(`\n▸ ${campaign.name} (${campaign.id})\n`);

    for (const d of run.autoApply) {
      process.stdout.write(`  [авто]  ${d.action}: ${d.reason}\n`);
    }
    for (const a of run.approvals) {
      process.stdout.write(`  [апрув ${a.kind}] ${a.summary}\n`);
    }
    // Отклонённые важнее показать, чем скрыть: чаще всего это «данных мало»,
    // и без этой строки непонятно, почему рекомендаций нет.
    for (const r of run.rejected) {
      process.stdout.write(`  [отклонено ${r.rail}] ${r.decision.action} — ${r.note}\n`);
    }
    for (const c of run.clamped) {
      process.stdout.write(`  [ужато ${c.rail}] ${c.decision.action} — ${c.note}\n`);
    }
  }

  for (const [reason, count] of Object.entries(skipped)) {
    process.stdout.write(`Пропущено кампаний (${reason}): ${count}\n`);
  }

  process.stdout.write(
    total === 0
      ? '\nРекомендаций нет — либо данных мало, либо всё в пределах целей.\n'
      : `\nВсего решений: ${total}${dryRun ? ' (ничего не применено)' : ''}\n`,
  );
}

/** Сырьё для правила минус-слов. Окно то же, что у оптимизатора по умолчанию. */
async function loadSearchQueries(campaignId: string) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await prisma.searchQueryStat.findMany({
    where: { adGroup: { campaignId }, date: { gte: since }, negated: false },
    select: {
      adGroupId: true,
      query: true,
      impressions: true,
      clicks: true,
      spend: true,
      conversions: true,
      date: true,
    },
  });

  // Строки лежат по дням, а правило смотрит на агрегат за окно.
  const byKey = new Map<string, ReturnType<typeof emptyAggregate>>();
  for (const row of rows) {
    const key = `${row.adGroupId}\u0000${row.query}`;
    const agg = byKey.get(key) ?? emptyAggregate(row.adGroupId, row.query);
    agg.impressions += row.impressions;
    agg.clicks += row.clicks;
    agg.spend += Number(row.spend);
    agg.conversions += row.conversions;
    agg.days += 1;
    byKey.set(key, agg);
  }
  return [...byKey.values()];
}

function emptyAggregate(adGroupId: string, query: string) {
  return { adGroupId, query, impressions: 0, clicks: 0, spend: 0, conversions: 0, days: 0 };
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
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${renderReadiness(check)}\n\n`);
    process.stdout.write(
      'Ничего не сделано: команда без --apply только проверяет.\n' +
        'Собрать план и отправить карточки: pnpm cli campaign --client ' +
        `${clientId} --apply\n`,
    );
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
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`\n${renderPlanSummary(outcome.plan, { dryRun: outcome.dryRun })}\n`);
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

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      client: { type: 'string' },
      apply: { type: 'boolean', default: false },
      segment: { type: 'string' },
      new: { type: 'boolean', default: false },
      chat: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });

  const command = positionals[0];
  if (values.help || !command) {
    printUsage();
    return;
  }

  bootstrapChannels();

  switch (command) {
    case 'channels':
      await cmdChannels();
      break;
    case 'clients':
      await cmdClients();
      break;
    case 'ingest':
      await cmdIngest(values.client);
      break;
    case 'search-queries':
      await cmdSearchQueries(values.client);
      break;
    case 'campaign':
      await cmdCampaign(values.client, {
        apply: values.apply,
        fresh: values.new,
        ...(values.chat === undefined ? {} : { chatId: values.chat }),
      });
      break;
    case 'optimize':
      await cmdOptimize(values.client, values.apply);
      break;
    case 'creatives':
      await cmdCreatives(values.client, values.segment, values.apply);
      break;
    case 'backfill-metrika':
      await cmdBackfillMetrika(values.apply);
      break;
    default:
      process.stdout.write(`Неизвестная команда: ${command}\n\n`);
      printUsage();
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    log.error({ err: describeError(err) }, 'cli failed');
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
