import { describe, expect, it } from 'vitest';

import { CRON_SCHEDULE, cronIntervalMinutes, QUEUE_NAMES } from './schedule.js';

const HOUR = 60;
const DAY = 24 * HOUR;

describe('cronIntervalMinutes', () => {
  it.each([
    { expression: '* * * * *', minutes: 1 },
    { expression: '*/5 * * * *', minutes: 5 },
    { expression: '*/30 * * * *', minutes: 30 },
    { expression: '0 * * * *', minutes: HOUR },
    { expression: '0,15,45 * * * *', minutes: 30 },
    { expression: '0 */4 * * *', minutes: 4 * HOUR },
  ])('расписание внутри часа: $expression → $minutes мин', ({ expression, minutes }) => {
    expect(cronIntervalMinutes(expression)).toBe(minutes);
  });

  it.each([
    { expression: '30 8 * * *', minutes: DAY },
    { expression: '0 3 * * *', minutes: DAY },
    { expression: '0 8,20 * * *', minutes: 12 * HOUR },
  ])('суточное расписание: $expression → $minutes мин', ({ expression, minutes }) => {
    // Пока здесь стоял час, потребитель суточного крона получал занижение в 24 раза:
    // глубина выборки в два «периода» покрывала два часа из суток, а всё остальное
    // время не смотрел никто.
    expect(cronIntervalMinutes(expression)).toBe(minutes);
  });

  it('недельное расписание считается по разрыву между днями недели', () => {
    expect(cronIntervalMinutes('0 10 * * 1')).toBe(7 * DAY);
    expect(cronIntervalMinutes('0 10 * * 1,4')).toBe(4 * DAY);
    // Воскресенье пишут и нулём, и семёркой — это один и тот же день.
    expect(cronIntervalMinutes('0 10 * * 0')).toBe(7 * DAY);
    expect(cronIntervalMinutes('0 10 * * 7')).toBe(7 * DAY);
  });

  it('разрыв считается по календарю, а не по длине месяца', () => {
    // `*/3` по числам месяца даёт 1,4,…,28,31: в тридцатидневном месяце от 28-го
    // до 1-го следующего проходит трое суток, и это и есть настоящий период.
    expect(cronIntervalMinutes('0 4 */3 * *')).toBe(3 * DAY);
  });

  it('расписания нет — час по соглашению', () => {
    expect(cronIntervalMinutes(null)).toBe(HOUR);
  });

  it('неразобранное выражение не выдаёт себя за точный период', () => {
    expect(cronIntervalMinutes('чепуха')).toBe(HOUR);
    expect(cronIntervalMinutes('0 8 * *')).toBe(HOUR);
    expect(cronIntervalMinutes('61 * * * *')).toBe(HOUR);
  });

  it('каждое расписание из таблицы разбирается, а не падает в запасной час', () => {
    // Запасное значение существует для мусора; расписание, которое мы написали
    // сами, обязано считаться честно — иначе занижение возвращается молча.
    const daily = cronIntervalMinutes(CRON_SCHEDULE[QUEUE_NAMES.dailyReport]);
    const weekly = cronIntervalMinutes(CRON_SCHEDULE[QUEUE_NAMES.weeklyReport]);
    expect(daily).toBe(DAY);
    expect(weekly).toBe(7 * DAY);
    expect(cronIntervalMinutes(CRON_SCHEDULE[QUEUE_NAMES.alertScan])).toBe(5);
    expect(cronIntervalMinutes(CRON_SCHEDULE[QUEUE_NAMES.checkModeration])).toBe(30);
    expect(cronIntervalMinutes(CRON_SCHEDULE[QUEUE_NAMES.fetchStats])).toBe(HOUR);
  });
});
