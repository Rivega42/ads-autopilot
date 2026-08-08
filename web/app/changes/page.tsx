import { ChangeLogTable } from '../../components/change-log-table';
import { FilterBar } from '../../components/filter-bar';
import { formatYmd } from '../../lib/dates';
import type { SearchParams } from '../../lib/filters';
import { parseFilters, rangeLength } from '../../lib/filters';
import { listChanges } from '../../lib/queries';

export const dynamic = 'force-dynamic';

export default async function ChangesPage({
  searchParams = {},
}: {
  readonly searchParams?: SearchParams;
}) {
  const filters = parseFilters(searchParams);
  const changes = await listChanges(filters);

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

      <section className="card">
        <ChangeLogTable rows={changes} />
      </section>
    </>
  );
}
