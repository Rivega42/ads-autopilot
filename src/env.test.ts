import { describe, expect, it } from 'vitest';

import { envSchema } from '@/env.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  CREDENTIALS_ENCRYPTION_KEY: Buffer.from('k'.repeat(32)).toString('base64'),
};

function parse(overrides: Record<string, string>) {
  return envSchema.safeParse({ ...base, ...overrides });
}

describe('DRY_RUN', () => {
  it('по умолчанию включён', () => {
    const parsed = parse({});
    expect(parsed.success && parsed.data.DRY_RUN).toBe(true);
  });

  it('пустая строка — это «не задано», а не «выключено»', () => {
    const parsed = parse({ DRY_RUN: '' });
    expect(parsed.success && parsed.data.DRY_RUN).toBe(true);
  });

  it.each(['false', 'FALSE', ' False ', '0', 'no', 'off'])('снимается значением %s', (value) => {
    const parsed = parse({ DRY_RUN: value });
    expect(parsed.success && parsed.data.DRY_RUN).toBe(false);
  });

  it.each(['true', 'TRUE', '1', 'yes', 'on'])('остаётся включённым при %s', (value) => {
    const parsed = parse({ DRY_RUN: value });
    expect(parsed.success && parsed.data.DRY_RUN).toBe(true);
  });

  it('непонятное значение роняет запуск, а не снимает защиту', () => {
    // Раньше любое неузнанное значение молча означало false: описка в .env
    // выключала предохранитель и открывала запись в кабинеты клиентов.
    const parsed = parse({ DRY_RUN: 'ложь' });
    expect(parsed.success).toBe(false);
    expect(parsed.success ? '' : parsed.error.issues[0]?.message).toContain('ожидалось true/false');
  });
});

describe('CREDENTIALS_ENCRYPTION_KEY', () => {
  const key = () => Buffer.from('k'.repeat(32)).toString('base64');

  it('без ключа запуск невозможен', () => {
    // Раньше здесь стояло значение по умолчанию из 32 нулевых байт: без переменной
    // токены всех кабинетов шифровались ключом, лежащим в открытых исходниках.
    const parsed = envSchema.safeParse({ DATABASE_URL: base.DATABASE_URL });
    expect(parsed.success).toBe(false);
  });

  it('корректный ключ принимается', () => {
    expect(parse({ CREDENTIALS_ENCRYPTION_KEY: key() }).success).toBe(true);
  });

  it('парольная фраза не выдаёт себя за ключ', () => {
    // Декодер Node молча выбрасывает недопустимые символы, и фраза из 44 знаков
    // превращается в 32 байта — проверку длины она проходила, энтропии не имея.
    const parsed = parse({
      CREDENTIALS_ENCRYPTION_KEY: 'correct-horse-battery-staple-correct-horse-!',
    });
    expect(parsed.success).toBe(false);
    expect(parsed.success ? '' : parsed.error.issues[0]?.message).toContain('base64');
  });

  it('ключ не той длины отвергается', () => {
    const short = Buffer.from('k'.repeat(16)).toString('base64');
    const parsed = parse({ CREDENTIALS_ENCRYPTION_KEY: short });
    expect(parsed.success).toBe(false);
    expect(parsed.success ? '' : parsed.error.issues[0]?.message).toContain('32 байта');
  });
});

describe('доли предохранителей', () => {
  it('порог апрува по умолчанию — 0.2, то есть 20%', () => {
    const parsed = parse({});
    expect(parsed.success && parsed.data.BUDGET_CHANGE_THRESHOLD_PCT).toBe(0.2);
  });

  it('доля читается как доля', () => {
    const parsed = parse({ BUDGET_CHANGE_THRESHOLD_PCT: '0.35' });
    expect(parsed.success && parsed.data.BUDGET_CHANGE_THRESHOLD_PCT).toBe(0.35);
  });

  it('проценты в поле доли роняют старт, а не снимают предохранитель', () => {
    // «20» по-старому означало 20%. Прочитанное как доля, оно даёт порог 2000%: апрув
    // не потребовался бы ни одному изменению ставки или бюджета, а выглядело бы это
    // как настроенный порог. Значение, читаемое двумя способами, обязано ронять старт.
    const parsed = parse({ BUDGET_CHANGE_THRESHOLD_PCT: '20' });
    expect(parsed.success).toBe(false);
    const message = parsed.success ? '' : (parsed.error.issues[0]?.message ?? '');
    expect(message).toContain('доля, а не проценты');
    expect(message).toContain('0.2');
  });

  it.each(['30', '1.5', '100'])('%s в доле — это проценты, а не доля', (value) => {
    expect(parse({ MAX_BID_CHANGE_PCT: value }).success).toBe(false);
    expect(parse({ BUDGET_CHANGE_THRESHOLD_PCT: value }).success).toBe(false);
  });

  it('ноль и отрицательное порогом не считаются', () => {
    // Порог 0 отправлял бы на апрув вообще всё, включая нулевое изменение.
    expect(parse({ BUDGET_CHANGE_THRESHOLD_PCT: '0' }).success).toBe(false);
    expect(parse({ BUDGET_CHANGE_THRESHOLD_PCT: '-0.2' }).success).toBe(false);
  });

  it('обе доли одного вида проверяются одинаково', () => {
    expect(parse({ MAX_BID_CHANGE_PCT: '0.3' }).success).toBe(true);
    expect(parse({ BUDGET_CHANGE_THRESHOLD_PCT: '0.3' }).success).toBe(true);
  });
});
