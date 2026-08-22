import { env } from './env.js';

/** Все отчётные периоды и крон-расписания считаются по МСК, а не по времени сервера. */
export const MSK = 'Europe/Moscow';

export const YANDEX_DIRECT_BASE_URL = env.YANDEX_DIRECT_USE_SANDBOX
  ? 'https://api-sandbox.direct.yandex.com/json/v5/'
  : 'https://api.direct.yandex.com/json/v5/';

export const VK_ADS_BASE_URL = 'https://ads.vk.ru/api/v2/';

export const METRIKA_BASE_URL = 'https://api-metrika.yandex.net/stat/v1/data';
