import type { ClientStatus, Provider } from '@prisma/client';

import { cliInvocation } from './invocation.js';

import { AppError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'cli:clients' });

/**
 * Кто завёл клиента. Уходит в `AuditLog` вместо умолчания `system`: клиент — корень
 * всего, что потом тратит деньги, и по журналу должно быть видно, что строку
 * создал человек командой, а не сид и не импорт.
 */
const ACTOR = 'cli:clients';

export const CLIENT_ACTIONS = ['add'] as const;
export const CLIENT_STATUSES: readonly ClientStatus[] = ['ACTIVE', 'PAUSED', 'ARCHIVED'];

export interface ClientListRow {
  id: string;
  name: string;
  status: ClientStatus;
  providers: Provider[];
  campaigns: number;
}

export interface ExistingClient {
  id: string;
  name: string;
  status: ClientStatus;
}

export interface NewClient {
  tgUserId: bigint;
  name: string;
  status: ClientStatus;
}

export interface ClientsCommandOptions {
  /** Подкоманда: пусто — список, `add` — заведение. */
  action?: string;
  name?: string;
  tgUserId?: string;
  status?: string;
  apply: boolean;
}

export interface ClientsCommandDeps {
  out?: (line: string) => void;
  list?: () => Promise<ClientListRow[]>;
  findByTgUserId?: (tgUserId: bigint) => Promise<ExistingClient | null>;
  create?: (input: NewClient) => Promise<ExistingClient>;
}

/**
 * Импорты prisma и репозитория — динамические: prisma создаёт клиент прямо на
 * импорте, а юнит-тестам команды база не нужна и негде взять.
 */
async function defaultList(): Promise<ClientListRow[]> {
  const { prisma } = await import('@/db/prisma.js');
  const rows = await prisma.client.findMany({
    select: {
      id: true,
      name: true,
      status: true,
      credentials: { select: { provider: true } },
      _count: { select: { campaigns: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    providers: row.credentials.map((c) => c.provider),
    campaigns: row._count.campaigns,
  }));
}

async function defaultFindByTgUserId(tgUserId: bigint): Promise<ExistingClient | null> {
  const { prisma } = await import('@/db/prisma.js');
  return prisma.client.findUnique({
    where: { tgUserId },
    select: { id: true, name: true, status: true },
  });
}

async function defaultCreate(input: NewClient): Promise<ExistingClient> {
  const { ClientRepository } = await import('@/repos/ClientRepository.js');
  const created = await new ClientRepository().create(input, {
    actor: ACTOR,
    reason: 'ручное заведение клиента через CLI',
  });
  return { id: created.id, name: created.name, status: created.status };
}

function requireName(raw: string | undefined): string {
  const name = (raw ?? '').trim();
  if (name === '') {
    throw new AppError(
      'Не указано имя: --name "<имя клиента>". Имя видно в отчётах и карточках апрува.',
      { code: 'CLIENT_NAME_MISSING' },
    );
  }
  return name;
}

/**
 * Разбор идентификатора Telegram.
 *
 * `BigInt`, а не `Number`: колонка в схеме — int8, и идентификаторы Telegram уже
 * подбираются к границе точности double. Ошибка округления здесь означала бы
 * клиента, которого бот никогда не опознает, — и найти это было бы нечем.
 */
function requireTgUserId(raw: string | undefined): bigint {
  const value = (raw ?? '').trim();
  if (value === '') {
    throw new AppError(
      'Не указан Telegram-аккаунт: --tg-user-id <число>. Бот опознаёт клиента только по нему.',
      { code: 'CLIENT_TG_ID_MISSING' },
    );
  }
  if (!/^\d+$/.test(value)) {
    throw new AppError(
      `«${value}» не похоже на id Telegram: нужно число, а не @username и не ссылка. ` +
        'Узнать id: клиент пишет боту, id виден в логе апдейта.',
      { code: 'CLIENT_TG_ID_INVALID', context: { raw: value } },
    );
  }
  const parsed = BigInt(value);
  if (parsed <= 0n) {
    throw new AppError(`id Telegram положителен, получено ${value}.`, {
      code: 'CLIENT_TG_ID_INVALID',
      context: { raw: value },
    });
  }
  return parsed;
}

function requireStatus(raw: string | undefined): ClientStatus {
  const value = (raw ?? '').trim().toUpperCase();
  if (value === '') return 'ACTIVE';
  const known = CLIENT_STATUSES.find((s) => s === value);
  if (!known) {
    throw new AppError(
      `Неизвестный статус «${raw ?? ''}». Известны: ${CLIENT_STATUSES.join(', ')}.`,
      { code: 'CLIENT_STATUS_UNKNOWN', context: { raw } },
    );
  }
  return known;
}

function renderRow(row: ClientListRow): string {
  const channels = row.providers.join(', ') || 'нет доступов';
  return `${row.id}  ${row.name}  [${row.status}]  кампаний: ${row.campaigns}  каналы: ${channels}`;
}

async function actionList(deps: ClientsCommandDeps, out: (line: string) => void): Promise<void> {
  const rows = await (deps.list ?? defaultList)();
  if (rows.length === 0) {
    out('Клиентов нет.');
    out(`Завести: ${cliInvocation()} clients add --name "<имя>" --tg-user-id <id> --apply`);
    return;
  }
  for (const row of rows) out(renderRow(row));
}

async function actionAdd(
  options: ClientsCommandOptions,
  deps: ClientsCommandDeps,
  out: (line: string) => void,
): Promise<void> {
  const name = requireName(options.name);
  const tgUserId = requireTgUserId(options.tgUserId);
  const status = requireStatus(options.status);

  // Проверка идёт и в черновом прогоне: узнать о занятом id только в момент
  // записи означало бы узнать о нём из ошибки уникального индекса.
  const existing = await (deps.findByTgUserId ?? defaultFindByTgUserId)(tgUserId);
  if (existing) {
    throw new AppError(
      `Telegram-аккаунт ${tgUserId} уже заведён: ${existing.id} «${existing.name}» ` +
        `[${existing.status}]. Второго клиента с тем же аккаунтом не бывает — бот опознаёт ` +
        'людей по нему, — а тихо переписать имя и статус живого клиента команда не станет.',
      { code: 'CLIENT_TG_ID_TAKEN', context: { tgUserId: tgUserId.toString(), id: existing.id } },
    );
  }

  out(`Имя:      ${name}`);
  out(`tgUserId: ${tgUserId}`);
  out(`Статус:   ${status}`);
  out(
    'tgUserId обязан совпадать с Telegram-аккаунтом клиента: иначе бот его не опознает ' +
      'и на /launch ответит «не нашёл тебя в базе».',
  );
  if (status !== 'ACTIVE') {
    // Тот же разъезд, что у credentials: загрузка, оптимизация и продление токенов
    // ходят только по ACTIVE, и клиент «впрок» выглядит рабочим, ничего не делая.
    out(
      `⚠️  Статус ${status}: крон загрузки, оптимизации и продления токенов такого клиента ` +
        'пропустит. Строка появится, работать начнёт только после ACTIVE.',
    );
  }

  if (!options.apply) {
    out('Черновой прогон: в БД ничего не записано (нужен --apply).');
    return;
  }

  const created = await (deps.create ?? defaultCreate)({ tgUserId, name, status });
  log.info({ clientId: created.id, tgUserId: tgUserId.toString(), status }, 'client created');
  out(`Заведён клиент ${created.id} — журнал: client.create.`);
  out('Дальше — доступы к кабинету:');
  out(
    `  ${cliInvocation()} credentials set --client ${created.id} ` +
      '--provider yandex_direct --apply',
  );
}

/**
 * Список клиентов и единственный путь завести нового (ТЗ §9.1).
 *
 * До этой команды строку `Client` создавал только `prisma/seed.ts`, которого нет
 * в прод-образе, и docs/RUNBOOK.md предлагал вместо процедуры ручной `insert` в
 * psql — с оговоркой, что `id` и `updatedAt` надо перечислять явно, потому что их
 * умолчания живут в Prisma, а не в схеме БД. Заведение доступов при этом упиралось
 * в «клиент должен существовать».
 */
export async function runClientsCommand(
  options: ClientsCommandOptions,
  deps: ClientsCommandDeps = {},
): Promise<void> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const action = (options.action ?? '').trim().toLowerCase();

  if (action === '') {
    await actionList(deps, out);
    return;
  }
  if (!CLIENT_ACTIONS.some((a) => a === action)) {
    throw new AppError(
      `Неизвестное действие «${options.action ?? ''}». Известны: ${CLIENT_ACTIONS.join(', ')} ` +
        '(без действия — список).',
      { code: 'CLIENT_ACTION_UNKNOWN' },
    );
  }
  await actionAdd(options, deps, out);
}

/** Строки для `printUsage` в `src/apps/cli.ts`. */
export function clientsUsageLines(): string[] {
  return [
    '  clients             список клиентов и их каналов; с действием:',
    '                        add       завести клиента (нужен --apply)',
  ];
}
