/**
 * Хук отправки просмотров на смену маршрута.
 *
 * Файл кладём в проект сайта как `src/analytics/useMetrikaPageViews.ts`
 * и вызываем один раз внутри <BrowserRouter>, например в компоненте Layout.
 *
 *   function Layout() {
 *     useMetrikaPageViews();
 *     return <Outlet />;
 *   }
 */

import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

import { trackPageView } from './metrika';

export function useMetrikaPageViews(): void {
  const location = useLocation();
  const previous = useRef<string | null>(null);

  useEffect(() => {
    const url = `${location.pathname}${location.search}`;

    // Первый просмотр отправляет сам счётчик при инициализации.
    // Без этой проверки главная считалась бы дважды и портила отказы.
    if (previous.current === null) {
      previous.current = url;
      return;
    }
    if (previous.current === url) return;

    const referrer = `${window.location.origin}${previous.current}`;
    previous.current = url;
    trackPageView(url, referrer);
  }, [location.pathname, location.search]);
}
