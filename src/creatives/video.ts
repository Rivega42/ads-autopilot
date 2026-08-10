import type { ImageFormatName } from './images/formats.js';

import { AppError } from '@/lib/errors.js';

/**
 * Видеокреативы (TZ §13.3) — шов, а не реализация.
 *
 * Почему не сделано сейчас, а не «забыли»:
 *
 *  • Цена. По ТЗ ролик стоит ~$0.50 из $0.70 бюджета всего набора: одна ошибка в
 *    цикле генерации сжигает больше, чем весь остальной модуль за сотню прогонов.
 *  • Непроверяемость. Пайплайн из ТЗ — text2video (Kandinsky Video / Runway) плюс
 *    озвучка (ElevenLabs / SberTTS) плюс субтитры (Whisper) — это три чужих API,
 *    ни одно из которых нельзя проверить без живого ключа и без оплаты. Написать
 *    правдоподобный, но выдуманный контракт на три API сразу — гарантированный
 *    мёртвый код, который придётся выбросить целиком.
 *  • Приоритет. Без работающего A/B-отбора видео некуда девать: система не сможет
 *    сказать, какой ролик лучше, и все деньги уйдут в вариант, выбранный наугад.
 *
 * Что нужно для реализации, по порядку:
 *  1. Ключ Kandinsky Video (`KANDINSKY_VIDEO_API_KEY` уже есть в `.env.example`) и
 *     проверенный на живом кабинете контракт запуска/опроса задачи.
 *  2. Хранилище байтов: ролик на 15 секунд — это десятки мегабайт, в `Creative.payload`
 *     они не помещаются даже теоретически. Нужен S3-совместимый бакет и ссылка в payload.
 *  3. Отдельная строка в прайс-листе `images/pricing.ts` (или свой `video/pricing.ts`)
 *     с источником цены и обязательная проверка месячного бюджета ДО запуска.
 *  4. Заливка: у VK и у Директа для видео отдельные эндпоинты, не тот же
 *     `content/static.json`, что для картинок.
 */

export interface VideoGenerationRequest {
  prompt: string;
  /** Секунды. ТЗ говорит про ролики 15–30 секунд. */
  durationSec: number;
  /** Кадрирование под площадку: сторис — вертикаль, VK-лента — квадрат. */
  format: ImageFormatName;
  /** Стартовый кадр: image2video дешевле и предсказуемее, чем text2video. */
  sourceImage?: Uint8Array;
  /** Озвучка и субтитры — отдельные оплачиваемые шаги, поэтому флагами. */
  voiceover?: boolean;
  subtitles?: boolean;
}

export interface GeneratedVideo {
  /** Ссылка в объектном хранилище, а не байты: ролик слишком велик для памяти и JSON. */
  url: string;
  durationSec: number;
  mimeType: string;
  provider: string;
  model: string;
  costUsd: number | null;
}

export interface VideoProvider {
  readonly name: string;
  readonly model: string;
  isConfigured(): boolean;
  generate(req: VideoGenerationRequest): Promise<GeneratedVideo>;
}

export class VideoNotImplementedError extends AppError {
  constructor() {
    super('Video creatives are not implemented yet (TZ §13.3)', {
      code: 'CREATIVES_VIDEO_NOT_IMPLEMENTED',
      retryable: false,
      context: { see: 'src/creatives/video.ts' },
    });
  }
}

/**
 * Заглушка, которую можно зарегистрировать вместо провайдера.
 *
 * Существует ради честного поведения вызывающего кода: он получит понятную ошибку
 * в момент вызова, а не `undefined is not a function` где-то в планировщике.
 */
export const videoProviderStub: VideoProvider = {
  name: 'not-implemented',
  model: 'none',
  isConfigured: () => false,
  generate: (): Promise<GeneratedVideo> => Promise.reject(new VideoNotImplementedError()),
};
