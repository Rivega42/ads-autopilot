import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { E2E_DATABASE_URL, E2E_ENCRYPTION_KEY } from './config.js';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

export interface CliResult {
  stdout: string;
  stderr: string;
  /** Весь вывод: команда пишет объяснения в stdout, отказы — в stderr. */
  output: string;
  code: number;
}

/**
 * Запуск CLI настоящим процессом.
 *
 * Импортом нельзя: `src/apps/cli.ts` — точка входа, он вызывает `main()` прямо
 * на импорте. Подмен здесь нет вовсе (msw живёт в другом процессе), поэтому так
 * проверяются только пути, которые никуда не ходят: без `--apply` команда читает
 * базу и печатает.
 */
export async function runCli(
  args: readonly string[],
  envOver: Record<string, string> = {},
): Promise<CliResult> {
  const env = {
    ...process.env,
    DATABASE_URL: E2E_DATABASE_URL,
    CREDENTIALS_ENCRYPTION_KEY: E2E_ENCRYPTION_KEY,
    DRY_RUN: 'true',
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    ...envOver,
  };

  try {
    const { stdout, stderr } = await run('node_modules/.bin/tsx', ['src/apps/cli.ts', ...args], {
      cwd: repoRoot,
      env,
    });
    return { stdout, stderr, output: `${stdout}\n${stderr}`, code: 0 };
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string; code?: number };
    const stdout = failure.stdout ?? '';
    const stderr = failure.stderr ?? '';
    return { stdout, stderr, output: `${stdout}\n${stderr}`, code: failure.code ?? 1 };
  }
}
