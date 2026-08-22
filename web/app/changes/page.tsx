import { ChangeLogTable } from '../../components/change-log-table';
import { FilterBar } from '../../components/filter-bar';
import { formatYmd } from '../../lib/dates';
import type { SearchParams } from '../../lib/filters';
import { parseFilters, rangeLength } from '../../lib/filters';
import { formatInteger } from '../../lib/format';
import { listChangesView } from '../../lib/queries';

export const dynamic = 'force-dynamic';

export default async function ChangesPage({
  searchParams = {},
}: {
  readonly searchParams?: SearchParams;
}) {
  const filters = parseFilters(searchParams);
  const view = await listChangesView(filters);
  const changes = view.rows;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>История изменений</h1>
          <p className="page-sub">
            Что менялось, почему и кто подтвердил. {rangeLength(filters)} дн.:{' '}
            {formatYmd(filters.from)} — {formatYmd(filters.to)} (МСК)
          </p>
        </div>
      </div>

      <FilterBar action="/changes" filters={filters} fields={['provider']} />

      {view.truncated ? (
        <section className="notice notice-info" role="note">
          <strong>
            Показаны первые {formatInteger(changes.length)} записей из {formatInteger(view.total)}
          </strong>
          <p className="notice-text">
            История обрезана потолком витрины и показана с конца: самые старые правки за период сюда
            не попали. Сузьте период или площадку, чтобы увидеть их.
          </p>
        </section>
      ) : null}

      <section className="card">
        <ChangeLogTable rows={changes} />
      </section>
    </>
  );
}
