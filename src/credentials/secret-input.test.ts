import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { SECRET_ENV_VAR, readSecret, type SecretStdin } from './secret-input.js';

const TOKEN = 'y0__xCq1234567890abcdef';

function stdin(chunks: string[], isTTY = false): SecretStdin {
  return Object.assign(Readable.from(chunks), { isTTY });
}

describe('readSecret', () => {
  it('читает stdin и срезает перевод строки, который добавит любой пайп', async () => {
    const got = await readSecret({ env: {}, stdin: stdin([`${TOKEN}\n`]) });
    expect(got).toEqual({ kind: 'stdin', value: TOKEN });
  });

  it('склеивает stdin по кускам: длинный JSON приходит не одним чанком', async () => {
    const got = await readSecret({ env: {}, stdin: stdin(['{"accessToken":"', TOKEN, '"}']) });
    expect(got.value).toBe(`{"accessToken":"${TOKEN}"}`);
  });

  it('берёт переменную окружения, не трогая stdin', async () => {
    const untouched = stdin(['stdin-не-должен-читаться']);
    const got = await readSecret({ env: { [SECRET_ENV_VAR]: TOKEN }, stdin: untouched });
    expect(got).toEqual({ kind: 'env', value: TOKEN });
    expect(untouched.readableEnded).toBe(false);
  });

  it('отказывается читать секрет с терминала: набранное останется в скролле', async () => {
    await expect(readSecret({ env: {}, stdin: stdin([TOKEN], true) })).rejects.toThrow(/терминал/i);
  });

  it('пустой ввод — отказ, иначе в базу уедет пустой секрет', async () => {
    await expect(readSecret({ env: {}, stdin: stdin(['   \n']) })).rejects.toThrow(/пуст/i);
  });

  it('заданная, но пустая переменная — отказ, а не тихий переход на stdin', async () => {
    await expect(
      readSecret({ env: { [SECRET_ENV_VAR]: '  ' }, stdin: stdin([TOKEN]) }),
    ).rejects.toThrow(SECRET_ENV_VAR);
  });

  it('в тексте отказа секрета нет', async () => {
    const err = await readSecret({ env: {}, stdin: stdin([TOKEN], true) }).catch((e: unknown) => e);
    expect(String(err)).not.toContain(TOKEN);
  });
});
