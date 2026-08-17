import { describe, expect, it } from 'vitest';

import { envSchema } from '@/env.js';

const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };

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
