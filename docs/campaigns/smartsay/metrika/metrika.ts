/**
 * Яндекс.Метрика для smartsay.ru.
 *
 * Файл кладём в проект сайта как `src/analytics/metrika.ts`.
 * Это не код ads-autopilot — это то, что нужно передать разработчику сайта.
 */

declare global {
  interface Window {
    ym?: (counterId: number, action: string, ...args: unknown[]) => void;
  }
}

/** Подставить реальный ID после создания счётчика в metrika.yandex.ru. */
export const METRIKA_COUNTER_ID = 0;

export type GoalName =
  | 'form_lead'
  | 'form_lead_preschool'
  | 'form_lead_camp'
  | 'click_phone'
  | 'click_messenger'
  | 'click_email'
  | 'click_maps'
  | 'test_completed'
  | 'viewed_pricing';

function call(action: string, ...args: unknown[]): void {
  if (METRIKA_COUNTER_ID === 0) return;
  // Счётчик грузится асинхронно: до его появления вызовы просто теряются,
  // поэтому проверяем window.ym на каждом вызове, а не один раз при старте.
  window.ym?.(METRIKA_COUNTER_ID, action, ...args);
}

/** SPA не перезагружает страницу, поэтому просмотр отправляем руками на смену маршрута. */
export function trackPageView(url: string, referrer?: string): void {
  call('hit', url, referrer === undefined ? undefined : { referer: referrer });
}

export function reachGoal(goal: GoalName, params?: Record<string, unknown>): void {
  call('reachGoal', goal, params);
}

/** Параметры визита: в отчётах видно, какой язык и формат реально окупается. */
export function setVisitParams(params: Record<string, unknown>): void {
  call('params', params);
}
