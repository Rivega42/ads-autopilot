import Link from 'next/link';

import { formatMskDateTime } from '../lib/dates';
import { changeActorLabel, describeChange, providerLabel } from '../lib/labels';
import type { ChangeRow } from '../lib/queries';
import { formatJsonInline } from '../lib/serialize';

import { Badge, PlainBadge } from './badge';
import { EmptyState } from './empty-state';

export interface ChangeLogTableProps {
  readonly rows: readonly ChangeRow[];
  /** На карточке кампании колонка «Кампания» — это шум. */
  readonly showCampaign?: boolean;
}

/**
 * Журнал изменений в том виде, в каком его читает человек.
 *
 * Две вещи таблица обязана делать явно, иначе она врёт:
 *
 * 1. Незнакомое действие показывается идентификатором и помечается бейджем. Карта
 *    названий уже устаревала целиком, и молчащая подстановка сырого имени в ту же
 *    колонку, где стоят человеческие названия, скрывала это все волны подряд.
 * 2. Одно изменение ставки, выпущенное человеком, лежит в журнале двумя строками:
 *    решением («что видел человек») и канонической записью («что стало со ставкой»,
 *    её читает предохранитель). Вторая помечается как не отдельное изменение —
 *    прятать её нельзя: аудиторскую строку пишет отдельная операция, которая умеет
 *    падать, и тогда каноническая остаётся единственным следом правки.
 */
export function ChangeLogTable({ rows, showCampaign = true }: ChangeLogTableProps) {
  if (rows.length === 0) {
    return <EmptyState>За выбранный период изменений не было.</EmptyState>;
  }

  const views = rows.map((row) => ({ row, view: describeChange(row) }));
  const duplicates = views.filter((entry) => entry.view.duplicate).length;

  return (
    <>
      {/*
       * Формулировка не обещает, что парная строка решения видна рядом: на карточке
       * кампании её нет и быть не может — аудиторская строка `bid_change` пишется без
       * `campaignId` (у действия нет внешнего id кампании, см. `changeSnapshot`).
       * Обещать «показано выше» значило бы отправить человека искать несуществующее.
       */}
      {duplicates > 0 ? (
        <p className="muted table-note">
          Ставку меняли один раз:{' '}
          {duplicates === 1 ? 'одна строка ниже — ' : `${duplicates} строки ниже — `}
          запись изменения, которое человек выпустил решением, а не отдельная правка.
        </p>
      ) : null}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Когда</th>
              {showCampaign ? <th scope="col">Кампания</th> : null}
              <th scope="col">Объект</th>
              <th scope="col">Что изменилось</th>
              <th scope="col">Почему</th>
              <th scope="col">Кто</th>
            </tr>
          </thead>
          <tbody>
            {views.map(({ row, view }) => (
              <tr key={row.id} className={view.duplicate ? 'row-technical' : undefined}>
                <td>
                  {formatMskDateTime(new Date(row.appliedAt))}
                  {row.rolledBackAt ? (
                    <span className="cell-note">
                      откачено {formatMskDateTime(new Date(row.rolledBackAt))}
                    </span>
                  ) : null}
                </td>

                {showCampaign ? (
                  <td>
                    {row.campaignId ? (
                      <Link href={`/campaigns/${row.campaignId}`}>{row.campaignName ?? '—'}</Link>
                    ) : (
                      <span className="muted">—</span>
                    )}
                    {row.provider ? (
                      <span className="cell-note">{providerLabel(row.provider)}</span>
                    ) : null}
                  </td>
                ) : null}

                <td>
                  {row.entityType}
                  <span className="cell-note">{row.entityId}</span>
                </td>

                <td className="cell-wide">
                  <span
                    className={view.form === 'unknown' ? 'cell-strong cell-code' : 'cell-strong'}
                  >
                    {view.label === '' ? '—' : view.label}
                  </span>
                  {view.form === 'unknown' || view.duplicate ? (
                    <div className="badges">
                      {view.form === 'unknown' ? (
                        <Badge tone="warning">действие не описано</Badge>
                      ) : null}
                      {view.duplicate ? <PlainBadge>не отдельное изменение</PlainBadge> : null}
                    </div>
                  ) : null}
                  {view.note ? <span className="cell-note">{view.note}</span> : null}
                  <span className="cell-note">
                    {formatJsonInline(row.prevValue)} → {formatJsonInline(row.newValue)}
                  </span>
                </td>

                <td className="cell-wide">{row.reason ?? <span className="muted">—</span>}</td>

                <td>
                  <div className="badges">
                    <Badge tone={row.actor === 'AI' ? 'serious' : 'neutral'}>
                      {changeActorLabel(row.actor)}
                    </Badge>
                    {row.approvedBy ? <PlainBadge>апрув: {row.approvedBy}</PlainBadge> : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
