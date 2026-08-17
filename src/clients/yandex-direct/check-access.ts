/**
 * Проверка доступа к Yandex Direct API.
 *
 * Запуск:
 *   YANDEX_DIRECT_TOKEN=... pnpm yd:check
 *   YANDEX_DIRECT_TOKEN=... pnpm yd:check --sandbox
 *
 * Токен берётся только из окружения и никуда не пишется.
 */

import { YandexDirectClient, maskToken } from './client.js';
import { AuthError, UnitsExhaustedError, YandexDirectError, explainAuthError } from './errors.js';

interface ClientInfo {
  readonly Login: string;
  readonly ClientId: number;
  readonly Currency: string;
  readonly Type: string;
}

interface ClientsGetResult {
  readonly Clients: readonly ClientInfo[];
}

interface CampaignInfo {
  readonly Id: number;
  readonly Name: string;
  readonly State: string;
  readonly Status: string;
  readonly Type: string;
}

interface CampaignsGetResult {
  readonly Campaigns?: readonly CampaignInfo[];
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const token = process.env.YANDEX_DIRECT_TOKEN;
  if (token === undefined || token.trim() === '') {
    process.stderr.write('YANDEX_DIRECT_TOKEN не задан. См. .env.example\n');
    process.exit(1);
  }

  const sandbox = process.argv.includes('--sandbox');
  const client = new YandexDirectClient({ token, sandbox });

  out(`Окружение: ${sandbox ? 'песочница' : 'production'}`);
  out(`Токен: ${maskToken(token)}`);

  try {
    const clients = await client.request<ClientsGetResult>('clients', 'get', {
      FieldNames: ['Login', 'ClientId', 'Currency', 'Type'],
    });

    for (const info of clients.Clients) {
      out(`Аккаунт: ${info.Login} (ClientId ${info.ClientId}, ${info.Currency}, ${info.Type})`);
    }

    const campaigns = await client.request<CampaignsGetResult>('campaigns', 'get', {
      SelectionCriteria: {},
      FieldNames: ['Id', 'Name', 'State', 'Status', 'Type'],
    });

    const existing = campaigns.Campaigns ?? [];
    out(`Кампаний в аккаунте: ${existing.length}`);
    for (const campaign of existing) {
      out(`  ${campaign.Id}  ${campaign.State}/${campaign.Status}  ${campaign.Name}`);
    }

    const units = client.units;
    if (units !== null) {
      out(`Баллы: списано ${units.spent}, осталось ${units.rest} из ${units.limit}`);
    }
    out('Доступ есть — можно заливать кампании.');
  } catch (error) {
    if (error instanceof AuthError) {
      process.stderr.write(`Доступа нет: ${explainAuthError(error.code)}\n`);
      process.stderr.write(`RequestId: ${error.requestId ?? '—'}\n`);
      process.exit(2);
    }
    if (error instanceof UnitsExhaustedError) {
      process.stderr.write('Суточные баллы API исчерпаны, до полуночи по Москве ждём.\n');
      process.exit(3);
    }
    if (error instanceof YandexDirectError) {
      process.stderr.write(`Директ вернул ошибку: ${error.message}\n`);
      process.exit(4);
    }
    throw error;
  }
}

await main();
