import { describe, expect, it } from 'vitest';

import { CYCLE_QUEUES, QUEUE_EXPECTATIONS, expectedRunsPerDay } from '@/acceptance/spec.js';
import { CRON_SCHEDULE, QUEUE_NAMES } from '@/scheduler/schedule.js';

describe('состав суточного цикла', () => {
  it('берётся из расписания, а не из списка руками', () => {
    expect([...CYCLE_QUEUES].sort()).toEqual(
      [
        QUEUE_NAMES.fetchStats,
        QUEUE_NAMES.checkModeration,
        QUEUE_NAMES.optimizeBids,
        QUEUE_NAMES.pauseLosers,
        QUEUE_NAMES.evaluateAbTests,
        QUEUE_NAMES.dailyReport,
        QUEUE_NAMES.refreshTokens,
        QUEUE_NAMES.expireApprovals,
        QUEUE_NAMES.alertScan,
      ].sort(),
    );
  });

  it('недельный отчёт и Wordstat в суточный цикл не входят', () => {
    expect(CYCLE_QUEUES).not.toContain(QUEUE_NAMES.weeklyReport);
    expect(CYCLE_QUEUES).not.toContain(QUEUE_NAMES.wordstatMine);
  });

  it('число тиков за сутки считается из крона', () => {
    expect(expectedRunsPerDay(QUEUE_NAMES.fetchStats)).toBe(24);
    expect(expectedRunsPerDay(QUEUE_NAMES.checkModeration)).toBe(48);
    expect(expectedRunsPerDay(QUEUE_NAMES.refreshTokens)).toBe(6);
    expect(expectedRunsPerDay(QUEUE_NAMES.alertScan)).toBe(288);
    expect(expectedRunsPerDay(QUEUE_NAMES.optimizeBids)).toBe(1);
    expect(expectedRunsPerDay(QUEUE_NAMES.dailyReport)).toBe(1);
  });

  it('у каждой очереди из расписания есть запись об ожиданиях', () => {
    for (const name of Object.values(QUEUE_NAMES)) {
      expect(QUEUE_EXPECTATIONS[name]).toBeDefined();
    }
  });

  /**
   * Правка расписания обязана менять и определение цикла. Проверка стоит здесь,
   * чтобы «крон перевесили на два часа» не прошло молча мимо приёмки.
   */
  it('расписание суточных кронов не изменилось незамеченным', () => {
    expect(CRON_SCHEDULE[QUEUE_NAMES.optimizeBids]).toBe('0 8 * * *');
    expect(CRON_SCHEDULE[QUEUE_NAMES.pauseLosers]).toBe('0 3 * * *');
    expect(CRON_SCHEDULE[QUEUE_NAMES.dailyReport]).toBe('30 8 * * *');
  });
});
