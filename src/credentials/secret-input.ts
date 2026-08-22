import type { Readable } from 'node:stream';

import { AppError } from '@/lib/errors.js';

/**
 * Имя переменной окружения — альтернативный вход для автоматики.
 * В `.env` ей не место: это разовый носитель секрета на один запуск команды,
 * а не настройка приложения.
 */
export const SECRET_ENV_VAR = 'ADS_CREDENTIAL_PAYLOAD';

/** Потолок ввода: секрет длиной в мегабайт — это ошибка вызова, а не секрет. */
export const MAX_SECRET_BYTES = 64 * 1024;

export type SecretStdin = Readable & { isTTY?: boolean };

export interface SecretSource {
  kind: 'env' | 'stdin';
  value: string;
}

export interface ReadSecretDeps {
  env?: NodeJS.ProcessEnv;
  stdin?: SecretStdin;
}

/**
 * Читает секрет клиента из stdin или из переменной окружения.
 *
 * Почему не аргумент командной строки. `argv` виден в `ps` любому пользователю
 * машины, оседает в истории shell и попадает в вывод отладки при падении
 * процесса. Токен рекламного кабинета — это доступ к чужому бюджету, поэтому
 * такой путь закрыт: команда не имеет опции для значения секрета вовсе.
 *
 * Почему stdin — основной путь. Труба не видна в `ps`, не пишется в историю и
 * умирает вместе с процессом. Ввод с терминала при этом запрещён отдельно: там
 * набранное остаётся в скролле и в буфере эмулятора, то есть «интерактивный
 * ввод» был бы той же утечкой, только менее очевидной.
 *
 * Почему переменная окружения всё-таки есть. Окружение процесса читается
 * только тем же пользователем (`/proc/<pid>/environ`), то есть заметно лучше
 * argv, и это единственный практичный способ передать секрет из systemd,
 * `docker run --env-file` или секрет-менеджера CI, где трубы нет. Переменная
 * старше stdin: если она задана, ввод не читается вовсе.
 */
export async function readSecret(deps: ReadSecretDeps = {}): Promise<SecretSource> {
  const env = deps.env ?? process.env;
  const fromEnv = env[SECRET_ENV_VAR];

  if (fromEnv !== undefined) {
    const value = fromEnv.trim();
    if (value === '') {
      throw new AppError(
        `Переменная ${SECRET_ENV_VAR} задана, но пуста. Это почти всегда сорвавшаяся ` +
          'подстановка; переход на stdin в таком случае молча записал бы не тот секрет.',
        { code: 'CREDENTIAL_INPUT_EMPTY' },
      );
    }
    return { kind: 'env', value };
  }

  const stdin = deps.stdin ?? (process.stdin as SecretStdin);
  if (stdin.isTTY === true) {
    throw new AppError(
      'Секрет не читается с терминала: набранное останется в скролле и в буфере ' +
        `эмулятора. Передайте его трубой или через ${SECRET_ENV_VAR}.`,
      { code: 'CREDENTIAL_INPUT_TTY' },
    );
  }

  const chunks: string[] = [];
  let size = 0;
  for await (const chunk of stdin as AsyncIterable<string | Buffer>) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    size += Buffer.byteLength(text, 'utf8');
    if (size > MAX_SECRET_BYTES) {
      throw new AppError(`Ввод больше ${MAX_SECRET_BYTES} байт — это не секрет кабинета.`, {
        code: 'CREDENTIAL_INPUT_TOO_LARGE',
      });
    }
    chunks.push(text);
  }

  const value = chunks.join('').trim();
  if (value === '') {
    throw new AppError(
      'Ввод пуст. Секрет передаётся трубой: `... | pnpm cli credentials set --client <id> ' +
        '--provider yandex_direct --apply`.',
      { code: 'CREDENTIAL_INPUT_EMPTY' },
    );
  }
  return { kind: 'stdin', value };
}
