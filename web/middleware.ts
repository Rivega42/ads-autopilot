import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { AUTH_REALM, authenticate, readAuthConfig } from './lib/auth';

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

export function middleware(request: NextRequest): NextResponse {
  // Переменные читаются по одной, а не как объект: сборщик Next умеет
  // подставлять только прямые обращения вида `process.env.NAME`.
  const authConfig = readAuthConfig({
    DASHBOARD_AUTH_MODE: process.env.DASHBOARD_AUTH_MODE,
    DASHBOARD_USER: process.env.DASHBOARD_USER,
    DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD,
  });

  const outcome = authenticate(request.headers.get('authorization'), authConfig);

  if (outcome === 'ok') return NextResponse.next();

  if (outcome === 'unconfigured') {
    return new NextResponse(
      'Дашборд не настроен: задайте DASHBOARD_PASSWORD или DASHBOARD_AUTH_MODE=proxy.\n',
      { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  return new NextResponse('Требуется авторизация.\n', {
    status: 401,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'www-authenticate': `Basic realm="${AUTH_REALM}", charset="UTF-8"`,
    },
  });
}
