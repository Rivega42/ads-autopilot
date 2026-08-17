import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Какие креативы к каким кампаниям.
 *
 * Сюжет подобран под оффер объявления: картинка повторяет то же обещание,
 * что и текст, — иначе Директ показывает связку, в которой заголовок про
 * дошкольников, а на картинке взрослый.
 */

const CREATIVES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../docs/campaigns/smartsay/creatives/out',
);

const RATIOS = ['1x1', '16x9', '3x4'] as const;

const THEME_BY_CAMPAIGN: Readonly<Record<string, string>> = {
  'SS | Поиск | Взрослые | Петергоф': 'adults',
  'SS | РСЯ | Очно | Петергоф и ЮЗ СПб': 'adults',
  'SS | Поиск | Дети и школьники | Петергоф': 'kids',
  'SS | Поиск | Дошкольники 3–6 | Петергоф': 'preschool',
  'SS | Поиск | Онлайн-школа | РФ': 'online',
  'SS | РСЯ | Онлайн | РФ': 'online',
  'SS | Поиск | Бренд': 'brand',
  'SS | Ретаргетинг | Были на сайте без заявки': 'brand',
  'SS | Поиск | Экзамены | СПб': 'adults',
  'SS | Поиск | Корпоративное обучение | СПб': 'adults',
  'SS | Поиск | Языковой лагерь и каникулы | СЗФО': 'kids',
};

export interface CreativeFile {
  readonly name: string;
  readonly base64: string;
}

export function loadCreatives(): Record<string, readonly CreativeFile[]> {
  const cache = new Map<string, CreativeFile[]>();
  const result: Record<string, readonly CreativeFile[]> = {};

  for (const [campaign, theme] of Object.entries(THEME_BY_CAMPAIGN)) {
    let files = cache.get(theme);
    if (files === undefined) {
      files = RATIOS.map((ratio) => {
        const file = `${theme}-${ratio}.jpg`;
        return { name: file, base64: readFileSync(join(CREATIVES_DIR, file)).toString('base64') };
      });
      cache.set(theme, files);
    }
    result[campaign] = files;
  }

  return result;
}
