import type { ConversionSource } from '@prisma/client';

import type { AttributionSummary } from '../lib/attribution';
import {
  attributionHint,
  attributionLabel,
  conversionSourceHint,
  conversionSourceLabel,
  MIXED_ATTRIBUTION_HINT,
} from '../lib/attribution';
import { NO_VALUE } from '../lib/format';

export interface AttributionNoteProps {
  readonly summary: AttributionSummary;
  /** Что именно помечается: «конверсии», «CPA». */
  readonly prefix?: string;
}

/**
 * Источник конверсий подписью под числом.
 *
 * Это метаданные, а не статус, поэтому тон подписи, а не бейдж: подпись стоит
 * у каждого числа, и бейдж в каждой строке таблицы читался бы как тревога.
 * Голос повышается только в смешанном случае — там число действительно нельзя
 * брать в работу.
 *
 * `title` здесь удобство, а не единственный канал: и ярлык, и полное пояснение
 * смешанного случая (`MixedAttributionNotice`) доступны видимым текстом.
 */
export function AttributionNote({ summary, prefix = 'конверсии' }: AttributionNoteProps) {
  return (
    <span
      className={summary.mixed ? 'attribution attribution-mixed' : 'attribution'}
      title={attributionHint(summary)}
    >
      {prefix}: {attributionLabel(summary)}
    </span>
  );
}

/**
 * Почему на месте суммарного CPA стоит прочерк.
 *
 * Ставится вместо числа, а не рядом с ним: показать оба — значит дать взгляду
 * остановиться на цифре и пролистать оговорку.
 */
export function MixedCpaNote() {
  return (
    <span className="attribution attribution-mixed" title={MIXED_ATTRIBUTION_HINT}>
      смешанные источники
    </span>
  );
}

/** Источник одной строки статистики; `null` — строки за этот день нет вовсе. */
export function DailySourceCell({ source }: { readonly source: ConversionSource | null }) {
  if (source === null) return <span className="muted">{NO_VALUE}</span>;
  return <span title={conversionSourceHint(source)}>{conversionSourceLabel(source)}</span>;
}

/**
 * Видимое предупреждение о смешанной атрибуции.
 *
 * Ставится там, где показан суммарный CPA: спрятать число молча мало — читатель
 * решит, что статистика не загрузилась, и пойдёт искать цифры в кабинете вместо
 * того, чтобы выровнять окно загрузки.
 */
export function MixedAttributionNotice({ scope }: { readonly scope?: string }) {
  return (
    <section className="notice notice-serious" role="note">
      <strong>Суммарный CPA не показан: смешанные источники конверсий</strong>
      <p className="notice-text">
        {scope ? `${scope} ` : ''}
        {MIXED_ATTRIBUTION_HINT}
      </p>
    </section>
  );
}
