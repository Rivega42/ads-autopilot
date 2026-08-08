import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AppError } from '@/lib/errors.js';

/**
 * Загрузчик промптов (CLAUDE.md §8).
 *
 * Промпт — это отдельный `.md` файл, а не строка в TypeScript: его правит человек,
 * его читают в диффе, его версию видно рядом с текстом. Модуль умеет ровно три вещи:
 * найти файл, подставить переменные и громко упасть, если что-то не сошлось.
 *
 * Почему «громко»: незамещённый `{{brief}}`, доехавший до модели, не ломает вызов —
 * модель уверенно ответит на плейсхолдер, и ошибка всплывёт через неделю в виде
 * странного брифа. Поэтому любое расхождение шаблона и переданных переменных — throw.
 */

/**
 * Версии промптов. Единственный источник правды: имя файла проверяется компилятором,
 * версия — обычная строка, которую бампает тот, кто правит текст.
 *
 * Правило из CLAUDE.md §8: прежде чем менять промпт — записать baseline evals.
 * Смена версии без нового baseline означает, что регрессию не с чем сравнивать.
 */
export const PROMPT_VERSION = {
  'onboarding-interview': '1.0.0',
  'onboarding-eval-persona': '1.0.0',
  'campaign-structure': '1.0.0',
  'campaign-texts': '1.0.0',
} as const;

export type PromptName = keyof typeof PROMPT_VERSION;

export type PromptVars = Readonly<Record<string, string | number>>;

export interface LoadedPrompt {
  name: PromptName;
  version: string;
  /**
   * Готовый текст с подставленными переменными. Первой строкой — комментарий с
   * именем и версией промпта: `runAgent` кладёт system целиком в `AiRun.input`,
   * так что по строке журнала видно, каким текстом получен результат.
   */
  text: string;
}

export class PromptError extends AppError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, { code: 'PROMPT_ERROR', context });
  }
}

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

const rawCache = new Map<PromptName, string>();

/**
 * Где искать `*.md`. Порядок важен: сначала рядом с модулем (dev через tsx и prod,
 * если сборка скопировала файлы), затем исходники относительно `dist/` и от корня
 * репозитория — `tsc` markdown не копирует, и без этих запасных путей прод-сборка
 * падала бы на первом же вызове агента.
 */
function candidateDirs(): string[] {
  return [
    fileURLToPath(new URL('./prompts/', import.meta.url)),
    fileURLToPath(new URL('../../src/ai/prompts/', import.meta.url)),
    resolve(process.cwd(), 'src/ai/prompts'),
  ];
}

function readPromptFile(name: PromptName): string {
  const cached = rawCache.get(name);
  if (cached !== undefined) return cached;

  const tried: string[] = [];
  for (const dir of candidateDirs()) {
    const path = join(dir, `${name}.md`);
    tried.push(path);
    try {
      const text = readFileSync(path, 'utf8');
      rawCache.set(name, text);
      return text;
    } catch {
      continue;
    }
  }

  throw new PromptError(`Prompt file "${name}.md" not found`, { name, tried });
}

/** Сбрасывает кеш файлов. Нужен тестам и hot-reload, в проде не вызывается. */
export function clearPromptCache(): void {
  rawCache.clear();
}

/**
 * Подстановка `{{var}}`. Чистая функция — вся логика проверок тестируется без диска.
 *
 * @throws {PromptError} если в шаблоне остались незаполненные плейсхолдеры или
 *   переданы переменные, которых в шаблоне нет (обычно это опечатка в имени).
 */
export function renderTemplate(template: string, vars: PromptVars = {}): string {
  const used = new Set<string>();
  const missing = new Set<string>();

  const text = template.replace(PLACEHOLDER, (match, rawKey: string) => {
    const key = rawKey.trim();
    const value = vars[key];
    if (value === undefined) {
      missing.add(key);
      return match;
    }
    used.add(key);
    return String(value);
  });

  if (missing.size > 0) {
    throw new PromptError(`Unsubstituted placeholders: ${[...missing].join(', ')}`, {
      missing: [...missing],
    });
  }

  const unused = Object.keys(vars).filter((key) => !used.has(key));
  if (unused.length > 0) {
    throw new PromptError(`Variables not present in template: ${unused.join(', ')}`, { unused });
  }

  return text;
}

/** Заголовок с версией. Отдельная функция, чтобы тесты сверяли формат, а не строку. */
export function promptHeader(name: PromptName, version: string): string {
  return `<!-- prompt: ${name}@${version} -->`;
}

/**
 * Читает промпт с диска и подставляет переменные.
 *
 * @param name - имя файла в `src/ai/prompts` без расширения
 * @param vars - значения плейсхолдеров `{{var}}`; набор обязан совпасть с шаблоном
 * @throws {PromptError} неизвестное имя, отсутствующий файл, расхождение переменных
 */
export function loadPrompt(name: PromptName, vars: PromptVars = {}): LoadedPrompt {
  const version = PROMPT_VERSION[name];
  if (version === undefined) {
    throw new PromptError(`Unknown prompt "${name}"`, {
      name,
      known: Object.keys(PROMPT_VERSION),
    });
  }

  const body = renderTemplate(readPromptFile(name), vars);
  return { name, version, text: `${promptHeader(name, version)}\n${body}` };
}
