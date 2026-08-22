import Link from 'next/link';

import type { DashboardFilters } from '../lib/filters';
import {
  APPROVAL_DECISION_VALUES,
  CAMPAIGN_STATUS_VALUES,
  CLIENT_STATUS_VALUES,
  PROVIDER_VALUES,
  RANGE_PRESETS,
  isPresetActive,
  presetLink,
} from '../lib/filters';
import {
  approvalDecisionLabel,
  campaignStatusLabel,
  clientStatusLabel,
  providerLabel,
} from '../lib/labels';

export type FilterField = 'provider' | 'status' | 'clientStatus' | 'decision';

export interface FilterBarProps {
  readonly action: string;
  readonly filters: DashboardFilters;
  readonly fields: readonly FilterField[];
  readonly now?: Date;
}

interface SelectFieldProps {
  readonly name: string;
  readonly label: string;
  readonly value: string | null;
  readonly emptyLabel: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

function SelectField({ name, label, value, emptyLabel, options }: SelectFieldProps) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select name={name} defaultValue={value ?? ''}>
        <option value="">{emptyLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Одна строка фильтров над всем, что они ограничивают.
 *
 * Обычная GET-форма: без JS на клиенте срез живёт в адресной строке, а значит
 * его можно переслать ссылкой. Значения, которых нет среди видимых контролов,
 * едут скрытыми полями — иначе submit потерял бы их.
 */
export function FilterBar({ action, filters, fields, now }: FilterBarProps) {
  const shown = new Set(fields);

  return (
    <form className="filters" method="get" action={action}>
      {filters.clientId ? <input type="hidden" name="clientId" value={filters.clientId} /> : null}
      {!shown.has('provider') && filters.provider ? (
        <input type="hidden" name="provider" value={filters.provider} />
      ) : null}
      {!shown.has('status') && filters.status ? (
        <input type="hidden" name="status" value={filters.status} />
      ) : null}
      {!shown.has('clientStatus') && filters.clientStatus ? (
        <input type="hidden" name="clientStatus" value={filters.clientStatus} />
      ) : null}
      {!shown.has('decision') && filters.decision ? (
        <input type="hidden" name="decision" value={filters.decision} />
      ) : null}

      <div className="field">
        <span className="field-label">Период</span>
        <div className="presets">
          {RANGE_PRESETS.map((preset) => (
            <Link
              key={preset.days}
              className="preset"
              aria-current={isPresetActive(filters, preset.days)}
              href={presetLink(action, filters, preset.days, now)}
            >
              {preset.label}
            </Link>
          ))}
        </div>
      </div>

      <label className="field">
        <span className="field-label">С</span>
        <input type="date" name="from" defaultValue={filters.from} />
      </label>

      <label className="field">
        <span className="field-label">По</span>
        <input type="date" name="to" defaultValue={filters.to} />
      </label>

      {shown.has('provider') ? (
        <SelectField
          name="provider"
          label="Канал"
          value={filters.provider}
          emptyLabel="Все каналы"
          options={PROVIDER_VALUES.map((value) => ({ value, label: providerLabel(value) }))}
        />
      ) : null}

      {shown.has('status') ? (
        <SelectField
          name="status"
          label="Статус кампании"
          value={filters.status}
          emptyLabel="Любой"
          options={CAMPAIGN_STATUS_VALUES.map((value) => ({
            value,
            label: campaignStatusLabel(value),
          }))}
        />
      ) : null}

      {shown.has('clientStatus') ? (
        <SelectField
          name="clientStatus"
          label="Статус клиента"
          value={filters.clientStatus}
          emptyLabel="Любой"
          options={CLIENT_STATUS_VALUES.map((value) => ({
            value,
            label: clientStatusLabel(value),
          }))}
        />
      ) : null}

      {shown.has('decision') ? (
        <SelectField
          name="decision"
          label="Решение"
          value={filters.decision}
          emptyLabel="Ожидают"
          options={APPROVAL_DECISION_VALUES.map((value) => ({
            value,
            label: approvalDecisionLabel(value),
          }))}
        />
      ) : null}

      <button className="button" type="submit">
        Применить
      </button>

      <Link className="link-reset" href={action}>
        Сбросить
      </Link>
    </form>
  );
}
