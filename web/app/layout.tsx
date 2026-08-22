import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { Nav } from '../components/nav';
import { countPendingApprovals } from '../lib/queries';

import './globals.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'ads-autopilot — дашборд',
  description: 'Расход, CPA и история изменений по кампаниям',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/** Счётчик в шапке не должен ронять страницу: без БД она обязана открыться и объяснить это. */
async function safePendingCount(): Promise<number> {
  try {
    return await countPendingApprovals();
  } catch (error) {
    console.error('Не удалось посчитать апрувы для шапки', error);
    return 0;
  }
}

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  const pendingApprovals = await safePendingCount();

  return (
    <html lang="ru">
      <body>
        <div className="shell">
          <header className="topbar">
            <span className="brand">
              ads-autopilot
              <span className="brand-sub">дашборд · только чтение</span>
            </span>
            <Nav pendingApprovals={pendingApprovals} />
          </header>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
