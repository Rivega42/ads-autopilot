import { describe, expect, it } from 'vitest';

import { authenticate, constantTimeEquals, decodeBasicHeader, readAuthConfig } from './auth';

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

describe('readAuthConfig', () => {
  it('без переменных режим не настроен', () => {
    expect(readAuthConfig({}).mode).toBe('unconfigured');
    expect(readAuthConfig({ DASHBOARD_PASSWORD: '   ' }).mode).toBe('unconfigured');
  });

  it('пароль включает basic с логином admin по умолчанию', () => {
    expect(readAuthConfig({ DASHBOARD_PASSWORD: 'secret' })).toEqual({
      mode: 'basic',
      user: 'admin',
      password: 'secret',
    });
  });

  it('proxy побеждает пароль: авторизацию держит reverse-proxy', () => {
    expect(readAuthConfig({ DASHBOARD_AUTH_MODE: 'proxy', DASHBOARD_PASSWORD: 'x' }).mode).toBe(
      'proxy',
    );
  });
});

describe('authenticate', () => {
  const config = readAuthConfig({ DASHBOARD_USER: 'roman', DASHBOARD_PASSWORD: 'p@ss слово' });

  it('пропускает верную пару', () => {
    expect(authenticate(basic('roman', 'p@ss слово'), config)).toBe('ok');
  });

  it('не пропускает чужой пароль и чужой логин', () => {
    expect(authenticate(basic('roman', 'другое'), config)).toBe('challenge');
    expect(authenticate(basic('vasya', 'p@ss слово'), config)).toBe('challenge');
  });

  it('без заголовка и с мусором — челлендж, а не проход', () => {
    expect(authenticate(null, config)).toBe('challenge');
    expect(authenticate('Bearer token', config)).toBe('challenge');
    expect(authenticate('Basic ????', config)).toBe('challenge');
  });

  it('ненастроенный дашборд закрыт, а не открыт', () => {
    expect(authenticate(basic('admin', ''), readAuthConfig({}))).toBe('unconfigured');
  });
});

describe('decodeBasicHeader', () => {
  it('разбирает пароль с двоеточием внутри', () => {
    expect(decodeBasicHeader(basic('user', 'a:b:c'))).toEqual({ user: 'user', password: 'a:b:c' });
  });
});

describe('constantTimeEquals', () => {
  it('сравнивает строки разной длины без исключений', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
  });
});
