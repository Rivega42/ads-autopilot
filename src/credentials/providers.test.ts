import { describe, expect, it } from 'vitest';

import { buildCredentialPayload, maskSecret, parseProvider } from './providers.js';

import { env } from '@/env.js';

const TOKEN = 'y0__xCq1234567890abcdef';

describe('parseProvider', () => {
  it('понимает и человеческое имя канала, и значение enum', () => {
    expect(parseProvider('yandex')).toBe('YANDEX_DIRECT');
    expect(parseProvider('yandex_direct')).toBe('YANDEX_DIRECT');
    expect(parseProvider(' YANDEX-DIRECT ')).toBe('YANDEX_DIRECT');
    expect(parseProvider('vk')).toBe('VK_ADS');
    expect(parseProvider('VK_ADS')).toBe('VK_ADS');
  });

  it('отказывает каналу без описанной схемы секретов, а не пишет что попало', () => {
    expect(() => parseProvider('tiktok_ads')).toThrow(/tiktok_ads/i);
    expect(() => parseProvider('')).toThrow();
  });
});

describe('maskSecret', () => {
  it('оставляет не больше последних четырёх символов', () => {
    expect(maskSecret(TOKEN)).toBe('…cdef');
    expect(maskSecret(TOKEN)).not.toContain('y0__xCq');
  });

  it('короткую строку не показывает вовсе: последние 4 — это уже вся она', () => {
    expect(maskSecret('abcd')).toBe('••••');
    expect(maskSecret('ab')).toBe('••••');
  });
});

describe('buildCredentialPayload: Яндекс Директ', () => {
  it('принимает голый токен одной строкой', () => {
    const built = buildCredentialPayload('YANDEX_DIRECT', TOKEN);
    expect(built.payload).toEqual({ accessToken: TOKEN });
  });

  it('принимает JSON с агентскими полями', () => {
    const built = buildCredentialPayload(
      'YANDEX_DIRECT',
      JSON.stringify({
        accessToken: TOKEN,
        refreshToken: '1:refresh:zzzz',
        clientLogin: 'romashka-ads',
        useOperatorUnits: true,
      }),
    );
    expect(built.payload).toEqual({
      accessToken: TOKEN,
      refreshToken: '1:refresh:zzzz',
      clientLogin: 'romashka-ads',
      useOperatorUnits: true,
    });
  });

  it('опечатка в имени поля — отказ, а не пустой секрет в базе', () => {
    // zod вырезает неизвестные ключи; без обязательного accessToken это должно
    // упасть здесь, а не через сутки на первом запросе к кабинету.
    expect(() =>
      buildCredentialPayload('YANDEX_DIRECT', JSON.stringify({ access_token: TOKEN })),
    ).toThrow(/accessToken/);
  });

  it('в описании полей нет открытого секрета, а несекретные видны целиком', () => {
    const built = buildCredentialPayload(
      'YANDEX_DIRECT',
      JSON.stringify({ accessToken: TOKEN, clientLogin: 'romashka-ads' }),
    );
    const rendered = built.fields.map((f) => `${f.name}=${f.shown}`).join(' ');
    expect(rendered).not.toContain(TOKEN);
    expect(rendered).toContain('accessToken=…cdef');
    expect(rendered).toContain('clientLogin=romashka-ads');
  });
});

describe('buildCredentialPayload: VK Реклама', () => {
  it('принимает JSON с парой client_id/secret', () => {
    const built = buildCredentialPayload(
      'VK_ADS',
      JSON.stringify({ clientId: 'vk-app-1', clientSecret: 'vk-secret-9999' }),
    );
    expect(built.payload).toEqual({ clientId: 'vk-app-1', clientSecret: 'vk-secret-9999' });
    const rendered = built.fields.map((f) => `${f.name}=${f.shown}`).join(' ');
    expect(rendered).not.toContain('vk-secret-9999');
  });

  it('голая строка для VK не годится: одного токена каналу мало', () => {
    expect(() => buildCredentialPayload('VK_ADS', 'просто-строка')).toThrow(/JSON/i);
  });

  // Пропускается там, где пара приложения задана на всю инсталляцию: тогда
  // «в JSON её нет» — не ошибка, канал возьмёт её из окружения.
  const vkAppInEnv = Boolean(env.VK_ADS_CLIENT_ID && env.VK_ADS_CLIENT_SECRET);
  it.skipIf(vkAppInEnv)('отказывает, если пары client_id/secret нет и в окружении', () => {
    // Проверку одалживаем у самого канала (readVkCredentials), чтобы «сохранилось,
    // но не работает» не было отдельным состоянием системы.
    expect(() =>
      buildCredentialPayload('VK_ADS', JSON.stringify({ agencyClientName: 'ромашка' })),
    ).toThrow();
  });
});
