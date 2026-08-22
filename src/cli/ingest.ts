import { cliInvocation } from './invocation.js';

import type { DateRange } from '@/channels/types.js';
import type {
  IngestionFailure,
  IngestionRunSummary,
  IngestionTarget,
  SearchQueryRunSummary,
} from '@/ingestion/index.js';
import { STATS_WINDOW_DAYS, trailingWindowMsk } from '@/ingestion/window.js';

/**
 * Загрузка данных из кабинетов вручную: `ingest` и `search-queries`.
 *
 * Обе команды теперь требуют `--apply`. Раньше они не смотрели на флаги вовсе:
 * `ingest --dry-run` уходил в Директ по-настоящему, тратил баллы и писал отказы
 * строками в `ErrorLog`, пока справка обещала «--dry-run — только показать» и
 * «без --apply ни одна команда ничего не пишет и не тратит деньги».
 *
 * `DRY_RUN` этих команд не касается, и это не поблажка, а то же самое правило,
 * сказанное вслух: **`DRY_RUN` — предохранитель на изменения в кабинетах.** Не на
 * чтение из них, не на нашу БД, не на кошелёк модели (.env.example: «система
 * читает кабинеты и присылает карточки, но ничего в них не меняет»). Загрузка
 * кабинет только читает — крон `fetch-stats-hourly` делает это при `DRY_RUN=true`
 * каждый час, иначе дашборд стенда был бы пуст; запрещать то же самое руками
 * значило бы завести второе правило для той же операции. От случайного расхода
 * баллов защищает `--apply`, а не предохранитель.
 *
 * Тем же правилом объясняется разнобой, который со стороны выглядит
 * непоследовательным: `optimize --apply` при `DRY_RUN=true` отказывается — он
 * кабинет меняет; `clients add --apply` и `credentials set --apply` работают — они
 * пишут только в наши таблицы, а стенд с `DRY_RUN=true` должно быть чем настроить;
 * `creatives --apply` работает и тратит деньги на модель — до кабинета этот путь
 * не доходит вовсе, и защита у него одна: `--apply`.
 *
 * Черновой прогон здесь не «показ рекомендаций», а список кабинетов и окно дат:
 * ничего другого до похода в сеть не известно, а выдумывать содержимое отчёта
 * значило бы показать не то, что будет загружено.
 */

/** Какой из двух проходов загрузки запущен: они разные по цене и по расписанию. */
export type IngestKind = 'entities' | 'search-queries';

export interface IngestCommandOptions {
  kind: IngestKind;
  clientId?: string;
  apply: boolean;
}

export interface IngestCommandDeps {
  out?: (line: string) => void;
  /** Кабинеты, которые прогон стал бы опрашивать: без единого запроса наружу. */
  listTargets?: (clientId: string | undefined) => Promise<IngestionTarget[]>;
  window?: () => DateRange;
  ingest?: (clientId: string | undefined) => Promise<IngestionRunSummary>;
  ingestSearchQueries?: (clientId: string | undefined) => Promise<SearchQueryRunSummary>;
}

const COMMAND: Record<IngestKind, string> = {
  entities: 'ingest',
  'search-queries': 'search-queries',
};

async function defaultListTargets(clientId: string | undefined): Promise<IngestionTarget[]> {
  // Импорт внутри команды: загрузка тянет Prisma и адаптеры каналов, а `--help`
  // и `channels` обязаны отвечать мгновенно.
  const { listIngestionTargets } = await import('@/ingestion/index.js');
  return listIngestionTargets(clientId === undefined ? {} : { clientId });
}

async function defaultIngest(clientId: string | undefined): Promise<IngestionRunSummary> {
  const { runIngestion } = await import('@/ingestion/index.js');
  return runIngestion(clientId === undefined ? {} : { clientId });
}

async function defaultSearchQueries(clientId: string | undefined): Promise<SearchQueryRunSummary> {
  const { runSearchQueryIngestion } = await import('@/ingestion/index.js');
  return runSearchQueryIngestion(clientId === undefined ? {} : { clientId });
}

/** @returns нужно ли вмешательство человека — по нему ставится код возврата. */
function renderFailures(
  failures: readonly IngestionFailure[],
  out: (line: string) => void,
): boolean {
  if (failures.length === 0) return false;
  // Отказ загрузки — дыра в данных, по которым завтра поедут ставки. В скрипте,
  // обходящем клиентов, он обязан быть виден кодом возврата, а не строкой в JSON.
  out(`⚠️  Отказов: ${failures.length}. Подробности — в ErrorLog (scope ingestion:*).`);
  for (const f of failures) {
    out(`  • ${f.clientId} ${f.provider} / ${f.stage}: ${f.code} — ${f.message}`);
  }
  return true;
}

/** @returns нужно ли вмешательство человека. */
export async function runIngestCommand(
  options: IngestCommandOptions,
  deps: IngestCommandDeps = {},
): Promise<boolean> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));

  const range = (deps.window ?? (() => trailingWindowMsk(STATS_WINDOW_DAYS)))();
  out(`Окно: ${range.from} … ${range.to}`);

  if (!options.apply) {
    const targets = await (deps.listTargets ?? defaultListTargets)(options.clientId);
    out(`Кабинетов в обходе: ${targets.length}`);
    for (const target of targets) out(`  • ${target.clientId} ${target.provider}`);
    out('Черновой прогон: ни одного запроса в кабинеты, в БД ничего не записано.');
    const only = options.clientId === undefined ? '' : ` --client ${options.clientId}`;
    out(`Загрузить: ${cliInvocation()} ${COMMAND[options.kind]}${only} --apply`);
    return false;
  }

  if (options.kind === 'search-queries') {
    const summary = await (deps.ingestSearchQueries ?? defaultSearchQueries)(options.clientId);
    out(`Кабинетов в обходе: ${summary.targets}, без единого отказа: ${summary.ok}`);
    out(`Строк поисковых запросов: ${summary.written}`);
    out(`Не привязано к группе: ${summary.unattributed}`);
    return renderFailures(summary.failures, out);
  }

  const summary = await (deps.ingest ?? defaultIngest)(options.clientId);
  out(`Кабинетов в обходе: ${summary.targets}, без единого отказа: ${summary.ok}`);
  out(
    `Сущностей обновлено: ${summary.entitiesUpserted}, ` +
      `заархивировано: ${summary.entitiesArchived}`,
  );
  out(`Строк статистики: ${summary.statsWritten}`);
  out(`Конверсий из Метрики: ${summary.conversionsWritten}`);
  return renderFailures(summary.failures, out);
}
