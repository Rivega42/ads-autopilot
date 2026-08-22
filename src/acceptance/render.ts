import type { CheckResult, CycleVerdict, DayStatus } from '@/acceptance/cycle.js';
import { md, mdBold, mdEscape, mdJoin, type Markdown } from '@/reporter/markdown.js';

/**
 * Вывод вердикта по §9.6 — человеку в терминал и человеку в Telegram.
 *
 * Первая строка всегда договаривает исход словом, а не значком: сводка, из
 * которой «сорвано» вычитывается по отсутствию галочки, читается как «вроде
 * работает» — ровно тот способ засчитать трое суток, ради отмены которого эта
 * проверка и написана.
 */

const HEADLINE: Record<DayStatus, string> = {
  passed: 'ПРОЙДЕН',
  failed: 'СОРВАН',
  'no-data': 'НЕТ ДАННЫХ',
};

const DAY_HEADLINE: Record<DayStatus, string> = {
  passed: 'пройдены',
  failed: 'СОРВАНЫ',
  'no-data': 'не засчитаны — нет данных',
};

const MARK: Record<CheckResult['status'], string> = { pass: '✅', fail: '❌', unknown: '❓' };

export function renderCycleText(cycle: CycleVerdict): string {
  const lines: string[] = [headline(cycle)];
  if (cycle.days.length === 0) {
    lines.push(
      '',
      'Ни одних суток снять не удалось: смотри docs/ACCEPTANCE.md, раздел «Если сорвалось».',
    );
  }
  for (const day of cycle.days) {
    lines.push(
      '',
      `${MARK[markOf(day.status)]} ${humanDate(day.date)} — ${DAY_HEADLINE[day.status]}`,
    );
    for (const check of day.checks) {
      lines.push(`   ${MARK[check.status]} ${check.title}: ${check.detail}`);
    }
    for (const note of day.notes) lines.push(`   · ${note}`);
  }
  return lines.join('\n');
}

export function renderCycleMarkdown(cycle: CycleVerdict): Markdown {
  const lines: Markdown[] = [mdBold(headline(cycle))];
  for (const day of cycle.days) {
    lines.push(md``);
    lines.push(
      md`${mdEscape(MARK[markOf(day.status)])} ${mdBold(humanDate(day.date))} — ${mdEscape(DAY_HEADLINE[day.status])}`,
    );
    for (const check of day.checks) {
      lines.push(md`   ${mdEscape(`${MARK[check.status]} ${check.title}: ${check.detail}`)}`);
    }
    for (const note of day.notes) lines.push(md`   ${mdEscape(`· ${note}`)}`);
  }
  return mdJoin(lines);
}

function headline(cycle: CycleVerdict): string {
  return `ЦИКЛ ТЗ §9.6: ${HEADLINE[cycle.status]} — засчитано суток ${cycle.passed} из ${cycle.required}`;
}

function markOf(status: DayStatus): CheckResult['status'] {
  if (status === 'passed') return 'pass';
  return status === 'failed' ? 'fail' : 'unknown';
}

/** `2026-08-19` → `19.08.2026`. */
function humanDate(ymd: string): string {
  const [year, month, day] = ymd.split('-');
  return `${day}.${month}.${year}`;
}
