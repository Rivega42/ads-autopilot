import type { ClientStatus, Provider } from '@prisma/client';

import {
  buildCredentialPayload,
  describeFields,
  describeJsonFailure,
  maskSecret,
  parseProvider,
  SUPPORTED_PROVIDERS,
  type CredentialField,
  type SupportedProvider,
} from './providers.js';
import { readSecret, SECRET_ENV_VAR, type SecretSource } from './secret-input.js';

import { cliInvocation } from '@/cli/invocation.js';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  type YandexCredentials,
} from '@/clients/yandex-direct/auth.js';
import { AppError } from '@/lib/errors.js';
import { logger } from '@/logger.js';
import type { CredentialAccess } from '@/repos/CredentialRepository.js';

const log = logger.child({ scope: 'cli:credentials' });

/**
 * Кто трогает секрет. Уходит в `AuditLog` вместо умолчания `system`: по журналу
 * должно быть видно, что это ручная команда человека, а не плановый прогон.
 */
const ACTOR = 'cli:credentials';

export const CREDENTIAL_ACTIONS = ['set', 'exchange', 'link', 'list', 'revoke'] as const;
export type CredentialsAction = (typeof CREDENTIAL_ACTIONS)[number];

export interface CredentialsCommandOptions {
  action?: string;
  clientId?: string;
  provider?: string;
  apply?: boolean;
}

export interface CredentialsClient {
  id: string;
  name: string;
  status: ClientStatus;
}

export interface StoredCredentialRow {
  provider: Provider;
  rotatedAt: Date;
  expiresAt: Date | null;
}

/**
 * Ровно та часть `CredentialRepository`, которая нужна команде. Своего пути
 * записи у команды нет и быть не может: шифрование и журнал живут в репозитории.
 */
export interface CredentialsStore {
  save(
    clientId: string,
    provider: Provider,
    payload: unknown,
    access?: CredentialAccess,
  ): Promise<unknown>;
  deactivate(clientId: string, provider: Provider, access?: CredentialAccess): Promise<void>;
  listForClient(clientId: string): Promise<StoredCredentialRow[]>;
}

export interface CredentialsCommandDeps {
  repo?: CredentialsStore;
  lookupClient?: (clientId: string) => Promise<CredentialsClient | null>;
  readSecret?: () => Promise<SecretSource>;
  exchangeCode?: (code: string, base: Partial<YandexCredentials>) => Promise<YandexCredentials>;
  authorizeUrl?: () => string;
  out?: (line: string) => void;
}

/**
 * Импорты репозитория и prisma — динамические: prisma создаёт клиент прямо на
 * импорте, а юнит-тестам команды база не нужна и негде взять.
 */
async function defaultRepo(): Promise<CredentialsStore> {
  const { CredentialRepository } = await import('@/repos/CredentialRepository.js');
  return new CredentialRepository();
}

async function defaultLookupClient(clientId: string): Promise<CredentialsClient | null> {
  const { prisma } = await import('@/db/prisma.js');
  return prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, name: true, status: true },
  });
}

function normalizeAction(raw: string | undefined): CredentialsAction {
  const action = (raw ?? '').trim().toLowerCase();
  const known = CREDENTIAL_ACTIONS.find((a) => a === action);
  if (!known) {
    throw new AppError(
      `Неизвестное действие «${raw ?? ''}». Известны: ${CREDENTIAL_ACTIONS.join(', ')}.`,
      { code: 'CREDENTIAL_ACTION_UNKNOWN' },
    );
  }
  return known;
}

function requireClientId(options: CredentialsCommandOptions): string {
  const id = options.clientId?.trim();
  if (!id) {
    throw new AppError(`Не указан клиент: --client <id> (список: ${cliInvocation()} clients).`, {
      code: 'CREDENTIAL_CLIENT_MISSING',
    });
  }
  return id;
}

function requireProvider(options: CredentialsCommandOptions): SupportedProvider {
  const raw = options.provider?.trim();
  if (!raw) {
    throw new AppError(
      `Не указан канал: --provider <${SUPPORTED_PROVIDERS.join('|').toLowerCase()}>.`,
      { code: 'CREDENTIAL_PROVIDER_MISSING' },
    );
  }
  return parseProvider(raw);
}

async function requireClient(
  clientId: string,
  deps: CredentialsCommandDeps,
): Promise<CredentialsClient> {
  const lookup = deps.lookupClient ?? defaultLookupClient;
  const client = await lookup(clientId);
  if (!client) {
    throw new AppError(
      `Клиент ${clientId} не найден. Секрет привязан к клиенту внешним ключом, ` +
        `заводить его «впрок» некуда (список: ${cliInvocation()} clients). ` +
        `Завести: ${cliInvocation()} clients add --name "<имя>" --tg-user-id <id> --apply`,
      { code: 'CREDENTIAL_CLIENT_NOT_FOUND', context: { clientId } },
    );
  }
  return client;
}

function renderFields(fields: CredentialField[]): string {
  return fields.map((f) => `${f.name}=${f.shown}`).join(', ');
}

function announceClient(client: CredentialsClient, out: (line: string) => void): void {
  out(`Клиент:   ${client.id}  «${client.name}»  [${client.status}]`);
  if (client.status !== 'ACTIVE') {
    // Загрузка и продление токенов ходят только по ACTIVE (listIngestionTargets,
    // refreshExpiringTokens). Заведённый секрет у неактивного клиента выглядит
    // рабочим и не делает ничего.
    out(
      `⚠️  Клиент в статусе ${client.status}: крон загрузки и продления токенов его ` +
        'пропустит. Секрет запишется, но работать начнёт только после ACTIVE.',
    );
  }
}

interface WriteOutcome {
  payload: Record<string, unknown>;
  fields: CredentialField[];
  reason: string;
}

/** Разбирает ввод команды `exchange`: голый код или JSON с агентскими полями. */
function parseExchangeInput(raw: string): { code: string; base: Partial<YandexCredentials> } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return { code: trimmed, base: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    // Тот же путь утечки, что и у `credentials set`: код подтверждения — тоже секрет.
    throw new AppError(describeJsonFailure(err), { code: 'CREDENTIAL_PAYLOAD_MALFORMED' });
  }
  const obj = parsed as Record<string, unknown>;
  const code = typeof obj['code'] === 'string' ? obj['code'].trim() : '';
  if (code === '') {
    throw new AppError('В JSON нет поля code с кодом подтверждения.', {
      code: 'CREDENTIAL_PAYLOAD_MALFORMED',
    });
  }
  const base: Partial<YandexCredentials> = {};
  if (typeof obj['clientLogin'] === 'string') base.clientLogin = obj['clientLogin'];
  if (typeof obj['useOperatorUnits'] === 'boolean') base.useOperatorUnits = obj['useOperatorUnits'];
  return { code, base };
}

async function actionSet(
  provider: SupportedProvider,
  apply: boolean,
  deps: CredentialsCommandDeps,
  out: (line: string) => void,
): Promise<WriteOutcome | null> {
  const read = deps.readSecret ?? (() => readSecret());
  const source = await read();
  const built = buildCredentialPayload(provider, source.value);

  out(`Источник: ${source.kind === 'env' ? SECRET_ENV_VAR : 'stdin'}`);
  out(`Поля:     ${renderFields(built.fields)}`);
  if (!apply) return null;

  return {
    payload: built.payload,
    fields: built.fields,
    reason: `ручное заведение доступов через CLI (источник секрета: ${source.kind})`,
  };
}

async function actionExchange(
  provider: SupportedProvider,
  apply: boolean,
  deps: CredentialsCommandDeps,
  out: (line: string) => void,
): Promise<WriteOutcome | null> {
  if (provider !== 'YANDEX_DIRECT') {
    throw new AppError(
      `Обмен кода подтверждения есть только у YANDEX_DIRECT. ${provider} получает токен ` +
        'по client_credentials — используйте `credentials set`.',
      { code: 'CREDENTIAL_EXCHANGE_UNSUPPORTED', context: { provider } },
    );
  }

  const read = deps.readSecret ?? (() => readSecret());
  const source = await read();
  const { code, base } = parseExchangeInput(source.value);

  out(`Источник: ${source.kind === 'env' ? SECRET_ENV_VAR : 'stdin'}`);
  out(`Код:      ${maskSecret(code)}`);
  if (!apply) {
    // Код подтверждения одноразовый: обменять его «на пробу» значит сжечь его.
    out('Черновой прогон: код НЕ обменивается — он одноразовый. Повторите с --apply.');
    return null;
  }

  const exchange = deps.exchangeCode ?? exchangeCodeForToken;
  const creds = await exchange(code, base);
  const payload = creds as unknown as Record<string, unknown>;
  const fields = describeFields(payload);
  out(`Получено: ${renderFields(fields)}`);

  return {
    payload,
    fields,
    reason: `обмен кода подтверждения через CLI (источник кода: ${source.kind})`,
  };
}

async function actionList(
  clientId: string,
  deps: CredentialsCommandDeps,
  out: (line: string) => void,
): Promise<void> {
  const repo = deps.repo ?? (await defaultRepo());
  const rows = await repo.listForClient(clientId);
  if (rows.length === 0) {
    out(
      `Доступов нет. Завести: ${cliInvocation()} credentials set --client <id> ` +
        '--provider <канал> --apply',
    );
    return;
  }
  for (const row of rows) {
    out(
      `  • ${row.provider}  обновлён: ${row.rotatedAt.toISOString()}  ` +
        `истекает: ${row.expiresAt ? row.expiresAt.toISOString() : '—'}`,
    );
  }
}

async function actionRevoke(
  clientId: string,
  provider: SupportedProvider,
  apply: boolean,
  deps: CredentialsCommandDeps,
  out: (line: string) => void,
): Promise<void> {
  if (!apply) {
    out(`Черновой прогон: доступ ${provider} НЕ отозван (нужен --apply).`);
    return;
  }
  const repo = deps.repo ?? (await defaultRepo());
  await repo.deactivate(clientId, provider, {
    actor: ACTOR,
    reason: 'ручной отзыв доступов через CLI',
  });
  log.warn({ clientId, provider }, 'credentials revoked from cli');
  out(`Отозвано: ${provider} у клиента ${clientId}. Запись в журнале: credential.revoke.`);
}

function actionLink(
  provider: SupportedProvider,
  deps: CredentialsCommandDeps,
  out: (line: string) => void,
): void {
  if (provider !== 'YANDEX_DIRECT') {
    throw new AppError(
      `Ссылка авторизации нужна только YANDEX_DIRECT. ${provider} токен по ссылке не выдаёт.`,
      { code: 'CREDENTIAL_LINK_UNSUPPORTED', context: { provider } },
    );
  }
  // `state` не передаём намеренно: он защищает callback, которого в этом пути
  // нет — код человек переносит руками, подменить его чужим редиректом некому.
  const url = (deps.authorizeUrl ?? (() => buildAuthorizeUrl()))();
  out('Отправьте клиенту ссылку, он вернёт код подтверждения:');
  out(`  ${url}`);
  out('');
  out('Код — тоже секрет и живёт минуты. Дальше:');
  out(`  ${cliInvocation()} credentials exchange --client <id> --provider yandex_direct --apply`);
}

/**
 * Единственный путь завести доступы клиента в систему (ТЗ § 9.1).
 *
 * Секрет никогда не приходит аргументом: см. JSDoc `readSecret`. Запись идёт
 * только через `CredentialRepository`, то есть зашифрованной и с записью в
 * журнал доступа. Без `--apply` команда ничего не пишет — это общий договор CLI.
 */
export async function runCredentialsCommand(
  options: CredentialsCommandOptions,
  deps: CredentialsCommandDeps = {},
): Promise<void> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const action = normalizeAction(options.action);
  const apply = options.apply === true;

  if (action === 'link') {
    actionLink(requireProvider(options), deps, out);
    return;
  }

  const clientId = requireClientId(options);

  if (action === 'list') {
    const client = await requireClient(clientId, deps);
    announceClient(client, out);
    await actionList(clientId, deps, out);
    return;
  }

  const provider = requireProvider(options);
  const client = await requireClient(clientId, deps);
  announceClient(client, out);
  out(`Канал:    ${provider}`);

  if (action === 'revoke') {
    await actionRevoke(clientId, provider, apply, deps, out);
    return;
  }

  const outcome =
    action === 'set'
      ? await actionSet(provider, apply, deps, out)
      : await actionExchange(provider, apply, deps, out);

  if (!outcome) {
    out('Черновой прогон: в БД ничего не записано (нужен --apply).');
    return;
  }

  const repo = deps.repo ?? (await defaultRepo());
  await repo.save(clientId, provider, outcome.payload, { actor: ACTOR, reason: outcome.reason });

  log.info(
    { clientId, provider, fields: outcome.fields.map((f) => `${f.name}=${f.shown}`) },
    'credentials stored from cli',
  );
  out(`Записано: ${provider} у клиента ${clientId} — AES-256-GCM, журнал: credential.save.`);
  out(`Проверить: ${cliInvocation()} ingest --client ${clientId}`);
}

/** Строки для `printUsage` в `src/apps/cli.ts`. */
export function credentialsUsageLines(): string[] {
  return [
    '  credentials         доступы клиента к кабинету; секрет только из stdin/env:',
    '                        set       записать секрет (нужен --apply)',
    '                        exchange  обменять код Яндекса на токен (нужен --apply)',
    '                        link      показать ссылку авторизации Яндекса',
    '                        list      показать заведённые каналы клиента',
    '                        revoke    отозвать доступ (нужен --apply)',
  ];
}
