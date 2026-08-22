import { ApprovalDecision, CampaignStatus, ClientStatus, Provider } from '@prisma/client';

import { compareYmd, daysBetween, isYmd, shiftYmd, todayMsk } from './dates';

export type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

/** §9.5: дашборд обязан показывать тридцать дней истории — это и есть период по умолчанию. */
export const DEFAULT_RANGE_DAYS = 30;

/** Верхняя граница периода: защита от `?from=1970-01-01` в адресной строке. */
const MAX_RANGE_DAYS = 366;

export const RANGE_PRESETS: readonly { readonly days: number; readonly label: string }[] = [
  { days: 7, label: '7 дней' },
  { days: 30, label: '30 дней' },
  { days: 90, label: '90 дней' },
];

export const PROVIDER_VALUES = Object.values(Provider) as Provider[];
export const CAMPAIGN_STATUS_VALUES = Object.values(CampaignStatus) as CampaignStatus[];
export const CLIENT_STATUS_VALUES = Object.values(ClientStatus) as ClientStatus[];
export const APPROVAL_DECISION_VALUES = Object.values(ApprovalDecision) as ApprovalDecision[];

export interface DashboardFilters {
  readonly provider: Provider | null;
  readonly status: CampaignStatus | null;
  readonly clientStatus: ClientStatus | null;
  readonly decision: ApprovalDecision | null;
  readonly clientId: string | null;
  /** `yyyy-MM-dd` по МСК, включительно с обеих сторон. */
  readonly from: string;
  readonly to: string;
}

function single(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value === undefined || value === '' ? null : value;
}

function oneOf<T extends string>(
  value: string | string[] | undefined,
  allowed: readonly T[],
): T | null {
  const raw = single(value);
  if (raw === null) return null;
  return allowed.find((candidate) => candidate === raw) ?? null;
}

export function parseFilters(params: SearchParams, now: Date = new Date()): DashboardFilters {
  const today = todayMsk(now);

  const toRaw = single(params.to);
  const to = toRaw !== null && isYmd(toRaw) && compareYmd(toRaw, today) <= 0 ? toRaw : today;

  const presetDays = Number(single(params.days) ?? Number.NaN);
  const windowDays =
    Number.isInteger(presetDays) && presetDays > 0 && presetDays <= MAX_RANGE_DAYS
      ? presetDays
      : DEFAULT_RANGE_DAYS;

  const fromRaw = single(params.from);
  const fallbackFrom = shiftYmd(to, -(windowDays - 1));
  let from = fromRaw !== null && isYmd(fromRaw) ? fromRaw : fallbackFrom;
  // Вывернутый или слишком длинный период — это ошибка в URL, а не запрос:
  // молча возвращаемся к окну по умолчанию, чтобы не ронять страницу.
  if (compareYmd(from, to) > 0 || daysBetween(from, to) > MAX_RANGE_DAYS) from = fallbackFrom;

  return {
    provider: oneOf(params.provider, PROVIDER_VALUES),
    status: oneOf(params.status, CAMPAIGN_STATUS_VALUES),
    clientStatus: oneOf(params.clientStatus, CLIENT_STATUS_VALUES),
    decision: oneOf(params.decision, APPROVAL_DECISION_VALUES),
    clientId: single(params.clientId),
    from,
    to,
  };
}

/** Сколько дней в выбранном периоде — для подписей «за N дней». */
export function rangeLength(filters: DashboardFilters): number {
  return daysBetween(filters.from, filters.to) + 1;
}

/** Ссылка с сохранением текущего среза: фильтры обязаны переживать переходы. */
export function withFilters(
  path: string,
  filters: DashboardFilters,
  overrides: Readonly<Record<string, string | null>> = {},
): string {
  const query = new URLSearchParams();
  const base: Record<string, string | null> = {
    provider: filters.provider,
    status: filters.status,
    clientStatus: filters.clientStatus,
    decision: filters.decision,
    clientId: filters.clientId,
    from: filters.from,
    to: filters.to,
  };

  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value !== null && value !== '') query.set(key, value);
  }

  const search = query.toString();
  return search === '' ? path : `${path}?${search}`;
}

/** Ссылка на пресет периода: конец — сегодня по МСК, начало — на N-1 день раньше. */
export function presetLink(
  path: string,
  filters: DashboardFilters,
  days: number,
  now: Date = new Date(),
): string {
  const to = todayMsk(now);
  return withFilters(path, filters, { from: shiftYmd(to, -(days - 1)), to });
}

export function isPresetActive(filters: DashboardFilters, days: number): boolean {
  return daysBetween(filters.from, filters.to) + 1 === days;
}
