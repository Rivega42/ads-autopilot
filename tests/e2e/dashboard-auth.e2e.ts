import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AUTH_REALM } from '../../web/lib/auth.js';
import { middleware } from '../../web/middleware.js';
// Путь до пакета явный: `next` объявлен в `web/package.json`, а pnpm не поднимает
// его в корень воркспейса — из `tests/` голый специфайр `next/server` не резолвится.
import { NextRequest } from '../../web/node_modules/next/server.js';

/**
 * Калитка перед дашбордом, собранная как в проде.
 *
 * Юнит-тесты `lib/auth.ts` проверяют разбор заголовка на строках. Здесь
 * проверяется связка целиком: настоящий `NextRequest`, настоящий `NextResponse`
 * и настоящий `process.env` — то есть ровно то место, где забытая переменная
 * открывает наружу расходы клиентов.
 */

const KEYS = ['DASHBOARD_AUTH_MODE', 'DASHBOARD_USER', 'DASHBOARD_PASSWORD'] as const;

const saved = new Map<string, string | undefined>();

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

function request(authorization?: string, path = '/clients'): NextRequest {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('authorization', authorization);
  return new NextRequest(new URL(path, 'http://dashboard.local'), { headers });
}

beforeEach(() => {
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('дашборд: калитка', () => {
  it('без пароля в окружении — 503, а не открытая витрина', async () => {
    const response = middleware(request(basic('admin', 'что-угодно')));

    expect(response.status).toBe(503);
    expect(await response.text()).toContain('DASHBOARD_PASSWORD');
    // Пустить внутрь по любому заголовку было бы худшим из исходов.
    expect(response.headers.get('x-middleware-next')).toBeNull();
  });

  it('пробелы вместо пароля — та же незаданная переменная', async () => {
    process.env['DASHBOARD_PASSWORD'] = '   ';
    const response = middleware(request(basic('admin', '   ')));

    expect(response.status).toBe(503);
  });

  it('без заголовка авторизации — 401 с приглашением браузера', async () => {
    process.env['DASHBOARD_PASSWORD'] = 'верный-пароль';
    const response = middleware(request());

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Basic realm="${AUTH_REALM}", charset="UTF-8"`,
    );
    expect(response.headers.get('content-type')).toContain('charset=utf-8');
  });

  it('верные логин и пароль — запрос идёт дальше', () => {
    process.env['DASHBOARD_PASSWORD'] = 'верный-пароль';
    const response = middleware(request(basic('admin', 'верный-пароль')));

    expect(response.status).toBe(200);
    // Так `NextResponse.next()` отличается от «страницы с кодом 200».
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('логин берётся из DASHBOARD_USER, когда он задан', () => {
    process.env['DASHBOARD_PASSWORD'] = 'верный-пароль';
    process.env['DASHBOARD_USER'] = 'roman';

    expect(middleware(request(basic('roman', 'верный-пароль'))).status).toBe(200);
    // admin перестаёт быть валидным логином, а не остаётся вторым входом.
    expect(middleware(request(basic('admin', 'верный-пароль'))).status).toBe(401);
  });

  it('неверный пароль — 401', () => {
    process.env['DASHBOARD_PASSWORD'] = 'верный-пароль';

    expect(middleware(request(basic('admin', 'неверный-пароль'))).status).toBe(401);
    // Префикс верного пароля тоже не проходит: сравнение по всей длине.
    expect(middleware(request(basic('admin', 'верный-парол'))).status).toBe(401);
    expect(middleware(request(basic('admin', ''))).status).toBe(401);
  });

  it('мусор вместо Basic-заголовка — 401, а не 500', () => {
    process.env['DASHBOARD_PASSWORD'] = 'верный-пароль';

    const garbage = [
      '',
      'Basic',
      'Basic ',
      'Bearer token',
      'Basic ***not-base64***',
      // Валидный base64, но без двоеточия внутри — это не пара логин/пароль.
      `Basic ${Buffer.from('nocolon', 'utf8').toString('base64')}`,
    ];

    for (const header of garbage) {
      expect(middleware(request(header)).status, header).toBe(401);
    }
  });

  it('пароль в UTF-8 доживает до сравнения без искажений', () => {
    // base64 от кириллицы разбирается через atob + TextDecoder — байты, а не
    // charCodeAt: латинский путь этого бы не поймал.
    process.env['DASHBOARD_PASSWORD'] = 'пароль-с-ёлкой-🎄';

    expect(middleware(request(basic('admin', 'пароль-с-ёлкой-🎄'))).status).toBe(200);
    expect(middleware(request(basic('admin', 'пароль-с-елкой-🎄'))).status).toBe(401);
  });

  it('режим proxy пропускает без заголовка: авторизацию держит Nginx', () => {
    process.env['DASHBOARD_AUTH_MODE'] = 'proxy';
    const response = middleware(request());

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('опечатка в DASHBOARD_AUTH_MODE витрину не открывает', () => {
    process.env['DASHBOARD_AUTH_MODE'] = 'proxi';
    const response = middleware(request());

    // Ни 200, ни «раз режим непонятен, пустим»: без пароля это 503.
    expect(response.status).toBe(503);
  });

  it('закрыты все страницы, а не только корень', () => {
    process.env['DASHBOARD_PASSWORD'] = 'верный-пароль';

    for (const path of [
      '/',
      '/clients',
      '/campaigns',
      '/campaigns/abc',
      '/changes',
      '/approvals',
    ]) {
      expect(middleware(request(undefined, path)).status, path).toBe(401);
    }
  });
});
