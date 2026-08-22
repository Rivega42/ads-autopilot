import { describe, expect, it } from 'vitest';

import {
  DEV_INVOCATION,
  IMAGE_INVOCATION,
  acceptanceInvocation,
  parseArgs,
  resolveWindow,
  usageLines,
} from '@/acceptance/args.js';

describe('parseArgs', () => {
  it('по умолчанию — трое суток, без Telegram', () => {
    expect(parseArgs([])).toEqual({ days: 3, until: undefined, telegram: false, help: false });
  });

  it('нулевое и отрицательное число суток отвергается, а не подменяется умолчанием', () => {
    expect(() => parseArgs(['--days', '0'])).toThrow('--days');
    expect(() => parseArgs(['--days', '-1'])).toThrow('--days');
    expect(() => parseArgs(['--days'])).toThrow('--days');
  });

  it('дата разбирается только в полном виде', () => {
    expect(parseArgs(['--until', '2026-08-21']).until).toBe('2026-08-21');
    expect(() => parseArgs(['--until', '21.08.2026'])).toThrow('--until');
  });

  it('неизвестный аргумент отвергается', () => {
    expect(() => parseArgs(['--dry-run'])).toThrow('Неизвестный аргумент');
  });
});

describe('resolveWindow', () => {
  it('без --until берёт последние полные сутки по МСК', () => {
    expect(resolveWindow(parseArgs([]), new Date('2026-08-22T05:00:00.000Z'))).toEqual([
      '2026-08-19',
      '2026-08-20',
      '2026-08-21',
    ]);
  });

  it('--until кончает окно названными сутками включительно', () => {
    expect(resolveWindow(parseArgs(['--until', '2026-08-20', '--days', '2']))).toEqual([
      '2026-08-19',
      '2026-08-20',
    ]);
  });
});

describe('acceptanceInvocation', () => {
  /**
   * Справка с `pnpm acceptance` соврала бы ровно тому, кто читает её на сервере:
   * ни pnpm, ни tsx, ни исходников в прод-образе нет. Тот же дефект уже ловили на
   * справке CLI.
   */
  it('в образе подсказывает роль compose, а не pnpm', () => {
    expect(acceptanceInvocation('/app/dist/apps/acceptance.js')).toBe(IMAGE_INVOCATION);
    expect(usageLines(acceptanceInvocation('/app/dist/apps/acceptance.js'))[0]).toContain(
      'ROLE=acceptance',
    );
  });

  it('в дереве исходников — pnpm', () => {
    expect(acceptanceInvocation('/home/user/ads-autopilot/src/apps/acceptance.ts')).toBe(
      DEV_INVOCATION,
    );
    expect(acceptanceInvocation(undefined)).toBe(DEV_INVOCATION);
  });
});
