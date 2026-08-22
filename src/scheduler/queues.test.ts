import { describe, expect, it } from 'vitest';

import { HISTORY_DAYS, jobOptionsFor } from '@/scheduler/queues.js';
import { QUEUE_NAMES } from '@/scheduler/schedule.js';

describe('jobOptionsFor', () => {
  it('частый крон хранит неделю своих тиков, а не двести записей', () => {
    const opts = jobOptionsFor(QUEUE_NAMES.alertScan);
    // 288 тиков в сутки — за неделю больше двух тысяч; прежний потолок в 200
    // оставлял шестнадцать часов.
    expect(opts.removeOnComplete).toMatchObject({ count: 288 * HISTORY_DAYS + 2 });
  });

  it('редкий крон не опускается ниже минимума', () => {
    expect(jobOptionsFor(QUEUE_NAMES.weeklyReport).removeOnComplete).toMatchObject({ count: 50 });
    expect(jobOptionsFor(QUEUE_NAMES.dailyReport).removeOnComplete).toMatchObject({ count: 50 });
  });

  it('часовой крон считает по своему периоду', () => {
    expect(jobOptionsFor(QUEUE_NAMES.fetchStats).removeOnComplete).toMatchObject({
      count: 24 * HISTORY_DAYS + 2,
    });
  });

  it('срок хранения по времени остаётся недельным для всех', () => {
    for (const name of Object.values(QUEUE_NAMES)) {
      expect(jobOptionsFor(name).removeOnComplete).toMatchObject({
        age: HISTORY_DAYS * 24 * 3600,
      });
    }
  });
});
