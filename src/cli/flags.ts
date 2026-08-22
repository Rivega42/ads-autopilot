import { AppError } from '@/lib/errors.js';

export interface ApplyFlags {
  apply?: boolean;
  dryRun?: boolean;
}

/**
 * Один ответ на вопрос «пишем или показываем» из двух флагов.
 *
 * `--dry-run` существует потому, что так записан пункт приёмки ТЗ §9.3, и потому
 * что умолчание, которое нельзя назвать вслух, невозможно и подтвердить: скрипт,
 * которому важно ничего не тронуть, обязан иметь способ это потребовать.
 *
 * Вместе флаги означают противоположное, поэтому команда отказывается вместо
 * того, чтобы выбрать один. Тихий выбор здесь — худший из исходов: человек,
 * набравший оба, не знает, тратятся сейчас деньги клиента или нет.
 */
export function resolveApply(flags: ApplyFlags): boolean {
  const apply = flags.apply === true;
  const dryRun = flags.dryRun === true;

  if (apply && dryRun) {
    throw new AppError(
      'Флаги --apply и --dry-run означают противоположное: --apply применяет решения, ' +
        '--dry-run только показывает их. Оставьте один.',
      { code: 'CLI_FLAGS_CONFLICT' },
    );
  }
  return apply;
}
