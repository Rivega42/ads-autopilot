/**
 * Заливка аккаунта SmartSay в Яндекс Директ.
 *
 *   pnpm campaign:deploy                         холостой прогон, в Директ ничего не уходит
 *   pnpm campaign:deploy --apply --sandbox       заливка в песочницу
 *   pnpm campaign:deploy --apply --counter 123   заливка в production
 *   pnpm campaign:deploy --priority 1            только первый эшелон
 *   pnpm campaign:deploy --no-images             без загрузки картинок
 *
 * По умолчанию — холостой прогон. Реальная отправка только по явному --apply:
 * промахнуться мимо флага дороже, чем лишний раз его напечатать.
 */

import { YandexDirectClient, maskToken } from '../../clients/yandex-direct/client.js';
import {
  AuthError,
  UnitsExhaustedError,
  YandexDirectError,
  explainAuthError,
} from '../../clients/yandex-direct/errors.js';
import { DryRunTransport, deployAccount } from '../deploy.js';

import { SMARTSAY_ACCOUNT, UTM_TEMPLATE } from './blueprint.js';
import { loadCreatives } from './creative-map.js';
import { formatViolations, validateAccount } from './validate.js';

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function parsePriorities(): readonly (1 | 2 | 3)[] | undefined {
  const raw = option('priority');
  if (raw === undefined) return undefined;
  const values = raw
    .split(',')
    .map((v) => Number.parseInt(v.trim(), 10))
    .filter((v): v is 1 | 2 | 3 => v === 1 || v === 2 || v === 3);
  return values.length > 0 ? values : undefined;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const { violations } = validateAccount(SMARTSAY_ACCOUNT);
  if (violations.length > 0) {
    process.stderr.write(
      `Blueprint не проходит лимиты Директа:\n${formatViolations(violations)}\n`,
    );
    process.exit(1);
  }
  out('Валидация конфигурации: лимиты Директа пройдены');

  const apply = flag('apply');
  const sandbox = flag('sandbox');
  const priorities = parsePriorities();
  const counter = option('counter');

  const options = {
    startDate: today(),
    urlParams: UTM_TEMPLATE,
    ...(counter === undefined ? {} : { counterIds: [Number.parseInt(counter, 10)] }),
    ...(priorities === undefined ? {} : { onlyPriority: priorities }),
    ...(flag('no-images') ? {} : { imagesByCampaign: loadCreatives() }),
    log: out,
  };

  if (!apply) {
    const transport = DryRunTransport.forAccount(SMARTSAY_ACCOUNT);
    const result = await deployAccount(transport, SMARTSAY_ACCOUNT, options);
    out('');
    out(`Холостой прогон: ${result.calls.length} запросов подготовлено, ни один не отправлен.`);
    out(
      `Кампаний ${result.campaigns.length}, фраз ${result.keywordCount}, объявлений ${result.adCount}.`,
    );
    out('ID регионов в холостом прогоне — заглушки; в бою они берутся из dictionaries.get.');
    out('Запусти с --apply, чтобы залить в Директ.');
    return;
  }

  const token = process.env.YANDEX_DIRECT_TOKEN;
  if (token === undefined || token.trim() === '') {
    process.stderr.write('YANDEX_DIRECT_TOKEN не задан. См. .env.example\n');
    process.exit(1);
  }
  if (counter === undefined && !sandbox) {
    process.stderr.write(
      'Для боевой заливки укажи --counter <id счётчика Метрики>: без него автостратегии не обучатся.\n',
    );
    process.exit(1);
  }

  const client = new YandexDirectClient({ token, sandbox });
  out(`Окружение: ${sandbox ? 'песочница' : 'production'} · токен ${maskToken(token)}`);
  out('Кампании создаются остановленными — показы включаются вручную.');
  out('');

  try {
    const result = await deployAccount(client, SMARTSAY_ACCOUNT, options);
    out('');
    for (const campaign of result.campaigns) {
      out(`  ${campaign.id}  ${campaign.name}  (${campaign.groups.length} групп)`);
    }
    out('');
    out(
      `Готово: кампаний ${result.campaigns.length}, фраз ${result.keywordCount}, объявлений ${result.adCount}.`,
    );
    const units = client.units;
    if (units !== null) {
      out(`Баллы: списано ${units.spent}, осталось ${units.rest} из ${units.limit}.`);
    }
    out('Проверь объявления в интерфейсе и только потом включай показы.');
  } catch (error) {
    if (error instanceof AuthError) {
      process.stderr.write(`Доступа нет: ${explainAuthError(error.code)}\n`);
      process.exit(2);
    }
    if (error instanceof UnitsExhaustedError) {
      process.stderr.write('Суточные баллы API исчерпаны. Часть объектов могла быть создана —\n');
      process.stderr.write('перед повторным запуском сверь состояние аккаунта: pnpm yd:check\n');
      process.exit(3);
    }
    if (error instanceof YandexDirectError) {
      process.stderr.write(`Директ вернул ошибку: ${error.message}\n`);
      process.stderr.write(`RequestId: ${error.requestId ?? '—'}\n`);
      process.exit(4);
    }
    throw error;
  }
}

await main();
